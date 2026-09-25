import { useCallback, useEffect, useState } from 'react';
import {
  cancelSarLink,
  clearSarLink,
  createReturnUrl,
  createSarLink,
  readSarAccountStatus,
  readSarResult,
  restoreSarLink,
  saveSarLink,
  type SarAccountStatus,
  type SarLink,
  type SarPlatform,
  type SarResult,
} from './sar';

const CURATOR_API = import.meta.env.VITE_CURATOR_API_URL || 'https://api.zkp2p.xyz';
const SAR_RETURN_URL = import.meta.env.VITE_SAR_RETURN_URL;
const sarReturnUrl = () => createReturnUrl({ href: SAR_RETURN_URL || window.location.href });

const RAILS: Record<SarPlatform, { title: string; label: string }> = {
  cashapp: { title: 'Cash App', label: 'Cashtag' },
  paypal: { title: 'PayPal', label: 'PayPal.Me username' },
  upi: { title: 'Amazon Pay UPI', label: 'UPI ID' },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}

export function useDemo() {
  const [rail, setRail] = useState<SarPlatform>('upi');
  const [payee, setPayee] = useState('');
  const [paypalEmail, setPaypalEmail] = useState('');
  const [link, setLink] = useState<SarLink | null>(null);
  const [result, setResult] = useState<SarResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountStatus, setAccountStatus] = useState<{ key: string; status: SarAccountStatus } | null>(null);
  const [accountStatusError, setAccountStatusError] = useState<{ key: string; message: string } | null>(null);
  const normalizedPayee = payee.trim().replace(/^[@$]/, '').toLowerCase();
  const accountKey = `${rail}:${normalizedPayee}`;
  const activeLink = link?.platform === rail && link.payeeHandle === normalizedPayee ? link : null;

  useEffect(() => {
    const restored = restoreSarLink(CURATOR_API, new URL(sarReturnUrl()).origin);
    if (restored) {
      setLink(restored);
      setRail(restored.platform);
      setPayee(restored.payeeHandle);
      setPaypalEmail(restored.paypalEmail ?? '');
    }
  }, []);

  useEffect(() => {
    if (!normalizedPayee) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void readSarAccountStatus(CURATOR_API, rail, normalizedPayee)
        .then((status) => {
          if (!cancelled) {
            setAccountStatus({ key: accountKey, status });
            setAccountStatusError(null);
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled) setAccountStatusError({ key: accountKey, message: errorMessage(cause) });
        });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [rail, normalizedPayee, accountKey, result?.status]);

  const refresh = useCallback(async (current: SarLink) => {
    try {
      setResult(await readSarResult(CURATOR_API, current));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    if (!activeLink || result?.status === 'connected' || result?.status === 'cancelled') return;
    void refresh(activeLink);
    const timer = window.setInterval(() => void refresh(activeLink), 3000);
    return () => window.clearInterval(timer);
  }, [activeLink, result?.status, refresh]);

  const start = async () => {
    if (busy) return;
    setError(null);
    if (!normalizedPayee) {
      setError(`Enter your ${RAILS[rail].label}.`);
      return;
    }
    const normalizedEmail = paypalEmail.trim().toLowerCase();
    if (rail === 'paypal' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setError('Enter your PayPal account email.');
      return;
    }
    setBusy(true);
    try {
      const next = await createSarLink({
        apiBase: CURATOR_API,
        platform: rail,
        payeeHandle: normalizedPayee,
        ...(rail === 'paypal' ? { paypalEmail: normalizedEmail } : {}),
        returnUrl: sarReturnUrl(),
      });
      saveSarLink(next);
      setLink(next);
      setResult({ status: 'pending' });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!activeLink || busy) return;
    if (activeLink.expiresAt <= Date.now()) {
      clearSarLink();
      setLink(null);
      setResult(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await cancelSarLink(CURATOR_API, activeLink);
      clearSarLink();
      setLink(null);
      setResult(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    clearSarLink();
    setLink(null);
    setResult(null);
    setError(null);
    setPayee('');
    setPaypalEmail('');
  };

  return {
    rails: RAILS,
    rail,
    setRail,
    payee,
    setPayee,
    paypalEmail,
    setPaypalEmail,
    sar: {
      link: activeLink,
      result: activeLink ? result : null,
      available: accountStatus?.key === accountKey && accountStatus.status === 'active',
      accountStatusError: accountStatusError?.key === accountKey ? accountStatusError.message : null,
      busy,
      error,
      start,
      cancel,
      refresh: () => activeLink && void refresh(activeLink),
      reset,
    },
  };
}

export type DemoModel = ReturnType<typeof useDemo>;
