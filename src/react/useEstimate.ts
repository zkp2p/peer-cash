import { useCallback, useEffect, useRef, useState } from 'react';
import type { CurrencyType } from '../sdk-types';
import type { CashClient } from '../client/createCashClient';
import type { CashEstimate, EstimateInput } from '../client/estimate';

interface EstimateIdentity {
  client: CashClient;
  amount: bigint;
  currency: CurrencyType;
  platform: string | null | undefined;
  source: EstimateInput['source'] | null | undefined;
  includeEta: boolean;
}

export interface UseEstimateOptions {
  client: CashClient | null;
  /** Amount to convert, USDC base units. Estimate is skipped while null/0. */
  amount: bigint | null | undefined;
  currency: CurrencyType | null | undefined;
  /** Optional payout platform for platform-specific ETA sampling. */
  platform?: string | null | undefined;
  /** Optional Relay source. Omit for the Base USDC default path. */
  source?: EstimateInput['source'] | null | undefined;
  /** Disable to render the oracle rate before loading pair fill stats separately. */
  includeEta?: boolean;
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
  includeEta = true,
  refreshIntervalMs = 0,
}: UseEstimateOptions) {
  const [estimate, setEstimate] = useState<CashEstimate | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);
  const latestRequestRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const estimateIdentityRef = useRef<EstimateIdentity | null>(null);
  const loadingIdentityRef = useRef<EstimateIdentity | null>(null);
  const errorIdentityRef = useRef<EstimateIdentity | null>(null);

  const refresh = useCallback(async () => {
    const requestId = ++latestRequestRef.current;
    const isCurrent = () => mountedRef.current && requestId === latestRequestRef.current;
    if (!client || !currency || !amount || amount <= 0n) {
      if (isCurrent()) {
        estimateIdentityRef.current = null;
        loadingIdentityRef.current = null;
        errorIdentityRef.current = null;
        setEstimate(null);
        setIsLoading(false);
        setError(null);
      }
      return;
    }
    const identity: EstimateIdentity = { client, amount, currency, platform, source, includeEta };
    if (isCurrent()) {
      loadingIdentityRef.current = identity;
      errorIdentityRef.current = null;
      setIsLoading(true);
      setError(null);
    }
    try {
      const result = await client.estimate(
        {
          amount,
          currency,
          ...(platform ? { platform } : {}),
          ...(source ? { source } : {}),
        },
        { includeEta },
      );
      if (isCurrent()) {
        estimateIdentityRef.current = identity;
        setEstimate(result);
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (isCurrent()) {
        estimateIdentityRef.current = null;
        errorIdentityRef.current = identity;
        setEstimate(null);
        setError(e);
      }
    } finally {
      if (isCurrent()) setIsLoading(false);
    }
  }, [client, currency, amount, platform, source, includeEta]);

  useEffect(() => {
    latestRequestRef.current += 1;
    estimateIdentityRef.current = null;
    loadingIdentityRef.current = null;
    errorIdentityRef.current = null;
    setEstimate(null);
    setIsLoading(false);
    setError(null);
  }, [client, amount, currency, platform, source, includeEta]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    if (refreshIntervalMs > 0) {
      timerRef.current = setInterval(() => void refresh(), refreshIntervalMs);
    }
    return () => {
      mountedRef.current = false;
      latestRequestRef.current += 1;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh, refreshIntervalMs]);

  const matchesCurrentIdentity = (identity: EstimateIdentity | null) =>
    identity?.client === client &&
    identity.amount === amount &&
    identity.currency === currency &&
    identity.platform === platform &&
    identity.source === source &&
    identity.includeEta === includeEta;

  return {
    estimate: matchesCurrentIdentity(estimateIdentityRef.current) ? estimate : null,
    isLoading: matchesCurrentIdentity(loadingIdentityRef.current) ? isLoading : false,
    error: matchesCurrentIdentity(errorIdentityRef.current) ? error : null,
    refresh,
  };
}
