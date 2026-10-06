import { buildIntentAmountRange } from '../engine/marketRate';
import { MIN_CASHOUT_AMOUNT } from './capabilities';
import { errors } from './errors';

/** Fixed sizing is automatic; raw ranges belong to flexible mode only. */
export type CashFillOptions =
  | { fillMode: 'fixed'; intentAmountRange?: never }
  | { fillMode?: 'flexible'; intentAmountRange?: { min: bigint; max: bigint } };

const DEFAULT_FIXED_PLATFORMS = new Set(['venmo', 'paypal', 'cashapp']);
const USDC = 1_000_000n;
const FIXED_CHUNK_BY_TOTAL = new Map<bigint, bigint>();
for (let total = 50n; total <= 500n; total += 50n) {
  FIXED_CHUNK_BY_TOTAL.set(total * USDC, total * USDC);
}
for (const [total, chunk] of [
  [600n, 300n],
  [700n, 350n],
  [750n, 250n],
  [800n, 400n],
  [900n, 300n],
] as const) {
  FIXED_CHUNK_BY_TOTAL.set(total * USDC, chunk * USDC);
}
for (let total = 1_000n; total <= 10_000n; total += 500n) {
  FIXED_CHUNK_BY_TOTAL.set(total * USDC, 500n * USDC);
}

/** Validate once against the resolved Base-USDC principal, before mutation. */
export function resolveIntentAmountRange(
  amount: bigint,
  options: CashFillOptions,
  payouts: readonly { platform: string; currencies: readonly string[] }[],
): { min: bigint; max: bigint } {
  if (
    (options.fillMode !== undefined &&
      options.fillMode !== 'fixed' &&
      options.fillMode !== 'flexible') ||
    'intentAmount' in options ||
    (options.fillMode === 'fixed' && options.intentAmountRange !== undefined)
  ) {
    throw errors.invalidFillConfiguration();
  }
  const fixed =
    options.fillMode === 'fixed' ||
    (options.fillMode === undefined &&
      options.intentAmountRange === undefined &&
      payouts.length > 0 &&
      payouts.every(
        (payout) =>
          DEFAULT_FIXED_PLATFORMS.has(payout.platform) &&
          payout.currencies.length === 1 &&
          payout.currencies[0] === 'USD',
      ));
  if (fixed) {
    if (payouts.some((payout) => payout.currencies.some((currency) => currency !== 'USD'))) {
      throw errors.fixedCurrencyUnsupported();
    }
    const chunk = FIXED_CHUNK_BY_TOTAL.get(amount);
    if (chunk === undefined) {
      throw errors.fixedAmountNotPreset(amount, [...FIXED_CHUNK_BY_TOTAL.keys()]);
    }
    return { min: chunk, max: chunk };
  }
  if (amount < MIN_CASHOUT_AMOUNT) {
    throw errors.amountBelowMinimum(amount, MIN_CASHOUT_AMOUNT);
  }
  const range = options.intentAmountRange;
  if (range === undefined) return buildIntentAmountRange(amount);
  if (range.min <= 0n || range.max < range.min || range.max > amount) {
    throw errors.invalidIntentAmountRange(amount, range.min, range.max);
  }
  return range;
}
