export type SarPlatform = 'cashapp' | 'paypal' | 'upi';
export type SarStatus = 'pending' | 'connecting' | 'connected' | 'cancelled';

export interface SarLink {
  requestId: string;
  platform: SarPlatform;
  callerAddress: `0x${string}`;
  returnUrl: string;
  state: string;
  expiresAt: number;
  url: string;
}

export interface SarResult {
  status: SarStatus;
  payeeIdHash?: `0x${string}`;
}

export interface ActiveSarAccount {
  platform: SarPlatform;
  offchainId: string;
  payeeIdHash: `0x${string}`;
}

const REQUEST_ID = /^p[A-Za-z0-9_-]{42}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const PAYEE_HASH = /^0x[0-9a-f]{64}$/i;
const SESSION_KEY = 'peer-cash-demo-sar-link';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid account connection response.');
  }
  return value as Record<string, unknown>;
}

function endpoint(apiBase: string): string {
  const url = new URL(apiBase);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('A secure Curator URL is required.');
  }
  return new URL('/v2/sar/connections', url).toString();
}

async function request(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    if (response.status === 403) throw new Error('This account connection is unavailable right now.');
    if (response.status === 410) throw new Error('This link expired. Create a new one.');
    if (response.status === 409) throw new Error('This connection is still being processed. Check status.');
    if (response.status === 401) throw new Error('Sign in again to connect your account.');
    throw new Error('Could not confirm this connection. Check status or try again.');
  }
  const envelope = object(await response.json());
  if (envelope.success !== true) throw new Error('The connection was not accepted.');
  return object(envelope.responseObject);
}

export async function readActiveSarAccounts(apiBase: string, accessToken: string): Promise<ActiveSarAccount[]> {
  if (!accessToken) throw new Error('Sign in again to check your connected accounts.');
  const base = new URL(apiBase);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('A secure Curator URL is required.');
  }
  const result = await request(new URL('/v2/me', base).toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!Array.isArray(result.connectedAccounts)) throw new Error('Invalid connected accounts response.');
  return result.connectedAccounts.flatMap((value: unknown) => {
    const account = object(value);
    if (!['cashapp', 'paypal', 'upi'].includes(String(account.platform)) ||
        typeof account.offchainId !== 'string' || !account.offchainId.trim() ||
        typeof account.payeeIdHash !== 'string' || !PAYEE_HASH.test(account.payeeIdHash) ||
        typeof account.revoked !== 'boolean' ||
        !['active', 'inactive'].includes(String(account.credentialStatus))) {
      throw new Error('Invalid connected account.');
    }
    return account.revoked || account.credentialStatus !== 'active' ? [] : [{
      platform: account.platform as SarPlatform,
      offchainId: account.offchainId,
      payeeIdHash: account.payeeIdHash.toLowerCase() as `0x${string}`,
    }];
  });
}

export function createReturnUrl(location: Pick<Location, 'href'>): string {
  const url = new URL(location.href);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new Error('A secure demo URL is required.');
  }
  url.hash = '';
  url.searchParams.delete('sarState');
  url.searchParams.delete('sarStatus');
  return url.toString();
}

export async function createSarLink(input: {
  apiBase: string;
  platform: SarPlatform;
  callerAddress: `0x${string}`;
  accessToken: string;
  returnUrl: string;
}): Promise<SarLink> {
  if (!ADDRESS.test(input.callerAddress) || !input.accessToken) {
    throw new Error('Sign in and choose a wallet first.');
  }
  const callback = new URL(input.returnUrl);
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.hash) {
    throw new Error('The return address must be HTTPS.');
  }
  const state = crypto.randomUUID();
  const result = await request(endpoint(input.apiBase), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.accessToken}`,
    },
    body: JSON.stringify({
      platform: input.platform,
      callerAddress: input.callerAddress,
      returnUrl: input.returnUrl,
      state,
      currencies: [input.platform === 'upi' ? 'INR' : 'USD'],
    }),
  });
  const expiresAt = Number(result.expiresAt);
  if (
    typeof result.requestId !== 'string' ||
    !REQUEST_ID.test(result.requestId) ||
    typeof result.expiresAt !== 'string' ||
    !/^\d+$/.test(result.expiresAt) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now()
  ) {
    throw new Error('Curator returned an invalid connection link.');
  }
  return {
    requestId: result.requestId,
    platform: input.platform,
    callerAddress: input.callerAddress,
    returnUrl: input.returnUrl,
    state,
    expiresAt,
    url: `https://mobile.peer.xyz/clip/connect?request=${result.requestId}`,
  };
}

