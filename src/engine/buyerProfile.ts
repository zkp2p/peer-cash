/**
 * Peer Cash - buyer reputation, derived purely from the buyer's own intent
 * history. The anxious moment in a cash-out is `matched`: a stranger's
 * address is holding your order. This turns that address into a track record.
 */
import type { IntentEntity } from '../sdk-types';
import type { CashBuyerProfile } from './types';

interface BuyerIntentLike {
  status?: string | null;
  signalTimestamp?: string | number | null;
}

function toSeconds(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Aggregate a buyer's full intent history into a profile. Pure and deterministic. */
export function deriveBuyerProfile(
  address: string,
  intents: ReadonlyArray<IntentEntity>,
): CashBuyerProfile {
  let fulfilled = 0;
  let pruned = 0;
  let signaled = 0;
  let firstSeenAt: number | undefined;
  let lastSeenAt: number | undefined;

  for (const intent of intents as ReadonlyArray<BuyerIntentLike>) {
    const status = intent.status ?? '';
    if (status === 'FULFILLED' || status === 'MANUALLY_RELEASED') fulfilled += 1;
    else if (status === 'PRUNED') pruned += 1;
    else if (status === 'SIGNALED') signaled += 1;

    const at = toSeconds(intent.signalTimestamp);
    if (at !== undefined) {
      if (firstSeenAt === undefined || at < firstSeenAt) firstSeenAt = at;
      if (lastSeenAt === undefined || at > lastSeenAt) lastSeenAt = at;
    }
  }

  const settled = fulfilled + pruned;

  return {
    address: address.toLowerCase(),
    totalIntents: intents.length,
    fulfilled,
    pruned,
    signaled,
    ...(settled > 0 ? { successRateBps: Math.round((fulfilled / settled) * 10_000) } : {}),
    ...(firstSeenAt !== undefined ? { firstSeenAt } : {}),
    ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
  };
}
