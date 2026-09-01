import type { CashPayoutInfo } from '../engine/types';

/** Whether indexed payout evidence belongs to the opinionated Cash product. */
export function isCashPayoutSet(
  payouts: readonly CashPayoutInfo[],
  attributedToCash = false,
): boolean {
  // Oracle-priced rows retain the historical structural fallback. A fixed
  // Alipay/CNY row is accepted only with the indexed peer-cash marker so an
  // Advanced Sell deposit cannot be misclassified as a Cash order.
  return (
    payouts.length > 0 &&
    payouts.every(
      (payout) =>
        (payout.pricing.marketRate && payout.pricing.spreadBps === 0) ||
        (attributedToCash &&
          payout.platform === 'alipay' &&
          payout.currency === 'CNY' &&
          payout.pricing.fixedAtCreation === true &&
          (payout.pricing.fixedRate ?? 0) > 0),
    )
  );
}
