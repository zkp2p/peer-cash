import { getPaymentMethodsCatalog } from '@zkp2p/sdk';
import type { Zkp2pClient } from '@zkp2p/sdk';
import { BASE_CHAIN_ID } from '../engine/constants';
import { derivePayouts } from '../engine/payouts';
import type { CurrencyType, RuntimeEnv } from '../sdk-types';

const ETA_WINDOW_DAYS = 7;
const ETA_WINDOW_SECONDS = ETA_WINDOW_DAYS * 24 * 60 * 60;
const ETA_SAMPLE_LIMIT = 250;

const FULFILLED = new Set(['FULFILLED', 'MANUALLY_RELEASED']);

export interface CashFillEta {
  /** Simple headline ETA from recent deposits. Undefined when no recent sample exists. */
  seconds?: number;
  /** Display-ready copy. Historical, not a guarantee. */
  label: string;
}

interface IntentLike {
  status?: string | null;
  amount?: string | number | bigint | null;
  fulfillTimestamp?: string | number | null;
}

interface DepositLike {
  id?: string | null;
  createdAt?: string | number | Date | null;
  timestamp?: string | number | null;
  remainingDeposits?: string | number | bigint | null;
  outstandingIntentAmount?: string | number | bigint | null;
  totalAmountTaken?: string | number | bigint | null;
  totalWithdrawn?: string | number | bigint | null;
  paymentMethods?: unknown[];
  currencies?: unknown[];
  intents?: IntentLike[];
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
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
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

function matchesPayout(
  deposit: DepositLike,
  environment: RuntimeEnv,
  platform?: string,
  currency?: string,
) {
  const payouts = derivePayouts(
    (deposit.paymentMethods ?? []) as never,
    (deposit.currencies ?? []) as never,
    getPaymentMethodsCatalog(BASE_CHAIN_ID, environment),
  );
  return payouts.some(
    (payout) =>
      payout.pricing.marketRate &&
      payout.pricing.spreadBps === 0 &&
      (platform === undefined || payout.platform === platform) &&
      (currency === undefined || payout.currency === currency),
  );
}

export async function readFillEta(
  client: Zkp2pClient,
  input: { environment: RuntimeEnv; platform?: string; currency: CurrencyType },
): Promise<CashFillEta> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - ETA_WINDOW_SECONDS;
  const deposits = (await client.indexer.getDepositsWithRelations(
    { chainId: BASE_CHAIN_ID },
    { limit: ETA_SAMPLE_LIMIT, orderBy: 'updatedAt', orderDirection: 'desc' },
    { includeIntents: true, intentStatuses: ['FULFILLED', 'MANUALLY_RELEASED'] },
  )) as DepositLike[];

  const firstFillLatencies: number[] = [];
  for (const deposit of deposits) {
    const createdAt = toUnixSeconds(deposit.createdAt ?? deposit.timestamp);
    if (createdAt === undefined || createdAt < windowStart) continue;
    if (!matchesPayout(deposit, input.environment, input.platform, input.currency)) continue;

    const fulfilled = (deposit.intents ?? [])
      .filter((intent) => intent.status != null && FULFILLED.has(intent.status))
      .map((intent) => ({
        fulfilledAt: toUnixSeconds(intent.fulfillTimestamp),
      }))
      .filter(
        (intent): intent is { fulfilledAt: number } =>
          intent.fulfilledAt !== undefined && intent.fulfilledAt >= createdAt,
      )
      .sort((a, b) => a.fulfilledAt - b.fulfilledAt);

    if (fulfilled.length === 0) continue;
    firstFillLatencies.push(fulfilled[0]!.fulfilledAt - createdAt);
  }

  const seconds = median(firstFillLatencies);

  return {
    ...(seconds !== undefined ? { seconds } : {}),
    label: etaLabel(seconds),
  };
}
