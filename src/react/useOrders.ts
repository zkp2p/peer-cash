import { useCallback, useState } from 'react';
import { CASH_ORDER_POLL_INTERVAL_MS } from '../engine/constants';
import type { CashOrder } from '../engine/types';
import type { CashClient } from '../client/createCashClient';
import { usePoll } from './usePoll';
import { useMountedRef } from './useMountedRef';

export interface UseOrdersOptions {
  client: CashClient | null;
  /** The connected user's address (the maker / depositor). */
  owner: string | null | undefined;
  /** Max deposits to scan. */
  limit?: number;
  /** Poll cadence (ms) while any order is in flight. */
  pollIntervalMs?: number;
  paused?: boolean;
}

/**
 * List the user's cash-out orders (the Transactions-feed pattern). Reads
 * deposits by depositor and derives real amounts + states from the indexer
 * aggregates. Polls while any order is in flight.
 */
export function useOrders({
  client,
  owner,
  limit = 100,
  pollIntervalMs = CASH_ORDER_POLL_INTERVAL_MS,
  paused = false,
}: UseOrdersOptions) {
  const [orders, setOrders] = useState<CashOrder[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mounted = useMountedRef();

  const fetchOrders = useCallback(
    async (isActive: () => boolean = () => true): Promise<CashOrder[]> => {
      if (!client || !owner) return [];
      setIsLoading(true);
      setError(null);
      try {
        const derived = await client.orders(owner, { limit });
        if (isActive()) setOrders(derived);
        return derived;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (isActive()) setError(e);
        return [];
      } finally {
        if (isActive()) setIsLoading(false);
      }
    },
    [client, owner, limit],
  );

  usePoll(
    Boolean(client && owner && !paused),
    pollIntervalMs,
    useCallback(
      async (isActive: () => boolean) => {
        const result = await fetchOrders(isActive);
        return result.some((o) => o.isInFlight);
      },
      [fetchOrders],
    ),
  );

  const refresh = useCallback(() => fetchOrders(() => mounted.current), [fetchOrders, mounted]);

  const inFlightCount = orders.filter((o) => o.isInFlight).length;
  /** Lifetime cashed-out total (USDC base units) across the feed. */
  const totalCashedOut = orders.reduce((sum, o) => sum + o.filledAmount, 0n);

  return { orders, inFlightCount, totalCashedOut, isLoading, error, refresh };
}
