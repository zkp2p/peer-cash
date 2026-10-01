import type { CashPayoutInfo } from '../engine/types';

/** Whether indexed payout evidence belongs to the opinionated Cash product. */
export function isCashPayoutSet(
  payouts: readonly CashPayoutInfo[],
  attributedToCash = false,
): boolean {
  // All new Cash orders use zero-spread oracles, including INR/CNY. Preserve
  // recovery of historical fixed-rate Cash orders only with attribution and
  // the exact old corridor; this does not enable new fixed-rate deposits.
  return (
    payouts.length > 0 &&
    payouts.every(
      (payout) =>
        (payout.pricing.marketRate && payout.pricing.spreadBps === 0) ||
        (attributedToCash &&
          ((payout.platform.toLowerCase() === 'alipay' &&
            payout.currency?.toUpperCase() === 'CNY') ||
            (payout.platform.toLowerCase() === 'upi' &&
              payout.currency?.toUpperCase() === 'INR')) &&
          payout.pricing.fixedAtCreation === true &&
          (payout.pricing.fixedRate ?? 0) > 0),
    )
  );
}
