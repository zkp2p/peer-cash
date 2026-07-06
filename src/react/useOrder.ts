import { useCallback, useEffect, useRef, useState } from 'react';
import { CASH_ORDER_POLL_INTERVAL_MS } from '../engine/constants';
import type { CashOrder } from '../engine/types';
import type { CashClient } from '../client/createCashClient';
import { isCashError } from '../client/errors';

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

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const fetchOrder = useCallback(async (): Promise<CashOrder | null> => {
    if (!client || !depositId) return null;
    setIsLoading(true);
    setError(null);
    try {
      const derived = await client.order(depositId);
      if (mountedRef.current) setOrder(derived);
      return derived;
    } catch (err) {
      if (isCashError(err) && err.code === 'ORDER_NOT_FOUND') {
        // Indexer lag right after creation — not an error, keep polling.
        return null;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      if (mountedRef.current) setError(e);
      return null;
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [client, depositId]);

  useEffect(() => {
    mountedRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!client || !depositId || paused) {
      return () => {
        mountedRef.current = false;
        if (timerRef.current) clearTimeout(timerRef.current);
      };
    }

    let cancelled = false;
    const tick = async () => {
      const result = await fetchOrder();
      if (cancelled || !mountedRef.current) return;
      // Keep polling only while in flight (or while state is still unknown).
      if (!result || result.isInFlight) {
        timerRef.current = setTimeout(tick, pollIntervalMs);
      }
    };
    void tick();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [client, depositId, paused, pollIntervalMs, fetchOrder]);

  return { order, isLoading, error, refresh: fetchOrder };
}
