/**
 * Peer Cash — public domain types for the engine.
 */
import type { Address } from 'viem';
import type { CurrencyType, CuratorPayeeDataInput, IntentStatus } from '../sdk-types';

/**
 * The lifecycle state of a cash-out, derived purely from on-chain-observable
 * intent events against the user's deposit.
 *
 * - `awaiting-buyer` — deposit is live, no buyer has signaled yet.
 * - `matched` — a buyer signaled an intent (`SIGNALED`); fiat not yet proven.
 * - `delivering` — partial fill in progress (some intents fulfilled, some still signaled).
 * - `delivered` — fiat paid + proven, escrow released (`FULFILLED`).
 * - `returned` — buyer didn't deliver; intent pruned, deposit recoverable/recovered.
 */
export type CashOrderState = 'awaiting-buyer' | 'matched' | 'delivering' | 'delivered' | 'returned';

/** What the caller can do next. The lifecycle is self-driving — no consumer heuristics. */
export type CashNextAction = 'wait' | 'withdraw';

/**
 * One buyer's intent against the deposit (one "fill"). The order id is the
 * `intentHash`. Hashes are decoded to human units wherever the protocol
 * catalogs know them; the raw values stay available for anything unknown.
 */
export interface CashFill {
  /** The order id once a buyer has signaled. */
  intentHash: string;
  status: IntentStatus;
  /** Intent amount in USDC base units (6 decimals). */
  amount: bigint;
  /** The buyer (taker) address. */
  buyer: string;
  /** Decoded fiat currency code the buyer pays in, e.g. `'EUR'`. */
  currency?: string;
  /** Raw on-chain currency hash (bytes32), for anything the catalog can't decode. */
  currencyHash?: string;
  /** Fiat per USDC locked at signal time — the binding rate for THIS fill. */
  rate?: number;
  /** Raw locked conversion rate (1e18 precision). */
  conversionRate?: bigint;
  /** Fiat the buyer must send: `amount × rate`, rounded up to the cent. */
  fiatOwed?: number;
  /** Verified receipt — actual fiat paid, from the payment proof. */
  fiatPaid?: number;
  /** Verified receipt — decoded currency actually paid (may differ from `currency`). */
  paidCurrency?: string;
  /** Verified receipt — the platform's external payment id. */
  paymentId?: string;
  /** Verified receipt — unix seconds the fiat payment was made. */
  paidAt?: number;
  /** USDC actually released from escrow for this fill (gross, base units). */
  releasedAmount?: bigint;
  /** Seconds from buyer signal to proven delivery. */
  fillLatencySeconds?: number;
  /** Indexer reconciler flag: the intent's window has lapsed on-chain. */
  isExpired?: boolean;
  /** Unix seconds — when the buyer signaled (matched). */
  signaledAt?: number;
  /** Unix seconds — when the signaled intent expires and becomes prunable. */
  expiresAt?: number;
  /** Unix seconds — when fiat was proven and escrow released (delivered). */
  fulfilledAt?: number;
  /** Unix seconds — when the intent expired and was pruned (returned). */
  prunedAt?: number;
}

/** Pricing state of one payout tuple — the zero-spread claim, verifiable from indexed data. */
export interface CashPayoutPricing {
  /** Depositor-configured spread markup in basis points (0 for every cash order). */
  spreadBps?: number;
  /** Oracle kind, e.g. `'oracle_chainlink'`. */
  kind?: string;
  /** Which source currently binds the rate: `ORACLE` | `MANAGER` | `ESCROW_FLOOR` | …. */
  rateSource?: string;
  /** Current oracle rate (fiat per USDC), decoded from 1e18. */
  oracleRate?: number;
  /** Unix seconds of the last accepted oracle snapshot. */
  lastOracleUpdatedAt?: number;
  /** True when the tuple is priced by an oracle at zero spread — the Peer Cash invariant. */
  marketRate: boolean;
}

