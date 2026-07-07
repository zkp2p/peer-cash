import { useCallback, useMemo, useState } from 'react';
import type { WalletClient } from 'viem';
import type {
  CashClient,
  CashoutInput,
  CashoutResult,
  TopUpResult,
  WithdrawResult,
} from '../client/createCashClient';

export interface UseCashoutOptions {
  client: CashClient | null;
  /** A viem WalletClient with an account, on Base. */
  signer: WalletClient | null | undefined;
  onCashout?: (result: CashoutResult) => void;
  onError?: (error: Error) => void;
}

/**
 * Orchestrate a cash-out end to end on the maker side:
 * - `cashout(input)` → create the market-rate deposit, resolve its composite id.
 * - `topUp(depositId, amount)` → add USDC to a live order.
 * - `withdraw(depositId, amount?)` → the ONE unwind verb; partial with an
 *   amount, full close without. The caller never chooses between
 *   cancel/recover — expired intents are pruned automatically.
 */
export function useCashout({ client, signer, onCashout, onError }: UseCashoutOptions) {
  const [pending, setPending] = useState<null | 'cashout' | 'withdraw' | 'topUp'>(null);
  const [result, setResult] = useState<CashoutResult | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const cashout = useCallback(
    async (input: CashoutInput): Promise<CashoutResult | null> => {
      if (!client || !signer) {
        const err = new Error('Cash client or signer is not ready');
        setError(err);
        onError?.(err);
        return null;
      }
      setPending('cashout');
      setError(null);
      setResult(null);
      try {
        const cashoutResult = await client.cashout(input, { signer });
        setResult(cashoutResult);
        onCashout?.(cashoutResult);
        return cashoutResult;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        onError?.(e);
        return null;
      } finally {
        setPending(null);
      }
    },
    [client, signer, onCashout, onError],
  );

  const withdraw = useCallback(
    async (depositId: string, amount?: bigint): Promise<WithdrawResult | null> => {
      if (!client || !signer) {
        const err = new Error('Cash client or signer is not ready');
        setError(err);
        onError?.(err);
        return null;
      }
      setPending('withdraw');
      setError(null);
      try {
        return await client.withdraw(depositId, {
          signer,
          ...(amount !== undefined ? { amount } : {}),
        });
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        onError?.(e);
        return null;
      } finally {
        setPending(null);
      }
    },
    [client, signer, onError],
  );

  const topUp = useCallback(
    async (depositId: string, amount: bigint): Promise<TopUpResult | null> => {
      if (!client || !signer) {
        const err = new Error('Cash client or signer is not ready');
        setError(err);
        onError?.(err);
        return null;
      }
      setPending('topUp');
      setError(null);
      try {
        return await client.topUp(depositId, amount, { signer });
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        onError?.(e);
        return null;
      } finally {
        setPending(null);
      }
    },
    [client, signer, onError],
  );

  return useMemo(
    () => ({ cashout, topUp, withdraw, pending, result, error }),
    [cashout, topUp, withdraw, pending, result, error],
  );
}
