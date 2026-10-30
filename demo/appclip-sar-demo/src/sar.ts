export type SarPlatform = 'cashapp' | 'paypal' | 'upi';
export type SarStatus = 'pending' | 'connecting' | 'connected' | 'cancelled';

export interface SarLink {
  requestId: string;
  platform: SarPlatform;
  payeeHandle: string;
  paypalEmail?: string;
  returnUrl: string;
  state: string;
  expiresAt: number;
  /** iPhone Safari and QR codes: the App Clip invocation exactly as Curator returned it. */
  url: string;
  /** Android and other mobile browsers: the same request on `/connect`, which opens the installed Peer app. */
  appUrl: string;
}

export interface SarResult {
  status: SarStatus;
  payeeIdHash?: `0x${string}`;
}

export type SarAccountStatus = 'active' | 'inactive';

const REQUEST_ID = /^[pts][A-Za-z0-9_-]{42}$/;
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

function environmentFor(apiBase: string): { name: string; prefix: string } {
  const host = new URL(apiBase).hostname;
  if (host === 'api.zkp2p.xyz') return { name: 'production', prefix: 'p' };
  if (host === 'api-preprod.zkp2p.xyz') return { name: 'preproduction', prefix: 't' };
  if (host === 'api-staging.zkp2p.xyz') return { name: 'staging', prefix: 's' };
  throw new Error('Unsupported Curator environment.');
}

/** Curator's App Clip invocation for this request, and the same request on the app's `/connect` route. */
export function connectLinks(url: unknown, requestId: string): Pick<SarLink, 'url' | 'appUrl'> {
  if (typeof url !== 'string') throw new Error('Curator returned an invalid connection link.');
  const invocation = new URL(url);
  if (
    invocation.protocol !== 'https:' ||
    invocation.pathname !== '/clip/connect' ||
    invocation.searchParams.get('request') !== requestId
  ) {
    throw new Error('Curator returned an invalid connection link.');
  }
  const app = new URL(invocation.href);
  app.pathname = '/connect';
  return { url: invocation.href, appUrl: app.href };
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
    if (response.status === 400) {
      const body = await response.json().catch(() => null) as { errorCode?: unknown } | null;
      if (body?.errorCode === 'return_url_is_not_an_approved_caller') {
        throw new Error('This site is not approved to connect accounts in this Curator environment.');
      }
    }
    if (response.status === 410) throw new Error('This link expired. Create a new one.');
    if (response.status === 409) throw new Error('This connection is still being processed. Check status.');
    if (response.status === 429) throw new Error('Too many links. Wait a minute and try again.');
    throw new Error('Could not confirm this connection. Check status or try again.');
  }
  const envelope = object(await response.json());
  if (envelope.success !== true) throw new Error('The connection was not accepted.');
  return object(envelope.responseObject);
}

export async function readSarAccountStatus(apiBase: string, platform: SarPlatform, payeeHandle: string): Promise<SarAccountStatus> {
  const url = new URL(endpoint(apiBase));
  url.pathname += '/account-status';
  url.searchParams.set('platform', platform);
  url.searchParams.set('payeeHandle', payeeHandle);
  const result = await request(url.toString(), { method: 'GET' });
  if (!['active', 'inactive'].includes(String(result.status))) {
    throw new Error('Invalid account status response.');
  }
  return result.status as SarAccountStatus;
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
  payeeHandle: string;
  paypalEmail?: string;
  returnUrl: string;
}): Promise<SarLink> {
  const callback = new URL(input.returnUrl);
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.hash) {
    throw new Error('The return address must be HTTPS.');
  }
  const state = crypto.randomUUID();
  const checkoutEndpoint = new URL(endpoint(input.apiBase));
  checkoutEndpoint.pathname += '/checkout';
  const result = await request(checkoutEndpoint.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform: input.platform,
      payeeHandle: input.payeeHandle,
      ...(input.paypalEmail ? { paypalEmail: input.paypalEmail } : {}),
      returnUrl: input.returnUrl,
      state,
      currencies: [input.platform === 'upi' ? 'INR' : 'USD'],
    }),
  });
  const expiresAt = Number(result.expiresAt);
  if (
    typeof result.requestId !== 'string' ||
    !REQUEST_ID.test(result.requestId) ||
    result.requestId[0] !== environmentFor(input.apiBase).prefix ||
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
    payeeHandle: input.payeeHandle,
    ...(input.platform === 'paypal' ? { paypalEmail: input.paypalEmail } : {}),
    returnUrl: input.returnUrl,
    state,
    expiresAt,
    ...connectLinks(result.url, result.requestId),
  };
}

export async function readSarResult(apiBase: string, link: SarLink): Promise<SarResult> {
  if (link.expiresAt <= Date.now()) throw new Error('This link expired. Create a new one.');
  const result = await request(endpoint(apiBase), {
    method: 'GET',
    headers: { Authorization: `Bearer ${link.requestId}` },
  });
  if (
    result.environment !== environmentFor(apiBase).name ||
    result.platform !== link.platform ||
    result.payeeHandle !== link.payeeHandle ||
    (link.platform === 'paypal' && result.paypalEmail !== link.paypalEmail) ||
    result.state !== link.state ||
    result.returnUrl !== link.returnUrl ||
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
    result.environment !== environmentFor(apiBase).name ||
    result.platform !== link.platform ||
    result.payeeHandle !== link.payeeHandle ||
    result.state !== link.state ||
    result.returnUrl !== link.returnUrl ||
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

export function restoreSarLink(apiBase: string, currentOrigin: string): SarLink | null {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const link = object(JSON.parse(raw));
    if (
      typeof link.requestId !== 'string' || !REQUEST_ID.test(link.requestId) ||
      link.requestId[0] !== environmentFor(apiBase).prefix ||
      typeof link.returnUrl !== 'string' || new URL(link.returnUrl).origin !== currentOrigin ||
      typeof link.state !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(link.state) ||
      !['cashapp', 'paypal', 'upi'].includes(String(link.platform)) ||
      typeof link.payeeHandle !== 'string' || !link.payeeHandle ||
      (link.platform === 'paypal' && (typeof link.paypalEmail !== 'string' ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(link.paypalEmail))) ||
      !Number.isSafeInteger(link.expiresAt) || Number(link.expiresAt) <= Date.now()
    ) {
      clearSarLink();
      return null;
    }
    return {
      requestId: link.requestId,
      returnUrl: link.returnUrl,
      state: link.state,
      platform: link.platform as SarPlatform,
      payeeHandle: link.payeeHandle,
      ...(link.platform === 'paypal' ? { paypalEmail: link.paypalEmail as string } : {}),
      expiresAt: link.expiresAt as number,
      ...connectLinks(link.url, link.requestId),
    };
  } catch {
    clearSarLink();
    return null;
  }
}
