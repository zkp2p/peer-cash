import { useCallback, useEffect, useRef, useState } from 'react';
import type { CurrencyType } from '../sdk-types';
import type { CashClient } from '../client/createCashClient';
import type { CashEstimate, EstimateInput } from '../client/estimate';

export interface UseEstimateOptions {
  client: CashClient | null;
  /** Amount to convert, USDC base units. Estimate is skipped while null/0. */
  amount: bigint | null | undefined;
  currency: CurrencyType | null | undefined;
  /** Optional payout platform for platform-specific ETA sampling. */
  platform?: string | null | undefined;
  /** Optional Relay source. Omit for the Base USDC default path. */
  source?: EstimateInput['source'] | null | undefined;
  /** Re-fetch interval (ms) so the displayed rate tracks the market. 0 = no auto-refresh. */
  refreshIntervalMs?: number;
}

/**
 * Live market-rate estimate for a screen-1 display. The figure is a `≈`
 * estimate; the binding rate resolves at the Chainlink oracle when a buyer
 * fills - there is no committed quote to show.
 */
export function useEstimate({
  client,
  amount,
  currency,
  platform,
  source,
  refreshIntervalMs = 0,
}: UseEstimateOptions) {
  const [estimate, setEstimate] = useState<CashEstimate | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!client || !currency || !amount || amount <= 0n) {
      if (mountedRef.current) setEstimate(null);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const result = await client.estimate({
        amount,
        currency,
        ...(platform ? { platform } : {}),
        ...(source ? { source } : {}),
      });
      if (mountedRef.current) setEstimate(result);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (mountedRef.current) {
        setEstimate(null);
        setError(e);
      }
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [client, currency, amount, platform, source]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    if (refreshIntervalMs > 0) {
      timerRef.current = setInterval(() => void refresh(), refreshIntervalMs);
    }
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh, refreshIntervalMs]);

  return { estimate, isLoading, error, refresh };
}
