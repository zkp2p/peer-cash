import { useCallback, useEffect, useMemo, useState } from 'react';
import { createCashClient, isCashError, usdc, type CashEstimate } from '@zkp2p/cash';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { createWalletClient, custom } from 'viem';
import { base } from 'viem/chains';
import {
  cancelSarLink,
  clearSarLink,
  createReturnUrl,
  createSarLink,
  readActiveSarAccounts,
  readSarAccountStatus,
  readSarResult,
  restoreSarLink,
  saveSarLink,
  type SarLink,
  type ActiveSarAccount,
  type SarPlatform,
  type SarResult,
  type SarAccountStatus,
} from './sar';

const CASH_ORDER_KEY = 'peer-cash-demo-order';
const CURATOR_API = import.meta.env.VITE_CURATOR_API_URL || 'https://api.zkp2p.xyz';
const SAR_RETURN_URL = import.meta.env.VITE_SAR_RETURN_URL;
const sarReturnUrl = () => createReturnUrl({ href: SAR_RETURN_URL || window.location.href });
const cash = createCashClient({ environment: 'production', referrer: 'peer-cash-appclip-demo' });
const capabilities = cash.capabilities();

const RAILS: Record<SarPlatform, { title: string; currency: 'USD' | 'INR'; label: string }> = {
  cashapp: { title: 'Cash App', currency: 'USD', label: 'Cashtag' },
  paypal: { title: 'PayPal', currency: 'USD', label: 'PayPal.Me handle' },
  upi: { title: 'Amazon Pay UPI', currency: 'INR', label: 'UPI ID' },
};

export type DemoRail = SarPlatform & keyof typeof RAILS;

export interface DemoOrder {
  depositId: string;
  txHash: string | null;
  state: string;
  explanation: string;
  canWithdraw: boolean;
}

function errorMessage(error: unknown): string {
  if (isCashError(error)) return error.remediation || error.message;
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}

