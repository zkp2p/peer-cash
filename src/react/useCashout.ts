import { useCallback, useMemo, useState } from 'react';
import type { WalletClient } from 'viem';
import type {
  CashClient,
  CashoutInput,
  CashoutResult,
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
 * - `withdraw(depositId)` → the ONE unwind verb; prunes expired intents first
 *   when needed. The caller never chooses between cancel/recover.
 */
export function useCashout({ client, signer, onCashout, onError }: UseCashoutOptions) {
  const [pending, setPending] = useState<null | 'cashout' | 'withdraw'>(null);
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
    async (depositId: string): Promise<WithdrawResult | null> => {
      if (!client || !signer) {
        const err = new Error('Cash client or signer is not ready');
        setError(err);
        onError?.(err);
        return null;
      }
      setPending('withdraw');
      setError(null);
      try {
        return await client.withdraw(depositId, { signer });
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
    () => ({ cashout, withdraw, pending, result, error }),
    [cashout, withdraw, pending, result, error],
  );
}
