/**
 * Estimate — currency + amount only. No payee, no side effects, no expiry,
 * idempotent, cacheable. "≈ at whatever the oracle says when a buyer fills."
 *
 * Reads the same Chainlink feed the protocol prices the deposit against, so
 * there is no external FX dependency. USD is a zero-address passthrough
 * (USDC ≈ USD). The binding rate resolves on-chain at fill time.
 */
import type { Address, PublicClient } from 'viem';
import { CHAINLINK_ORACLE_FEEDS } from '@zkp2p/sdk';
import type { CurrencyType } from '../sdk-types';
import { USDC_DECIMALS } from '../engine/constants';
import { isMarketRateSupported } from '../engine/marketRate';
import { errors } from './errors';
import { MIN_CASHOUT_AMOUNT } from './capabilities';

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
  /** Amount to cash out, USDC base units (6 decimals). Use `usdc()` to build it. */
  amount: bigint;
  /** Target fiat currency. */
  currency: CurrencyType;
}

/**
 * Chainlink feeds should update at least daily; a reading older than this is
 * flagged `stale` so a consumer can warn rather than quote a frozen rate. The
 * on-chain fill enforces the deposit's own `maxStaleness` regardless — this is
 * a display-side signal only.
 */
const DEFAULT_MAX_STALENESS_SECONDS = 86_400;

export interface CashEstimate {
  /** Always `'oracle-estimate'` — there is no committed quote in Peer Cash. */
  kind: 'oracle-estimate';
  currency: CurrencyType;
  /** The input amount, USDC base units. */
  amount: bigint;
  /** Target-currency units per 1 USDC at the time of the read. */
  rate: number;
  /** `amount × rate` in target-currency units. */
  receiveAmount: number;
  /** Unix seconds when the oracle was read. */
  asOf: number;
  /** Unix seconds the Chainlink feed last updated (absent for the USD passthrough). */
  oracleUpdatedAt?: number;
  /** True when the feed reading is older than a day — treat the rate with caution. */
  stale?: boolean;
}

export async function readEstimate(
  publicClient: PublicClient,
  input: EstimateInput,
): Promise<CashEstimate> {
  const { amount, currency } = input;
  if (amount < MIN_CASHOUT_AMOUNT) {
    throw errors.amountBelowMinimum(amount, MIN_CASHOUT_AMOUNT);
  }
  if (!isMarketRateSupported(currency)) {
    throw errors.oracleUnsupportedCurrency(currency);
  }

  const feedConfig = CHAINLINK_ORACLE_FEEDS[currency];
  const asOf = Math.floor(Date.now() / 1000);

  let rate: number;
  let oracleUpdatedAt: number | undefined;
  if (!feedConfig || feedConfig.feed.toLowerCase() === ZERO_ADDRESS) {
    // USD passthrough — USDC ≈ USD.
    rate = 1;
  } else {
    const result = (await publicClient.readContract({
      address: feedConfig.feed as Address,
      abi: CHAINLINK_LATEST_ROUND_ABI,
      functionName: 'latestRoundData',
    })) as readonly [bigint, bigint, bigint, bigint, bigint];

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

  return {
    kind: 'oracle-estimate',
    currency,
    amount,
    rate,
    receiveAmount: (Number(amount) / 10 ** USDC_DECIMALS) * rate,
    asOf,
    ...(oracleUpdatedAt !== undefined ? { oracleUpdatedAt } : {}),
    ...(stale ? { stale: true } : {}),
  };
}
