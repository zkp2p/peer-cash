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
import type { Hex } from 'viem';
import type { IntentStatus, RuntimeEnv } from '../sdk-types';

/** Base chain id - Peer Cash settles in Base USDC. */
export const BASE_CHAIN_ID = 8453;

/** Canonical USDC on Base (6 decimals). The deposit asset for every cash-out. */
export const BASE_USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;

/** Paid intent guardian attached to every Peer Cash deposit. */
export const CASH_INTENT_GUARDIAN_ADDRESS = '0x83671606454fA72ba1e2831E18C5090D25629414' as const;

/** Chargeback-exposed payout rails that require restricted deposit access. */
export const CASH_RESTRICTED_PLATFORMS = new Set(['venmo', 'cashapp', 'paypal']);

/**
 * Canonical Plus, Pro, Peer Makers, and Peer Pay groups for each contract
 * environment. Preproduction uses the production Base contracts; staging has
 * its own registry and cohorts.
 */
export const CASH_ACCESS_GROUP_IDS: Record<RuntimeEnv, readonly Hex[]> = {
  production: [
    '0xb8747401b308d4891385620071b5916e9c61284f25c4611541c529703de5babf',
    '0xf030f72e772f954059ca28f94974088aaf6ba37bb1f264df48843a3d0c221dc3',
    '0xdf1c64c54745aa1ce00642a5874f97e3183bf5e993c1f559d0a37a4df0b803c7',
    '0x174b8a29536721a3eae290bfd55651b85a53fc334b971d993fa93ed8dde15e48',
  ],
  preproduction: [
    '0xb8747401b308d4891385620071b5916e9c61284f25c4611541c529703de5babf',
    '0xf030f72e772f954059ca28f94974088aaf6ba37bb1f264df48843a3d0c221dc3',
    '0xdf1c64c54745aa1ce00642a5874f97e3183bf5e993c1f559d0a37a4df0b803c7',
    '0x174b8a29536721a3eae290bfd55651b85a53fc334b971d993fa93ed8dde15e48',
  ],
  staging: [
    '0xf6133c227eab8ae7da1ee143945bf7f31204394f3ba801dc9691f8af6ca8efa5',
    '0xa6beb459bc621e7b050e431736c1c3298da26356d7095719185e859d68f70d9e',
    '0x9cded1332f25c3ee0a9a822a4c827d3fbd081a8d7b2ba39c49917ec1983b8d6c',
    '0xc82c20c00033046a2f017b65532d7148a337282f17c73296663a530e49ba00f7',
  ],
};

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
