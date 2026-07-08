/**
 * Peer Cash - engine constants.
 *
 * Peer Cash is an async crypto→fiat offramp built on the maker/deposit side of
 * the protocol: the cashing-out user IS the maker. They create a deposit at the
 * live oracle/market rate (0% spread); a buyer (a standard taker) signals an
 * intent, pays fiat, and proves it via the standard TEE-TLS flow, releasing the
 * user's crypto. The protocol is reused in its existing direction - no proof
 * inversion, no sell-side quote.
 */
import type { IntentStatus } from '../sdk-types';

/** Base chain id - Peer Cash settles in Base USDC. */
export const BASE_CHAIN_ID = 8453;

/** Canonical USDC on Base (6 decimals). The deposit asset for every cash-out. */
export const BASE_USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;

/** USDC has 6 decimals. */
export const USDC_DECIMALS = 6;

/**
 * Market rate = the live Chainlink oracle with **zero spread**. The user sets no
 * rate; selling at market is the fast-fill incentive (the deposit is the best
 * deal on the book, so buyers have reason to take it quickly).
 */
export const MARKET_SPREAD_BPS = 0;

/**
 * EscrowV2 rejects a zero `minConversionRate` even when an oracle-backed rate
 * config is attached. Use the smallest non-zero sentinel so the oracle rate
 * still fully determines pricing while satisfying the on-chain invariant.
 */
export const ORACLE_MIN_CONVERSION_RATE_SENTINEL = 1n;

/**
 * The full intent-status set a cash-out order can pass through. The indexer's
 * `getIntentsForDeposits` defaults to `['SIGNALED']` only - passing this
 * explicit set is REQUIRED, otherwise `delivered`/`returned` states are
 * silently filtered out.
 */
export const CASH_ORDER_STATUSES: IntentStatus[] = [
  'SIGNALED',
  'FULFILLED',
  'PRUNED',
  'MANUALLY_RELEASED',
];

/** Default polling cadence for an in-flight order (ms). Matches the protocol's active-intent polling. */
export const CASH_ORDER_POLL_INTERVAL_MS = 5_000;

/**
 * Default deposit config for every Peer Cash deposit: a one-shot cash-out
 * cleans up when fully filled rather than lingering empty.
 */
export const CASH_RETAIN_ON_EMPTY = false;
