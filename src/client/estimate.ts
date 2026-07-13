/**
 * Estimate - currency + amount only. No payee, no side effects, no expiry,
 * idempotent, cacheable. "≈ at whatever the oracle says when a buyer fills."
 *
 * Reads the same Chainlink feed the protocol prices the deposit against, so
 * there is no external FX dependency. USD is a zero-address passthrough
 * (USDC ≈ USD). The binding rate resolves on-chain at fill time.
 */
import type { Address, PublicClient } from 'viem';
import type { Zkp2pClient } from '@zkp2p/sdk';
import { CHAINLINK_ORACLE_FEEDS } from '@zkp2p/sdk';
import type { CurrencyType } from '../sdk-types';
import { USDC_DECIMALS } from '../engine/constants';
import { isMarketRateSupported } from '../engine/marketRate';
import { errors } from './errors';
import { MIN_CASHOUT_AMOUNT } from './capabilities';
import { readFillEta, type CashFillEta } from './fillEta';
import type { CashAsset, RelayOptions, RelayQuote, RelaySourceInput } from './relay';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const CHAINLINK_LATEST_ROUND_ABI = [
  {
    name: 'latestRoundData',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const;

export interface EstimateInput {
  /**
   * Without `source`, Base USDC base units. With `source`, Relay interprets
   * this according to `tradeType`; default `EXACT_INPUT` uses source-token units.
   */
  amount: bigint;
  /** Target fiat currency. */
  currency: CurrencyType;
  /** Optional payout platform for platform-specific fill ETA sampling. */
  platform?: string;
  /** Optional Relay EVM source asset. Omit for the current Base USDC default path. */
  source?: RelaySourceInput & {
    /** Source wallet that will submit Relay's origin transaction. Required by Relay quote. */
    user: string;
    /** Base recipient for bridged USDC; defaults to `user`. */
    recipient?: string;
    /** Relay amount mode. Omit for the recommended exact source-input estimate. */
    tradeType?: 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'EXPECTED_OUTPUT';
  };
}

/**
 * Chainlink feeds should update at least daily; a reading older than this is
 * flagged `stale` so a consumer can warn rather than quote a frozen rate. The
 * on-chain fill enforces the deposit's own `maxStaleness` regardless - this is
 * a display-side signal only.
 */
const DEFAULT_MAX_STALENESS_SECONDS = 86_400;

export interface CashEstimate {
  /** Always `'oracle-estimate'` - there is no committed quote in Peer Cash. */
  kind: 'oracle-estimate';
  currency: CurrencyType;
  /** Base USDC amount that Peer Cash would deposit after any source routing. */
  amount: bigint;
  /** Target-currency units per 1 USDC at the time of the read. */
  rate: number;
  /** `amount × rate` in target-currency units. */
  receiveAmount: number;
  /** Unix seconds when the oracle was read. */
  asOf: number;
  /** Unix seconds the Chainlink feed last updated (absent for the USD passthrough). */
  oracleUpdatedAt?: number;
  /** True when the feed reading is older than a day - treat the rate with caution. */
  stale?: boolean;
  /** Optional source asset route. Absent means same-chain Base USDC. */
  source?: {
    kind: 'relay';
    asset: CashAsset;
    inputAmount: bigint;
    relayQuote: RelayQuote;
  };
  /** Simple recent-fill ETA from indexer history. */
  eta?: CashFillEta;
}

export async function readEstimate(
  publicClient: PublicClient,
  input: EstimateInput,
  context: {
    indexerClient?: Zkp2pClient;
    environment?: Parameters<typeof readFillEta>[1]['environment'];
    relay?: RelayOptions;
  } = {},
): Promise<CashEstimate> {
  const { currency } = input;
  if (!isMarketRateSupported(currency)) {
    throw errors.oracleUnsupportedCurrency(currency);
  }

  let relayQuote: RelayQuote | undefined;
  if (input.source !== undefined) {
    // The Relay SDK performs discovery during initialization in browser
    // environments. Keep the entire adapter outside the Base-USDC path so
    // ordinary estimates have no Relay network or bundle dependency.
    const { quoteRelayToBaseUsdc } = await import('./relay');
    relayQuote = await quoteRelayToBaseUsdc(
      {
        user: input.source.user,
        amount: input.amount,
        source: { chainId: input.source.chainId, currency: input.source.currency },
        ...(input.source.recipient ? { recipient: input.source.recipient } : {}),
        ...(input.source.tradeType ? { tradeType: input.source.tradeType } : {}),
      },
      context.relay,
    );
  }

  const amount = relayQuote?.outputAmount ?? input.amount;
  if (amount < MIN_CASHOUT_AMOUNT) {
    throw errors.amountBelowMinimum(amount, MIN_CASHOUT_AMOUNT);
  }

  const feedConfig = CHAINLINK_ORACLE_FEEDS[currency];
  const asOf = Math.floor(Date.now() / 1000);

  let rate: number;
  let oracleUpdatedAt: number | undefined;
  if (!feedConfig || feedConfig.feed.toLowerCase() === ZERO_ADDRESS) {
    // USD passthrough - USDC ≈ USD.
    rate = 1;
  } else {
    let result: readonly [bigint, bigint, bigint, bigint, bigint];
    try {
      result = (await publicClient.readContract({
        address: feedConfig.feed as Address,
        abi: CHAINLINK_LATEST_ROUND_ABI,
        functionName: 'latestRoundData',
      })) as readonly [bigint, bigint, bigint, bigint, bigint];
    } catch (err) {
      throw errors.oracleReadFailed(currency, err);
    }

    const answer = Number(result[1]);
    const price = answer / 10 ** feedConfig.decimals;
    if (!Number.isFinite(price) || price <= 0) {
      throw errors.oracleUnsupportedCurrency(currency);
    }
    const updatedAt = Number(result[3]);
    if (Number.isFinite(updatedAt) && updatedAt > 0) oracleUpdatedAt = updatedAt;
    // invert: feed is CCY/USD (USD per CCY) → target per USDC = 1/price.
    // else:   feed is USD/CCY (CCY per USD) → target per USDC = price.
    rate = feedConfig.invert ? 1 / price : price;
  }

  const stale =
    oracleUpdatedAt !== undefined && asOf - oracleUpdatedAt > DEFAULT_MAX_STALENESS_SECONDS;

  const estimate: CashEstimate = {
    kind: 'oracle-estimate',
    currency,
    amount,
    rate,
    receiveAmount: (Number(amount) / 10 ** USDC_DECIMALS) * rate,
    asOf,
    ...(oracleUpdatedAt !== undefined ? { oracleUpdatedAt } : {}),
    ...(stale ? { stale: true } : {}),
    ...(relayQuote
      ? {
          source: {
            kind: 'relay',
            asset: relayQuote.source,
            inputAmount: relayQuote.inputAmount,
            relayQuote,
          },
        }
      : {}),
  };

  if (context.indexerClient && context.environment) {
    try {
      estimate.eta = await readFillEta(context.indexerClient, {
        environment: context.environment,
        currency,
        ...(input.platform ? { platform: input.platform } : {}),
      });
    } catch {
      // ETA is historical garnish; the oracle estimate remains usable without it.
    }
  }

  return estimate;
}
