import type { CashPayoutInfo } from '../engine/types';
import { isCreationRateCorridor } from './creationRate';

/** Whether indexed payout evidence belongs to the opinionated Cash product. */
export function isCashPayoutSet(
  payouts: readonly CashPayoutInfo[],
  attributedToCash = false,
): boolean {
  // Oracle-priced rows retain the historical structural fallback. A fixed
  // creation-rate row is accepted only with the indexed peer-cash marker so an
  // Advanced Sell deposit cannot be misclassified as a Cash order.
  return (
    payouts.length > 0 &&
    payouts.every(
      (payout) =>
        (payout.pricing.marketRate && payout.pricing.spreadBps === 0) ||
        (attributedToCash &&
          isCreationRateCorridor(payout.platform, payout.currency ?? '') &&
          payout.pricing.fixedAtCreation === true &&
          (payout.pricing.fixedRate ?? 0) > 0),
    )
  );
}
