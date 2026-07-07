import { useCallback, useState } from 'react';
import { CASH_ORDER_POLL_INTERVAL_MS } from '../engine/constants';
import type { CashOrder } from '../engine/types';
import type { CashClient } from '../client/createCashClient';
import { isCashError } from '../client/errors';
import { usePoll } from './usePoll';
import { useMountedRef } from './useMountedRef';

export interface UseOrderOptions {
  client: CashClient | null;
  /** Composite deposit id (`escrow_onchainId`). The resumable anchor. */
  depositId: string | null | undefined;
  /** Poll cadence while the order is in flight (ms). */
  pollIntervalMs?: number;
  /** Disable automatic polling (manual `refresh()` only). */
  paused?: boolean;
}

/**
 * Observe a cash-out order's lifecycle, keyed by `depositId`.
 *
 * Fully resumable: the order is reconstructed from on-chain data on every load,
 * so it survives a closed tab, a new device, or a wallet reconnect. Polls while
 * the order is in flight and stops once it reaches a terminal state.
 * `ORDER_NOT_FOUND` right after creation is indexer lag — polling continues.
 */
export function useOrder({
  client,
  depositId,
  pollIntervalMs = CASH_ORDER_POLL_INTERVAL_MS,
  paused = false,
}: UseOrderOptions) {
  const [order, setOrder] = useState<CashOrder | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mounted = useMountedRef();

  const fetchOrder = useCallback(
    async (isActive: () => boolean = () => true): Promise<CashOrder | null> => {
      if (!client || !depositId) return null;
      setIsLoading(true);
      setError(null);
      try {
        const derived = await client.order(depositId);
        if (isActive()) setOrder(derived);
        return derived;
      } catch (err) {
        if (isCashError(err) && err.code === 'ORDER_NOT_FOUND') {
          // Indexer lag right after creation — not an error, keep polling.
          return null;
        }
        const e = err instanceof Error ? err : new Error(String(err));
        if (isActive()) setError(e);
        return null;
      } finally {
        if (isActive()) setIsLoading(false);
      }
    },
    [client, depositId],
  );

  usePoll(
    Boolean(client && depositId && !paused),
    pollIntervalMs,
    useCallback(
      async (isActive: () => boolean) => {
        const result = await fetchOrder(isActive);
        // Keep polling while in flight (or while state is still unknown).
        return !result || result.isInFlight;
      },
      [fetchOrder],
    ),
  );

  const refresh = useCallback(() => fetchOrder(() => mounted.current), [fetchOrder, mounted]);

  return { order, isLoading, error, refresh };
}
