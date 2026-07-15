import {
  getCurrencyCodeFromHash,
  getPaymentMethodsCatalog,
  resolvePaymentMethodNameFromHash,
  type Zkp2pClient,
} from '@zkp2p/sdk';
import { BASE_CHAIN_ID } from '../engine/constants';
import type { CurrencyType, RuntimeEnv } from '../sdk-types';
import { basePlatformForMethod } from './platformGroups';

export const FILL_STATS_WINDOW_SECONDS = 30 * 24 * 60 * 60;
const FILL_STATS_PAGE_LIMIT = 250;

export interface CashPairFillStats {
  /** Fulfilled intents through this pair inside the rolling 30-day window. */
  fills: number;
  /** Median deposit-to-first-fill seconds, sampled once per deposit for this pair. */
  medianFillSeconds?: number;
}

/** Raw demand and speed evidence keyed by `basePlatform:currencyCode`. */
export type CashFillStats = Record<string, CashPairFillStats>;

export interface CashFillEta {
  /** Simple headline ETA from recent deposits. Undefined when no recent sample exists. */
  seconds?: number;
  /** Display-ready copy. Historical, not a guarantee. */
  label: string;
}

interface IntentLike {
  paymentMethodHash?: string | null;
  fiatCurrency?: string | null;
  fulfillTimestamp?: string | number | Date | null;
}

export interface FillStatsDepositLike {
  createdAt?: string | number | Date | null;
  timestamp?: string | number | Date | null;
  updatedAt?: string | number | Date | null;
  intents?: IntentLike[] | null;
}

export interface FillStatsSample {
  stats: CashFillStats;
  medianFillSecondsByCurrency: Map<string, number>;
}

