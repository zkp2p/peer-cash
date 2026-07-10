import { useCallback, useEffect, useRef, useState } from 'react';
import { CASH_ORDER_POLL_INTERVAL_MS } from '../engine/constants';
import type { CashOrder } from '../engine/types';
import type { CashClient } from '../client/createCashClient';
import { usePoll } from './usePoll';
import { useMountedRef } from './useMountedRef';

interface OrdersIdentity {
  client: CashClient;
  owner: string;
  limit: number;
}

export interface UseOrdersOptions {
  client: CashClient | null;
  /** The connected user's address (the maker / depositor). */
  owner: string | null | undefined;
  /** Max deposits to scan. */
  limit?: number;
  /** Poll cadence (ms) while the feed is enabled. */
  pollIntervalMs?: number;
  paused?: boolean;
}

/**
 * List the user's cash-out orders (the Transactions-feed pattern). Reads
 * deposits by depositor and derives real amounts + states from the indexer
 * aggregates. Polls while enabled so an empty or terminal feed can still
 * discover a newly indexed cash-out without a remount.
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
  const latestRequest = useRef(0);
  const ordersIdentity = useRef<OrdersIdentity | null>(null);
  const loadingIdentity = useRef<OrdersIdentity | null>(null);
  const errorIdentity = useRef<OrdersIdentity | null>(null);

  useEffect(() => {
    latestRequest.current += 1;
    ordersIdentity.current = null;
    loadingIdentity.current = null;
    errorIdentity.current = null;
    setOrders([]);
    setIsLoading(false);
    setError(null);
  }, [client, owner, limit]);

  const fetchOrders = useCallback(
    async (isActive: () => boolean = () => true): Promise<CashOrder[]> => {
      if (!client || !owner) return [];
      const requestId = ++latestRequest.current;
      const identity: OrdersIdentity = { client, owner, limit };
      const isCurrent = () => mounted.current && isActive() && requestId === latestRequest.current;
      if (isCurrent()) {
        loadingIdentity.current = identity;
        errorIdentity.current = null;
        setIsLoading(true);
        setError(null);
      }
      try {
        const derived = await client.orders(owner, { limit });
        if (!isCurrent()) return [];
        ordersIdentity.current = identity;
        setOrders(derived);
        return derived;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (isCurrent()) {
          errorIdentity.current = identity;
          setError(e);
        }
        return [];
      } finally {
        if (isCurrent()) setIsLoading(false);
      }
    },
    [client, owner, limit, mounted],
  );

  usePoll(
    Boolean(client && owner && !paused),
    pollIntervalMs,
    useCallback(
      async (isActive: () => boolean) => {
        await fetchOrders(isActive);
        return true;
      },
      [fetchOrders],
    ),
  );

  const refresh = useCallback(() => fetchOrders(() => mounted.current), [fetchOrders, mounted]);

  const matchesCurrentIdentity = (identity: OrdersIdentity | null) =>
    identity?.client === client && identity.owner === owner && identity.limit === limit;
  const visibleOrders = matchesCurrentIdentity(ordersIdentity.current) ? orders : [];

  const inFlightCount = visibleOrders.filter((o) => o.isInFlight).length;
  /** Lifetime cashed-out total (USDC base units) across the feed. */
  const totalCashedOut = visibleOrders.reduce((sum, o) => sum + o.filledAmount, 0n);

  return {
    orders: visibleOrders,
    inFlightCount,
    totalCashedOut,
    isLoading: matchesCurrentIdentity(loadingIdentity.current) ? isLoading : false,
    error: matchesCurrentIdentity(errorIdentity.current) ? error : null,
    refresh,
  };
}
