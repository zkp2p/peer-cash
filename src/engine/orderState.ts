/**
 * Peer Cash - pure order-state derivation.
 *
 * The indexer's Deposit entity has NO `amount` field; the real numbers live in
 * `remainingDeposits`, `outstandingIntentAmount`, `totalAmountTaken`,
 * `totalWithdrawn` plus intent counts and `status`. We derive both the order's
 * size (original = remaining + outstanding + taken + withdrawn) and its
 * signal-backed state from those aggregates, using the fetched intents (when
 * present) for buyer/fill detail. Every state maps to a real on-chain signal.
 */
import { getCurrencyCodeFromHash } from '@zkp2p/sdk';
import type { IntentEntity, IntentStatus } from '../sdk-types';
import { toBigInt, toBigIntOrUndefined } from '../internal/convert';
import { centsToNumber, fiatFromUsdc, fiatToNumber, formatUsdc, rateToNumber } from './amounts';
import type { CashFill, CashNextAction, CashOrder, CashOrderState, CashPayoutInfo } from './types';

/** Below this (USDC base units) a leftover balance is treated as dust, not "available". */
const DUST_THRESHOLD = 10_000n; // $0.01

interface IntentLike {
  intentHash: string;
  status: IntentStatus;
  amount?: string | number | bigint | null;
  owner?: string | null;
  fiatCurrency?: string | null;
  conversionRate?: string | number | bigint | null;
  isExpired?: boolean | null;
  paymentAmount?: string | number | bigint | null;
  paymentCurrency?: string | null;
  paymentTimestamp?: string | number | null;
  paymentId?: string | null;
  releasedAmount?: string | number | bigint | null;
  signalTimestamp?: string | number | null;
  expiryTime?: string | number | null;
  fulfillTimestamp?: string | number | null;
  prunedTimestamp?: string | number | null;
  pruneTimestamp?: string | number | null;
}