function toUnixSeconds(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (value instanceof Date) {
    const seconds = Math.floor(value.getTime() / 1000);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  }
  if (typeof value === 'string' && /[TZ:-]/.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function normalizeCurrencyCode(value: string | null | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (!raw.toLowerCase().startsWith('0x')) return raw.toUpperCase();
  try {
    return getCurrencyCodeFromHash(raw)?.toUpperCase();
  } catch {
    return undefined;
  }
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function etaLabel(seconds: number | undefined): string {
  if (seconds === undefined) return 'Recent fill time unavailable';
  if (seconds < 60) return 'Usually starts in under a minute';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `Usually starts in about ${minutes} min`;
  const hours = Math.max(1, Math.round(minutes / 60));
  return `Usually starts in about ${hours} hr`;
}

/**
 * Compute raw demand and speed evidence from already-fetched indexer deposits.
 * Fills are attributed only from each intent's own payment method and currency;
 * a deposit's advertised method set is deliberately ignored.
 */
function computeFillStatsSample(
  deposits: readonly FillStatsDepositLike[],
  nowSeconds: number,
  environment: RuntimeEnv,
): FillStatsSample {
  const catalog = getPaymentMethodsCatalog(BASE_CHAIN_ID, environment);
  const windowStart = nowSeconds - FILL_STATS_WINDOW_SECONDS;
  const fillCounts = new Map<string, number>();
  const latenciesByPair = new Map<string, number[]>();
  const latenciesByCurrency = new Map<string, number[]>();

  for (const deposit of deposits) {
    const createdAt = toUnixSeconds(deposit.createdAt ?? deposit.timestamp);
    const firstFillByPair = new Map<string, number>();
    const firstFillByCurrency = new Map<string, number>();

    for (const intent of deposit.intents ?? []) {
      const fulfilledAt = toUnixSeconds(intent.fulfillTimestamp);
      if (fulfilledAt === undefined || fulfilledAt < windowStart) continue;

      let method: string | undefined;
      try {
        method = intent.paymentMethodHash
          ? resolvePaymentMethodNameFromHash(intent.paymentMethodHash, catalog)
          : undefined;
      } catch {
        method = undefined;
      }
      const currency = normalizeCurrencyCode(intent.fiatCurrency);
      if (!method || !currency) continue;

      const pair = `${basePlatformForMethod(method)}:${currency}`;
      fillCounts.set(pair, (fillCounts.get(pair) ?? 0) + 1);

      if (createdAt === undefined || createdAt < windowStart || fulfilledAt < createdAt) continue;

      const previousPairFill = firstFillByPair.get(pair);
      if (previousPairFill === undefined || fulfilledAt < previousPairFill) {
        firstFillByPair.set(pair, fulfilledAt);
      }
      const previousCurrencyFill = firstFillByCurrency.get(currency);
      if (previousCurrencyFill === undefined || fulfilledAt < previousCurrencyFill) {
        firstFillByCurrency.set(currency, fulfilledAt);
      }
    }

    if (createdAt === undefined) continue;
    for (const [pair, firstFill] of firstFillByPair) {
      const latencies = latenciesByPair.get(pair) ?? [];
      latencies.push(firstFill - createdAt);
      latenciesByPair.set(pair, latencies);
    }
    for (const [currency, firstFill] of firstFillByCurrency) {
      const latencies = latenciesByCurrency.get(currency) ?? [];
      latencies.push(firstFill - createdAt);
      latenciesByCurrency.set(currency, latencies);
    }
  }

  const stats: CashFillStats = {};
  for (const [pair, fills] of fillCounts) {
    const medianFillSeconds = median(latenciesByPair.get(pair) ?? []);
    stats[pair] = {
      fills,
      ...(medianFillSeconds !== undefined ? { medianFillSeconds } : {}),
    };
  }

  const medianFillSecondsByCurrency = new Map<string, number>();
  for (const [currency, latencies] of latenciesByCurrency) {
    const value = median(latencies);
    if (value !== undefined) medianFillSecondsByCurrency.set(currency, value);
  }
  return { stats, medianFillSecondsByCurrency };
}

/** Pure convenience wrapper for consumers and focused unit tests. */
export function computeFillStats(
  deposits: readonly FillStatsDepositLike[],
  nowSeconds: number,
  environment: RuntimeEnv,
): CashFillStats {
  return computeFillStatsSample(deposits, nowSeconds, environment).stats;
}

export async function readFillStatsSample(
  client: Zkp2pClient,
  environment: RuntimeEnv,
): Promise<FillStatsSample> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - FILL_STATS_WINDOW_SECONDS;
  const deposits: FillStatsDepositLike[] = [];

  for (let offset = 0; ; offset += FILL_STATS_PAGE_LIMIT) {
    const page = (await client.indexer.getDepositsWithRelations(
      { chainId: BASE_CHAIN_ID },
      {
        limit: FILL_STATS_PAGE_LIMIT,
        offset,
        orderBy: 'updatedAt',
        orderDirection: 'desc',
      },
      { includeIntents: true, intentStatuses: ['FULFILLED', 'MANUALLY_RELEASED'] },
    )) as FillStatsDepositLike[];
    deposits.push(...page);

    if (page.length < FILL_STATS_PAGE_LIMIT) break;
    const oldestUpdatedAt = Math.min(
      ...page.map((deposit) => toUnixSeconds(deposit.updatedAt) ?? Infinity),
    );
    if (oldestUpdatedAt < windowStart) break;
  }

  return computeFillStatsSample(deposits, now, environment);
}

/** Resolve an ETA from one cached snapshot without crossing platform/currency pairs. */
export function fillEtaFromSample(
  sample: FillStatsSample,
  input: { environment: RuntimeEnv; platform?: string; currency: CurrencyType },
): CashFillEta {
  const currency = input.currency.toUpperCase();
  const seconds = input.platform
    ? sample.stats[`${basePlatformForMethod(input.platform)}:${currency}`]?.medianFillSeconds
    : sample.medianFillSecondsByCurrency.get(currency);
  return {
    ...(seconds !== undefined ? { seconds } : {}),
    label: etaLabel(seconds),
  };
}

/** Read raw 30-day demand and speed evidence for every observed payout pair. */
export async function readFillStats(
  client: Zkp2pClient,
  environment: RuntimeEnv,
): Promise<CashFillStats> {
  return (await readFillStatsSample(client, environment)).stats;
}

/** Build estimate ETA from the exact same intent-attributed sample as `fillStats()`. */
export async function readFillEta(
  client: Zkp2pClient,
  input: { environment: RuntimeEnv; platform?: string; currency: CurrencyType },
): Promise<CashFillEta> {
  const sample = await readFillStatsSample(client, input.environment);
  return fillEtaFromSample(sample, input);
}
