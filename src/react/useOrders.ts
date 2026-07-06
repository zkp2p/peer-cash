import { useCallback, useEffect, useRef, useState } from 'react';
import { CASH_ORDER_POLL_INTERVAL_MS } from '../engine/constants';
import type { CashOrder } from '../engine/types';
import type { CashClient } from '../client/createCashClient';

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
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchOrders = useCallback(async (): Promise<CashOrder[]> => {
    if (!client || !owner) return [];
    setIsLoading(true);
    setError(null);
    try {
      const derived = await client.orders(owner, { limit });
      if (mountedRef.current) setOrders(derived);
      return derived;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (mountedRef.current) setError(e);
      return [];
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [client, owner, limit]);

  useEffect(() => {
    mountedRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!client || !owner || paused) {
      return () => {
        mountedRef.current = false;
        if (timerRef.current) clearTimeout(timerRef.current);
      };
    }

    let cancelled = false;
    const tick = async () => {
      const result = await fetchOrders();
      if (cancelled || !mountedRef.current) return;
      if (result.some((o) => o.isInFlight)) {
        timerRef.current = setTimeout(tick, pollIntervalMs);
      }
    };
    void tick();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [client, owner, paused, pollIntervalMs, fetchOrders]);

  const inFlightCount = orders.filter((o) => o.isInFlight).length;
  /** Lifetime cashed-out total (USDC base units) across the feed. */
  const totalCashedOut = orders.reduce((sum, o) => sum + o.filledAmount, 0n);

  return { orders, inFlightCount, totalCashedOut, isLoading, error, refresh: fetchOrders };
}