function restoreOrder(address: string | undefined): { depositId: string; txHash: string | null } | null {
  if (!address) return null;
  try {
    const raw = sessionStorage.getItem(CASH_ORDER_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    return value.wallet === address.toLowerCase() &&
      typeof value.depositId === 'string' &&
      /^0x[0-9a-fA-F]{40}_\d+$/.test(value.depositId)
      ? { depositId: value.depositId, txHash: typeof value.txHash === 'string' ? value.txHash : null }
      : null;
  } catch {
    return null;
  }
}

export function useDemo() {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const wallet = useMemo(
    () => wallets.find((item) => item.walletClientType === 'privy') ?? wallets[0],
    [wallets],
  );
  const address = authenticated && wallet?.address?.match(/^0x[0-9a-f]{40}$/i)
    ? (wallet.address as `0x${string}`)
    : undefined;
  const [rail, setRail] = useState<SarPlatform>('upi');
  const [amount, setAmount] = useState('');
  const [payee, setPayee] = useState('');
  const [paypalEmail, setPaypalEmail] = useState('');
  const [estimate, setEstimate] = useState<CashEstimate | null>(null);
  const [estimateBusy, setEstimateBusy] = useState(false);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [link, setLink] = useState<SarLink | null>(null);
  const [sarResult, setSarResult] = useState<SarResult | null>(null);
  const [sarBusy, setSarBusy] = useState(false);
  const [sarError, setSarError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<ActiveSarAccount[]>([]);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [accountStatus, setAccountStatus] = useState<{ key: string; status: SarAccountStatus } | null>(null);
  const [accountStatusError, setAccountStatusError] = useState<{ key: string; message: string } | null>(null);
  const [cashoutBusy, setCashoutBusy] = useState(false);
  const [cashoutError, setCashoutError] = useState<string | null>(null);
  const [order, setOrder] = useState<DemoOrder | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);

  const railCapability = capabilities.platforms.find((item) => item.platform === rail);
  const railSupported = railCapability?.currencies.includes(RAILS[rail].currency) ?? false;
  const normalizedPayee = payee.trim().replace(/^[@$]/, '').toLowerCase();
  const accountKey = `${rail}:${normalizedPayee}`;

  useEffect(() => {
    if (!normalizedPayee || !authenticated) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void readSarAccountStatus(CURATOR_API, rail, normalizedPayee)
        .then((status) => { if (!cancelled) { setAccountStatus({ key: accountKey, status }); setAccountStatusError(null); } })
        .catch((error: unknown) => { if (!cancelled) setAccountStatusError({ key: accountKey, message: errorMessage(error) }); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [authenticated, rail, normalizedPayee, accountKey, sarResult?.status]);

  useEffect(() => {
    if (!ready || (authenticated && !address)) return;
    const restoredLink = restoreSarLink(address, new URL(sarReturnUrl()).origin);
    setLink(restoredLink);
    if (restoredLink) {
      setRail(restoredLink.platform);
      setPayee(restoredLink.payeeHandle);
    }
    setSarResult(null);
    setSarError(null);
    const savedOrder = restoreOrder(address);
    setOrder(savedOrder ? {
      ...savedOrder,
      state: 'Checking status',
      explanation: 'Reading this cash-out from the chain.',
      canWithdraw: false,
    } : null);
  }, [address, authenticated, ready]);

  useEffect(() => {
    if (!ready || !authenticated || !address) {
      setAccounts([]);
      setAccountsError(null);
      return;
    }
    let cancelled = false;
    void getAccessToken()
      .then((token) => {
        if (!token) throw new Error('Sign in again to check your connected accounts.');
        return readActiveSarAccounts(CURATOR_API, token);
      })
      .then((next) => {
        if (!cancelled) {
          setAccounts(next);
          setAccountsError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setAccountsError(errorMessage(error));
      });
    return () => { cancelled = true; };
  }, [ready, authenticated, address, sarResult?.status, getAccessToken]);

  useEffect(() => {
    let stale = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setEstimate(null);
    setEstimateError(null);
    if (!railSupported || !/^\d+(?:\.\d{0,6})?$/.test(amount)) {
      setEstimateBusy(false);
      return;
    }
    let units: bigint;
    try {
      units = usdc(amount);
    } catch {
      setEstimateBusy(false);
      return;
    }
    if (units < capabilities.amount.min) {
      setEstimateBusy(false);
      return;
    }
    setEstimateBusy(true);
    timer = setTimeout(() => {
      void cash.estimate({ amount: units, platform: rail, currency: RAILS[rail].currency }, { includeEta: false })
        .then((next) => { if (!stale) setEstimate(next); })
        .catch((error: unknown) => { if (!stale) setEstimateError(errorMessage(error)); })
        .finally(() => { if (!stale) setEstimateBusy(false); });
    }, 300);
    return () => {
      stale = true;
      if (timer) clearTimeout(timer);
    };
  }, [amount, rail, railSupported]);

  const refreshSar = useCallback(async (activeLink: SarLink) => {
    try {
      const result = await readSarResult(CURATOR_API, activeLink);
      setSarResult(result);
      setSarError(null);
    } catch (error) {
      setSarError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    if (!link || link.platform !== rail ||
        sarResult?.status === 'connected' || sarResult?.status === 'cancelled') return;
    void refreshSar(link);
    const timer = window.setInterval(() => void refreshSar(link), 3000);
    return () => window.clearInterval(timer);
  }, [link, rail, sarResult?.status, refreshSar]);

  const startSar = async () => {
    if (sarBusy || !address || !authenticated) return;
    setSarBusy(true);
    setSarError(null);
    try {
      const payeeHandle = normalizedPayee;
      if (!payeeHandle) throw new Error(`Enter your ${RAILS[rail].label}.`);
      const normalizedEmail = paypalEmail.trim().toLowerCase();
      if (rail === 'paypal' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        throw new Error('Enter your PayPal account email.');
      }
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again to connect your account.');
      const next = await createSarLink({
        apiBase: CURATOR_API,
        platform: rail,
        payeeHandle,
        ...(rail === 'paypal' ? { paypalEmail: normalizedEmail } : {}),
        callerAddress: address,
        accessToken: token,
        returnUrl: sarReturnUrl(),
      });
      saveSarLink(next);
      setLink(next);
      setSarResult({ status: 'pending' });
    } catch (error) {
      setSarError(errorMessage(error));
    } finally {
      setSarBusy(false);
    }
  };

  const cancelSar = async () => {
    if (!link || sarBusy) return;
    setSarBusy(true);
    setSarError(null);
    try {
      const result = await cancelSarLink(CURATOR_API, link);
      setSarResult(result);
      clearSarLink();
      setLink(null);
    } catch (error) {
      setSarError(errorMessage(error));
    } finally {
      setSarBusy(false);
    }
  };

  const refreshOrder = useCallback(async (depositId: string, txHash: string | null) => {
    try {
      const next = await cash.order(depositId);
      setOrder({
        depositId,
        txHash,
        state: next.state,
        explanation: next.explain(),
        canWithdraw: next.nextActions.includes('withdraw'),
      });
      setOrderError(null);
    } catch (error) {
      setOrderError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    if (!order?.depositId || ['delivered', 'returned'].includes(order.state)) return;
    const timer = window.setInterval(() => void refreshOrder(order.depositId, order.txHash), 6000);
    void refreshOrder(order.depositId, order.txHash);
    return () => window.clearInterval(timer);
  }, [order?.depositId, order?.state, order?.txHash, refreshOrder]);

  const signer = async () => {
    if (!wallet || !address) throw new Error('Sign in and choose a wallet first.');
    const provider = await wallet.getEthereumProvider();
    if (!provider) throw new Error('Your wallet is not ready. Reconnect and try again.');
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] });
    return createWalletClient({ account: address, chain: base, transport: custom(provider) });
  };

  const startCashout = async () => {
    if (cashoutBusy || !address || !railSupported) return;
    setCashoutError(null);
    let units: bigint;
    try {
      units = usdc(amount);
      if (units < capabilities.amount.min) throw new Error('Enter at least 0.01 USDC.');
      if (!payee.trim()) throw new Error(`Enter your ${RAILS[rail].label}.`);
    } catch (error) {
      setCashoutError(errorMessage(error));
      return;
    }
    setCashoutBusy(true);
    try {
      const result = await cash.cashout({
        amount: units,
        receive: { platform: rail, currency: RAILS[rail].currency, payee: payee.trim() },
      }, { signer: await signer() });
      sessionStorage.setItem(CASH_ORDER_KEY, JSON.stringify({
        wallet: address.toLowerCase(), depositId: result.depositId, txHash: result.txHash,
      }));
      setOrder({
        depositId: result.depositId,
        txHash: result.txHash,
        state: result.order.state,
        explanation: result.order.explain(),
        canWithdraw: result.order.nextActions.includes('withdraw'),
      });
    } catch (error) {
      setCashoutError(errorMessage(error));
    } finally {
      setCashoutBusy(false);
    }
  };

  const withdraw = async () => {
    if (!order || cashoutBusy || !order.canWithdraw) return;
    setCashoutBusy(true);
    setOrderError(null);
    try {
      await cash.withdraw(order.depositId, { signer: await signer() });
      await refreshOrder(order.depositId, order.txHash);
    } catch (error) {
      setOrderError(errorMessage(error));
    } finally {
      setCashoutBusy(false);
    }
  };

  const newCashout = () => {
    sessionStorage.removeItem(CASH_ORDER_KEY);
    setOrder(null);
    setOrderError(null);
    setCashoutError(null);
  };

  return {
    auth: { ready, authenticated, email: user?.email?.address ?? null,
      address, login, logout },
    rails: RAILS,
    rail,
    setRail,
    railSupported,
    payeeHint: railCapability?.payeeHint ?? '',
    requiresIdentityAttestation: railCapability?.requiresIdentityAttestation ?? false,
    amount,
    setAmount,
    payee,
    setPayee,
    paypalEmail,
    setPaypalEmail,
    estimate,
    estimateBusy,
    estimateError,
    sar: { link: link?.platform === rail && link.payeeHandle === normalizedPayee ? link : null,
      result: link?.platform === rail && link.payeeHandle === normalizedPayee ? sarResult : null,
      pending: Boolean(link && link.expiresAt > Date.now() &&
        sarResult?.status !== 'connected' && sarResult?.status !== 'cancelled'),
      account: accounts.find((item) => item.platform === rail &&
        normalizedPayee && item.offchainId.replace(/^[@$]/, '').toLowerCase() === normalizedPayee) ?? null,
      available: accountStatus?.key === accountKey && accountStatus.status === 'active',
      accountStatusError: accountStatusError?.key === accountKey ? accountStatusError.message : null,
      accountsError, busy: sarBusy, error: sarError, start: startSar, cancel: cancelSar,
      refresh: () => link && void refreshSar(link) },
    cashout: { busy: cashoutBusy, error: cashoutError, start: startCashout },
    order: { data: order, error: orderError, refresh: () => order && void refreshOrder(order.depositId, order.txHash),
      withdraw, newCashout },
  };
}

export type DemoModel = ReturnType<typeof useDemo>;
