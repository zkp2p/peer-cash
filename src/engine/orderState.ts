/**
 * Peer Cash — pure order-state derivation.
 *
 * The indexer's Deposit entity has NO `amount` field; the real numbers live in
 * `remainingDeposits`, `outstandingIntentAmount`, `totalAmountTaken`,
 * `totalWithdrawn` plus intent counts and `status`. We derive both the order's
 * size (original = remaining + outstanding + taken + withdrawn) and its
 * signal-backed state from those aggregates, using the fetched intents (when
 * present) for buyer/fill detail. Every state maps to a real on-chain signal.
 */
import type { IntentEntity, IntentStatus } from '../sdk-types';
import { USDC_DECIMALS } from './constants';
import type { CashFill, CashNextAction, CashOrder, CashOrderState } from './types';

/** Below this (USDC base units) a leftover balance is treated as dust, not "available". */
const DUST_THRESHOLD = 10_000n; // $0.01

interface IntentLike {
  intentHash: string;
  status: IntentStatus;
  amount?: string | number | bigint | null;
  owner?: string | null;
  fiatCurrency?: string | null;
  signalTimestamp?: string | number | null;
  expiryTime?: string | number | null;
  fulfillTimestamp?: string | number | null;
  prunedTimestamp?: string | number | null;
  pruneTimestamp?: string | number | null;
}

function toBigInt(value: unknown): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  try {
    return BigInt(typeof value === 'number' ? Math.trunc(value) : String(value));
  } catch {
    return 0n;
  }
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
  return {
    intentHash: intent.intentHash,
    status: intent.status,
    amount: toBigInt(intent.amount),
    buyer: (intent.owner ?? '').toLowerCase(),
    ...(intent.fiatCurrency != null ? { fiatCurrency: intent.fiatCurrency } : {}),
    ...(signaledAt !== undefined ? { signaledAt } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(fulfilledAt !== undefined ? { fulfilledAt } : {}),
    ...(prunedAt !== undefined ? { prunedAt } : {}),
  };
}

export interface DeriveCashOrderOptions {
  /** Original deposit amount, when already computed (else derived from the parts below). */
  totalAmount?: bigint;
  /** `remainingDeposits` — currently available, unlocked balance. */
  remainingAmount?: bigint;
  /** `outstandingIntentAmount` — currently locked by an active (SIGNALED) intent. */
  outstandingAmount?: bigint;
  /** `totalAmountTaken` — cumulative amount delivered to buyers (cashed out). */
  takenAmount?: bigint;
  /** `totalWithdrawn` — cumulative amount returned to the maker. */
  withdrawnAmount?: bigint;
  /** Deposit status: `ACTIVE` | `WITHDRAWN` | `CLOSED`. */
  status?: string;
  /** Total intent count from the indexer aggregate. */
  intentCount?: number;
  /** Unix seconds of the deposit's last on-chain change. */
  updatedAt?: number;
  /** Unix seconds "now" for expiry-sensitive `nextActions` (defaults to wall clock). */
  nowSeconds?: number;
}

/** Format USDC base units as a human dollar string for `explain()`. */
function fmtUsdc(amount: bigint): string {
  const whole = amount / 10n ** BigInt(USDC_DECIMALS);
  const frac = amount % 10n ** BigInt(USDC_DECIMALS);
  const cents = (frac / 10_000n).toString().padStart(2, '0');
  return `${whole}.${cents} USDC`;
}

/** Plain-data view of {@link CashOrder} (everything except the `explain` method). */
export type CashOrderData = Omit<CashOrder, 'explain'>;

/**
 * One honest sentence from live data — never a fake countdown. The binding
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
 * SIGNALED intent locks the funds — `withdraw()` prunes expired intents first
 * when needed, so an order whose only active intents have expired is
 * withdrawable again.
 */
function deriveNextActions(
  state: CashOrderState,
  fills: CashFill[],
  nowSeconds: number,
): CashNextAction[] {
  if (state === 'delivered' || state === 'returned') return [];
  if (state === 'awaiting-buyer') return ['wait', 'withdraw'];

  // matched | delivering — funds are locked while a signaled intent is live.
  const signaled = fills.filter((f) => f.status === 'SIGNALED');
  const anyLive = signaled.some((f) => f.expiresAt === undefined || f.expiresAt > nowSeconds);
  return anyLive ? ['wait'] : ['wait', 'withdraw'];
}

/**
 * Derive the resumable {@link CashOrder} view for one deposit. Pure and
 * deterministic — safe on every poll, list render, or cold page load.
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
  const isTerminal = status === 'WITHDRAWN' || status === 'CLOSED';
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

  return withExplain({
    depositId,
    state,
    fills,
    totalAmount: total,
    filledAmount: taken,
    pendingAmount: outstanding,
    returnedAmount: withdrawn,
    nextActions: deriveNextActions(state, fills, nowSeconds),
    ...(primary?.intentHash !== undefined ? { primaryIntentHash: primary.intentHash } : {}),
    ...(matchedAt !== undefined ? { matchedAt } : {}),
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
    ...(options.updatedAt !== undefined ? { updatedAt: options.updatedAt } : {}),
    intentCount: options.intentCount ?? fills.length,
    isInFlight,
    withdrawn: isTerminal,
  });
}