/** One payout leg reconstructed from the chain — platform, currency, payee hash, pricing. */
export interface CashPayoutInfo {
  /** Decoded platform id, e.g. `'venmo'` (undefined if the catalog doesn't know the hash). */
  platform?: string;
  /** Raw payment method hash (bytes32). */
  platformHash: string;
  /** Decoded fiat currency code, e.g. `'USD'`. */
  currency?: string;
  /** Raw currency hash (bytes32). */
  currencyHash?: string;
  /** Hashed payee details (the handle itself never touches the chain). */
  payeeHash: string;
  /** Whether the method still accepts new intents. */
  active: boolean;
  pricing: CashPayoutPricing;
}

/**
 * The full, resumable view of a cash-out order, reconstructed from the indexer
 * by `depositId` alone — survives a closed tab, new device, or wallet reconnect.
 */
export interface CashOrder {
  /** Composite deposit id (`escrow_onchainId`) — the resume key. */
  depositId: string;
  state: CashOrderState;
  /** Every buyer intent against the deposit (>1 only for partial fills). */
  fills: CashFill[];
  /** Deposit amount in USDC base units. */
  totalAmount: bigint;
  /** Sum of fulfilled (delivered) intent amounts. */
  filledAmount: bigint;
  /** Sum of signaled-but-not-yet-fulfilled intent amounts. */
  pendingAmount: bigint;
  /** Sum returned (withdrawn) to the maker. */
  returnedAmount: bigint;
  /** Self-driving lifecycle — what the caller can do right now. */
  nextActions: CashNextAction[];
  /** The primary order id (first/active intent's `intentHash`) once matched. */
  primaryIntentHash?: string;
  /** Unix seconds — earliest signal (first match). */
  matchedAt?: number;
  /** Unix seconds — latest fulfilment (delivery). */
  deliveredAt?: number;
  /** Unix seconds — when the deposit last changed on-chain. */
  updatedAt?: number;
  /** Total number of buyer intents against the deposit (from the indexer aggregate). */
  intentCount?: number;
  /**
   * Payout legs reconstructed from the chain (platform, currency, payee hash,
   * pricing proof). Present on `order()`; absent on `orders()` list rows.
   */
  payouts?: CashPayoutInfo[];
  /** Deposit quality signal takers see (basis points, 0–10000; new deposits start at 10000). */
  successRateBps?: number;
  /** True while the order still needs the user's attention / a buyer to act. */
  isInFlight: boolean;
  /** Whether the deposit has been withdrawn on-chain (terminal return). */
  withdrawn?: boolean;
  /** One honest sentence from live data — never a fake countdown. */
  explain(): string;
}

/** A buyer's protocol track record, aggregated from their full intent history. */
export interface CashBuyerProfile {
  address: string;
  /** Lifetime intents this buyer has signaled (all statuses). */
  totalIntents: number;
  /** Intents completed: fiat paid, proven, escrow released. */
  fulfilled: number;
  /** Intents that expired unpaid and were pruned. */
  pruned: number;
  /** Intents currently open. */
  signaled: number;
  /** fulfilled / (fulfilled + pruned) in basis points; undefined until they have history. */
  successRateBps?: number;
  /** Unix seconds of the buyer's first and latest signal. */
  firstSeenAt?: number;
  lastSeenAt?: number;
}

/** A single payout leg of a cash-out (one platform + currency + payee). */
export interface CashPayout {
  /** Payment platform / processor name, e.g. `'venmo'`, `'revolut'`, `'wise'`. */
  processorName: string;
  /** Fiat currency the user wants to receive. */
  currency: CurrencyType;
  /** The user's payee handle for that platform (e.g. a Venmo username, Wisetag). */
  payeeData: CuratorPayeeDataInput;
}

/**
 * Input to create a market-rate (0% spread) cash-out deposit.
 *
 * Deliberately narrow: no rate/spread knobs, no vault/DRM delegate, no
 * retain-on-empty override — a cash-out is a one-shot order that cleans up
 * when fully filled. The API cannot express what Peer Cash does not offer.
 */
export interface CashDepositInput {
  /** Deposit asset — Base USDC (defaults to {@link BASE_USDC_ADDRESS}). */
  token?: Address;
  /** Total amount to cash out, in USDC base units (6 decimals). */
  amount: bigint;
  /** One or more payout legs (platform + currency + payee). */
  payouts: CashPayout[];
  /** Per-order min/max in USDC base units. Defaults derive from {@link buildIntentAmountRange}. */
  intentAmountRange?: { min: bigint; max: bigint };
}
