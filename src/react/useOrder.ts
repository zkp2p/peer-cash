import { useCallback, useEffect, useRef, useState } from 'react';
import { CASH_ORDER_POLL_INTERVAL_MS } from '../engine/constants';
import type { CashOrder } from '../engine/types';
import type { CashClient } from '../client/createCashClient';
import { isCashError } from '../client/errors';
import { usePoll } from './usePoll';
import { useMountedRef } from './useMountedRef';

interface OrderIdentity {
  client: CashClient;
  depositId: string;
}

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
 * `ORDER_NOT_FOUND` right after creation is indexer lag - polling continues.
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
  const latestRequest = useRef(0);
  const orderIdentity = useRef<OrderIdentity | null>(null);
  const loadingIdentity = useRef<OrderIdentity | null>(null);
  const errorIdentity = useRef<OrderIdentity | null>(null);

  useEffect(() => {
    latestRequest.current += 1;
    orderIdentity.current = null;
    loadingIdentity.current = null;
    errorIdentity.current = null;
    setOrder(null);
    setIsLoading(false);
    setError(null);
  }, [client, depositId]);

  const fetchOrder = useCallback(
    async (isActive: () => boolean = () => true): Promise<CashOrder | null> => {
      if (!client || !depositId) return null;
      const requestId = ++latestRequest.current;
      const identity: OrderIdentity = { client, depositId };
      const isCurrent = () => mounted.current && isActive() && requestId === latestRequest.current;
      if (isCurrent()) {
        loadingIdentity.current = identity;
        errorIdentity.current = null;
        setIsLoading(true);
        setError(null);
      }
      try {
        const derived = await client.order(depositId);
        if (!isCurrent()) return null;
        orderIdentity.current = identity;
        setOrder(derived);
        return derived;
      } catch (err) {
        if (isCashError(err) && err.code === 'ORDER_NOT_FOUND') {
          // Indexer lag right after creation - not an error, keep polling.
          return null;
        }
        const e = err instanceof Error ? err : new Error(String(err));
        if (isCurrent()) {
          errorIdentity.current = identity;
          setError(e);
        }
        return null;
      } finally {
        if (isCurrent()) setIsLoading(false);
      }
    },
    [client, depositId, mounted],
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

  const matchesCurrentIdentity = (identity: OrderIdentity | null) =>
    identity?.client === client && identity.depositId === depositId;

  return {
    order: matchesCurrentIdentity(orderIdentity.current) ? order : null,
    isLoading: matchesCurrentIdentity(loadingIdentity.current) ? isLoading : false,
    error: matchesCurrentIdentity(errorIdentity.current) ? error : null,
    refresh,
  };
}