function toUnixSeconds(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const FULFILLED_STATUSES: ReadonlySet<IntentStatus> = new Set<IntentStatus>([
  'FULFILLED',
  'MANUALLY_RELEASED',
]);

function toFill(intent: IntentLike): CashFill {
  const signaledAt = toUnixSeconds(intent.signalTimestamp);
  const expiresAt = toUnixSeconds(intent.expiryTime);
  const fulfilledAt = toUnixSeconds(intent.fulfillTimestamp);
  const prunedAt = toUnixSeconds(intent.prunedTimestamp ?? intent.pruneTimestamp);
  const paidAt = toUnixSeconds(intent.paymentTimestamp);

  const amount = toBigInt(intent.amount);
  const conversionRate = toBigIntOrUndefined(intent.conversionRate);
  const currency =
    intent.fiatCurrency != null ? getCurrencyCodeFromHash(intent.fiatCurrency) : undefined;
  const paidCurrency =
    intent.paymentCurrency != null ? getCurrencyCodeFromHash(intent.paymentCurrency) : undefined;
  // Verified fiat paid arrives in cents from the payment proof.
  const paymentCents = toBigIntOrUndefined(intent.paymentAmount);
  const releasedAmount = toBigIntOrUndefined(intent.releasedAmount);
  const fillLatencySeconds =
    signaledAt !== undefined && fulfilledAt !== undefined && fulfilledAt >= signaledAt
      ? fulfilledAt - signaledAt
      : undefined;

  return {
    intentHash: intent.intentHash,
    status: intent.status,
    amount,
    buyer: (intent.owner ?? '').toLowerCase(),
    ...(currency !== undefined ? { currency } : {}),
    ...(intent.fiatCurrency != null ? { currencyHash: intent.fiatCurrency } : {}),
    ...(conversionRate !== undefined && conversionRate > 0n
      ? {
          conversionRate,
          rate: rateToNumber(conversionRate),
          fiatOwed: fiatToNumber(fiatFromUsdc(amount, conversionRate)),
        }
      : {}),
    ...(paymentCents !== undefined && paymentCents > 0n
      ? { fiatPaid: centsToNumber(paymentCents) }
      : {}),
    ...(paidCurrency !== undefined ? { paidCurrency } : {}),
    ...(intent.paymentId != null && intent.paymentId !== '' ? { paymentId: intent.paymentId } : {}),
    ...(paidAt !== undefined ? { paidAt } : {}),
    ...(releasedAmount !== undefined && releasedAmount > 0n ? { releasedAmount } : {}),
    ...(fillLatencySeconds !== undefined ? { fillLatencySeconds } : {}),
    ...(intent.isExpired != null ? { isExpired: intent.isExpired } : {}),
    ...(signaledAt !== undefined ? { signaledAt } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(fulfilledAt !== undefined ? { fulfilledAt } : {}),
    ...(prunedAt !== undefined ? { prunedAt } : {}),
  };
}

/**
 * Whether a signaled fill can still be completed by its buyer. Uses the
 * indexer's reconciler flag when present, belt-and-braces with the local
 * clock (the reconciler can lag; the clock can skew - either signal counts).
 */
export function isFillLive(fill: CashFill, nowSeconds: number): boolean {
  if (fill.status !== 'SIGNALED') return false;
  if (fill.isExpired === true) return false;
  return fill.expiresAt === undefined || fill.expiresAt > nowSeconds;
}

export interface DeriveCashOrderOptions {
  /** Original deposit amount, when already computed (else derived from the parts below). */
  totalAmount?: bigint;
  /** `remainingDeposits` - currently available, unlocked balance. */
  remainingAmount?: bigint;
  /** `outstandingIntentAmount` - currently locked by an active (SIGNALED) intent. */
  outstandingAmount?: bigint;
  /** `totalAmountTaken` - cumulative amount delivered to buyers (cashed out). */
  takenAmount?: bigint;
  /** `totalWithdrawn` - cumulative amount returned to the maker. */
  withdrawnAmount?: bigint;
  /** Deposit status from the indexer: `ACTIVE` | `CLOSED`. */
  status?: string;
  /** Total intent count from the indexer aggregate. */
  intentCount?: number;
  /** Unix seconds of the deposit's last on-chain change. */
  updatedAt?: number;
  /** Payout legs reconstructed from the deposit relations (see `derivePayouts`). */
  payouts?: CashPayoutInfo[];
  /** Deposit quality signal (basis points) from the indexer aggregate. */
  successRateBps?: number;
  /**
   * Whether per-fill intent detail is present. Defaults to `intents.length > 0`.
   * Pass `false` on list rows (deposits fetched without their intents) so
   * `nextActions` treats a positive outstanding amount as a live lock rather
   * than offering a withdraw that would revert.
   */
  fillsIncluded?: boolean;
  /** Unix seconds "now" for expiry-sensitive `nextActions` (defaults to wall clock). */
  nowSeconds?: number;
}

/** Human dollar string for `explain()` sentences. */
function fmtUsdc(amount: bigint): string {
  return `${formatUsdc(amount)} USDC`;
}

/** Plain-data view of {@link CashOrder} (everything except the `explain` method). */
export type CashOrderData = Omit<CashOrder, 'explain'>;

/**
 * One honest sentence from live data - never a fake countdown. The binding
 * rate resolves at the oracle when a buyer fills, and buyer arrival time is
 * unknowable, so the sentence only ever states what the chain actually shows.
 */
export function explainOrder(order: CashOrderData): string {
  switch (order.state) {
    case 'awaiting-buyer':
      return `Your ${fmtUsdc(order.totalAmount)} cash-out is live and waiting for a buyer; you can withdraw it any time before a buyer commits.`;
    case 'matched':
      return `A buyer committed to ${fmtUsdc(order.pendingAmount)} and is sending fiat now; funds release automatically once their payment is proven.`;
    case 'delivering':
      return `${fmtUsdc(order.filledAmount)} of ${fmtUsdc(order.totalAmount)} has been delivered; the rest is ${
        order.pendingAmount > 0n ? 'locked by an active buyer' : 'still waiting for a buyer'
      }.`;
    case 'delivered':
      return `Cash-out complete: ${fmtUsdc(order.filledAmount)} was delivered to ${
        order.fills.filter((f) => f.fulfilledAt !== undefined).length || 'your'
      } buyer fill(s).`;
    case 'returned':
      return order.filledAmount > 0n
        ? `${fmtUsdc(order.filledAmount)} was delivered and the remaining ${fmtUsdc(order.returnedAmount)} was returned to your wallet.`
        : `No buyer delivered; ${fmtUsdc(order.returnedAmount)} was returned to your wallet.`;
  }
}

/** Attach the `explain()` method to plain order data (used by codecs on parse). */
export function withExplain(data: CashOrderData): CashOrder {
  return { ...data, explain: () => explainOrder(data) };
}

/**
 * What the caller can do next. Withdrawal is legal while no live (unexpired)
 * SIGNALED intent locks the funds - `withdraw()` prunes expired intents first
 * when needed, so an order whose only active intents have expired is
 * withdrawable again.
 *
 * `hasLiveIntent` is resolved by the caller: from per-fill liveness when the
 * intents were fetched, or conservatively from the outstanding aggregate on a
 * list row where fills weren't loaded (assume live → do not tempt a withdraw
 * that would revert).
 */
function deriveNextActions(state: CashOrderState, hasLiveIntent: boolean): CashNextAction[] {
  if (state === 'delivered' || state === 'returned') return [];
  if (state === 'awaiting-buyer') return ['wait', 'withdraw'];
  // matched | delivering - funds are locked while a signaled intent is live.
  return hasLiveIntent ? ['wait'] : ['wait', 'withdraw'];
}

/**
 * Derive the resumable {@link CashOrder} view for one deposit. Pure and
 * deterministic - safe on every poll, list render, or cold page load.
 */
export function deriveCashOrder(
  depositId: string,
  intents: ReadonlyArray<IntentEntity>,
  options: DeriveCashOrderOptions = {},
): CashOrder {
  const fills = (intents as ReadonlyArray<IntentLike>).map(toFill);

  // Prefer indexer aggregates; fall back to summing the fetched intents.
  const taken =
    options.takenAmount ??
    fills.filter((f) => FULFILLED_STATUSES.has(f.status)).reduce((a, f) => a + f.amount, 0n);
  const outstanding =
    options.outstandingAmount ??
    fills.filter((f) => f.status === 'SIGNALED').reduce((a, f) => a + f.amount, 0n);
  const withdrawn = options.withdrawnAmount ?? 0n;
  const remaining = options.remainingAmount ?? 0n;

  const total = options.totalAmount ?? remaining + outstanding + taken + withdrawn;

  const status = options.status;
  // The indexer's DepositStatus is ACTIVE | CLOSED; a fully-withdrawn deposit
  // is CLOSED (never a 'WITHDRAWN' status - that value exists only on the
  // fund-activity log). 'WITHDRAWN' is tolerated here purely for forward-compat.
  const isTerminal = status === 'CLOSED' || status === 'WITHDRAWN';
  const hasLiveFunds = remaining > DUST_THRESHOLD || outstanding > 0n;

  let state: CashOrderState;
  if (outstanding > 0n) {
    // A buyer is signaled right now (funds locked, mid-delivery).
    state = taken > 0n ? 'delivering' : 'matched';
  } else if (taken > 0n && !hasLiveFunds) {
    state = 'delivered';
  } else if (taken > 0n && hasLiveFunds) {
    state = 'delivering';
  } else if (!hasLiveFunds && (withdrawn > 0n || isTerminal)) {
    state = 'returned';
  } else if (hasLiveFunds) {
    state = 'awaiting-buyer';
  } else {
    state = taken > 0n ? 'delivered' : 'returned';
  }

  let matchedAt: number | undefined;
  let deliveredAt: number | undefined;
  for (const fill of fills) {
    if (fill.signaledAt && (!matchedAt || fill.signaledAt < matchedAt)) matchedAt = fill.signaledAt;
    if (FULFILLED_STATUSES.has(fill.status) && fill.fulfilledAt) {
      if (!deliveredAt || fill.fulfilledAt > deliveredAt) deliveredAt = fill.fulfilledAt;
    }
  }

  const primary =
    fills.find((f) => f.status === 'SIGNALED') ??
    fills.find((f) => FULFILLED_STATUSES.has(f.status)) ??
    fills[0];

  const isInFlight = state === 'awaiting-buyer' || state === 'matched' || state === 'delivering';
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  // Was fill-level intent detail available? Explicitly signalled by the caller,
  // else inferred from whether any intents were passed. When absent (list rows),
  // a positive `outstanding` is assumed to be a live lock - the conservative,
  // money-safe default for `nextActions`.
  const fillsIncluded = options.fillsIncluded ?? fills.length > 0;
  const hasLiveIntent = fillsIncluded
    ? fills.some((f) => isFillLive(f, nowSeconds))
    : outstanding > 0n;

  return withExplain({
    depositId,
    state,
    fills,
    totalAmount: total,
    filledAmount: taken,
    pendingAmount: outstanding,
    returnedAmount: withdrawn,
    nextActions: deriveNextActions(state, hasLiveIntent),
    ...(primary?.intentHash !== undefined ? { primaryIntentHash: primary.intentHash } : {}),
    ...(matchedAt !== undefined ? { matchedAt } : {}),
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
    ...(options.updatedAt !== undefined ? { updatedAt: options.updatedAt } : {}),
    intentCount: options.intentCount ?? fills.length,
    ...(options.payouts !== undefined ? { payouts: options.payouts } : {}),
    ...(options.successRateBps !== undefined ? { successRateBps: options.successRateBps } : {}),
    isInFlight,
    withdrawn: isTerminal,
  });
}