export async function readSarResult(apiBase: string, link: SarLink): Promise<SarResult> {
  if (link.expiresAt <= Date.now()) throw new Error('This link expired. Create a new one.');
  const result = await request(endpoint(apiBase), {
    method: 'GET',
    headers: { Authorization: `Bearer ${link.requestId}` },
  });
  if (
    result.environment !== 'production' ||
    result.platform !== link.platform ||
    result.state !== link.state ||
    result.returnUrl !== link.returnUrl ||
    typeof result.callerAddress !== 'string' ||
    result.callerAddress.toLowerCase() !== link.callerAddress.toLowerCase() ||
    !['pending', 'connecting', 'connected', 'cancelled'].includes(String(result.status))
  ) {
    throw new Error('The connection does not belong to this account.');
  }
  if (result.status === 'connected' &&
      (typeof result.payeeIdHash !== 'string' || !PAYEE_HASH.test(result.payeeIdHash))) {
    throw new Error('Curator returned an invalid connected account.');
  }
  return {
    status: result.status as SarStatus,
    ...(typeof result.payeeIdHash === 'string'
      ? { payeeIdHash: result.payeeIdHash.toLowerCase() as `0x${string}` }
      : {}),
  };
}

export async function cancelSarLink(apiBase: string, link: SarLink): Promise<SarResult> {
  if (link.expiresAt <= Date.now()) throw new Error('This link expired. Create a new one.');
  const result = await request(endpoint(apiBase), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${link.requestId}` },
  });
  if (
    result.environment !== 'production' ||
    result.platform !== link.platform ||
    result.state !== link.state ||
    result.returnUrl !== link.returnUrl ||
    typeof result.callerAddress !== 'string' ||
    result.callerAddress.toLowerCase() !== link.callerAddress.toLowerCase() ||
    result.status !== 'cancelled'
  ) {
    throw new Error('The cancelled connection does not match this account.');
  }
  return { status: 'cancelled' };
}

export function saveSarLink(link: SarLink): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(link));
}

export function clearSarLink(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

export function restoreSarLink(wallet: string | undefined, currentOrigin: string): SarLink | null {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const link = object(JSON.parse(raw));
    if (
      typeof link.requestId !== 'string' || !REQUEST_ID.test(link.requestId) ||
      typeof link.callerAddress !== 'string' || !ADDRESS.test(link.callerAddress) ||
      !wallet || link.callerAddress.toLowerCase() !== wallet.toLowerCase() ||
      typeof link.returnUrl !== 'string' || new URL(link.returnUrl).origin !== currentOrigin ||
      typeof link.state !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(link.state) ||
      !['cashapp', 'paypal', 'upi'].includes(String(link.platform)) ||
      !Number.isSafeInteger(link.expiresAt) || Number(link.expiresAt) <= Date.now()
    ) {
      clearSarLink();
      return null;
    }
    return {
      requestId: link.requestId,
      callerAddress: link.callerAddress as `0x${string}`,
      returnUrl: link.returnUrl,
      state: link.state,
      platform: link.platform as SarPlatform,
      expiresAt: link.expiresAt as number,
      url: `https://mobile.peer.xyz/clip/connect?request=${link.requestId}`,
    };
  } catch {
    clearSarLink();
    return null;
  }
}
