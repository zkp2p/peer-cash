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

/** One buyer's intent against the deposit (one "fill"). The order id is the `intentHash`. */
export interface CashFill {
  /** The order id once a buyer has signaled. */
  intentHash: string;
  status: IntentStatus;
  /** Intent amount in USDC base units (6 decimals). */
  amount: bigint;
  /** The buyer (taker) address. */
  buyer: string;
  /** Fiat currency code the buyer is paying in. */
  fiatCurrency?: string;
  /** Unix seconds — when the buyer signaled (matched). */
  signaledAt?: number;
  /** Unix seconds — when the signaled intent expires and becomes prunable. */
  expiresAt?: number;
  /** Unix seconds — when fiat was proven and escrow released (delivered). */
  fulfilledAt?: number;
  /** Unix seconds — when the intent expired and was pruned (returned). */
  prunedAt?: number;
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
  /** True while the order still needs the user's attention / a buyer to act. */
  isInFlight: boolean;
  /** Whether the deposit has been withdrawn on-chain (terminal return). */
  withdrawn?: boolean;
  /** One honest sentence from live data — never a fake countdown. */
  explain(): string;
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
