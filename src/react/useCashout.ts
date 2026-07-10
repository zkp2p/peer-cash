import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WalletClient } from 'viem';
import type {
  CashClient,
  CashoutOptions,
  CashoutInput,
  CashoutResult,
  TopUpResult,
  WithdrawResult,
} from '../client/createCashClient';
import { useMountedRef } from './useMountedRef';

type PendingMutation = 'cashout' | 'withdraw' | 'topUp';

interface CashoutIdentity {
  client: CashClient | null;
  signer: WalletClient | null | undefined;
  sourceSigner: WalletClient | null | undefined;
}

interface ActiveMutation extends CashoutIdentity {
  kind: PendingMutation;
}

function matchesIdentity(
  identity: CashoutIdentity | null,
  client: CashClient | null,
  signer: WalletClient | null | undefined,
  sourceSigner: WalletClient | null | undefined,
): boolean {
  return (
    identity?.client === client &&
    identity.signer === signer &&
    identity.sourceSigner === sourceSigner
  );
}

function notifyObserver<T>(observer: ((value: T) => void) | undefined, value: T): void {
  try {
    observer?.(value);
  } catch {
    // Consumer callbacks are observers. They must never change the outcome of
    // a submitted money operation or turn a successful transaction into an error.
  }
}

export interface UseCashoutOptions {
  client: CashClient | null;
  /** A viem WalletClient with an account, on Base. */
  signer: WalletClient | null | undefined;
  /** Source-chain signer for Relay source routing. Required when the source chain is not Base. */
  sourceSigner?: WalletClient | null | undefined;
  onSourceProgress?: CashoutOptions['onSourceProgress'];
  onCashout?: (result: CashoutResult) => void;
  onError?: (error: Error) => void;
}

/**
 * Orchestrate a cash-out end to end on the maker side:
 * - `cashout(input)` → create the market-rate deposit, resolve its composite id.
 * - `topUp(depositId, amount)` → add USDC to a live order.
 * - `withdraw(depositId, amount?)` → the ONE unwind verb; partial with an
 *   amount, full close without. The caller never chooses between
 *   cancel/recover - expired intents are pruned automatically.
 */
export function useCashout({
  client,
  signer,
  sourceSigner,
  onSourceProgress,
  onCashout,
  onError,
}: UseCashoutOptions) {
  const [pending, setPending] = useState<PendingMutation | null>(null);
  const pendingRef = useRef<ActiveMutation | null>(null);
  const [result, setResult] = useState<CashoutResult | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const resultIdentityRef = useRef<CashoutIdentity | null>(null);
  const errorIdentityRef = useRef<CashoutIdentity | null>(null);
  const mounted = useMountedRef();

  useEffect(() => {
    pendingRef.current = null;
    resultIdentityRef.current = null;
    errorIdentityRef.current = null;
    setPending(null);
    setResult(null);
    setError(null);
  }, [client, signer, sourceSigner]);

  const cashout = useCallback(
    async (input: CashoutInput): Promise<CashoutResult | null> => {
      const identity: CashoutIdentity = { client, signer, sourceSigner };
      if (!client || !signer) {
        const err = new Error('Cash client or signer is not ready');
        if (mounted.current) {
          errorIdentityRef.current = identity;
          setError(err);
        }
        notifyObserver(onError, err);
        return null;
      }
      if (matchesIdentity(pendingRef.current, client, signer, sourceSigner)) return null;
      const active: ActiveMutation = { ...identity, kind: 'cashout' };
      pendingRef.current = active;
      setPending('cashout');
      setError(null);
      setResult(null);
      try {
        const cashoutResult = await client.cashout(input, {
          signer,
          ...(sourceSigner ? { sourceSigner } : {}),
          ...(onSourceProgress ? { onSourceProgress } : {}),
        });
        if (mounted.current && pendingRef.current === active) {
          resultIdentityRef.current = identity;
          setResult(cashoutResult);
        }
        notifyObserver(onCashout, cashoutResult);
        return cashoutResult;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (mounted.current && pendingRef.current === active) {
          errorIdentityRef.current = identity;
          setError(e);
        }
        notifyObserver(onError, e);
        return null;
      } finally {
        if (mounted.current && pendingRef.current === active) {
          pendingRef.current = null;
          setPending(null);
        }
      }
    },
    [client, signer, sourceSigner, onSourceProgress, onCashout, onError],
  );

  const withdraw = useCallback(
    async (depositId: string, amount?: bigint): Promise<WithdrawResult | null> => {
      const identity: CashoutIdentity = { client, signer, sourceSigner };
      if (!client || !signer) {
        const err = new Error('Cash client or signer is not ready');
        if (mounted.current) {
          errorIdentityRef.current = identity;
          setError(err);
        }
        notifyObserver(onError, err);
        return null;
      }
      if (matchesIdentity(pendingRef.current, client, signer, sourceSigner)) return null;
      const active: ActiveMutation = { ...identity, kind: 'withdraw' };
      pendingRef.current = active;
      setPending('withdraw');
      setError(null);
      try {
        return await client.withdraw(depositId, {
          signer,
          ...(amount !== undefined ? { amount } : {}),
        });
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (mounted.current && pendingRef.current === active) {
          errorIdentityRef.current = identity;
          setError(e);
        }
        notifyObserver(onError, e);
        return null;
      } finally {
        if (mounted.current && pendingRef.current === active) {
          pendingRef.current = null;
          setPending(null);
        }
      }
    },
    [client, signer, sourceSigner, onError],
  );

  const topUp = useCallback(
    async (depositId: string, amount: bigint): Promise<TopUpResult | null> => {
      const identity: CashoutIdentity = { client, signer, sourceSigner };
      if (!client || !signer) {
        const err = new Error('Cash client or signer is not ready');
        if (mounted.current) {
          errorIdentityRef.current = identity;
          setError(err);
        }
        notifyObserver(onError, err);
        return null;
      }
      if (matchesIdentity(pendingRef.current, client, signer, sourceSigner)) return null;
      const active: ActiveMutation = { ...identity, kind: 'topUp' };
      pendingRef.current = active;
      setPending('topUp');
      setError(null);
      try {
        return await client.topUp(depositId, amount, { signer });
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (mounted.current && pendingRef.current === active) {
          errorIdentityRef.current = identity;
          setError(e);
        }
        notifyObserver(onError, e);
        return null;
      } finally {
        if (mounted.current && pendingRef.current === active) {
          pendingRef.current = null;
          setPending(null);
        }
      }
    },
    [client, signer, sourceSigner, onError],
  );

  const visiblePending = matchesIdentity(pendingRef.current, client, signer, sourceSigner)
    ? pending
    : null;
  const visibleResult = matchesIdentity(resultIdentityRef.current, client, signer, sourceSigner)
    ? result
    : null;
  const visibleError = matchesIdentity(errorIdentityRef.current, client, signer, sourceSigner)
    ? error
    : null;

  return useMemo(
    () => ({
      cashout,
      topUp,
      withdraw,
      pending: visiblePending,
      result: visibleResult,
      error: visibleError,
    }),
    [cashout, topUp, withdraw, visiblePending, visibleResult, visibleError],
  );
}
