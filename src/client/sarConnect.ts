/**
 * Cash App and PayPal seller connection through the Peer App Clip (iPhone) or
 * the installed Peer app (Android and other mobile browsers), the same Curator
 * flow Peer Payouts uses. Curator owns the 15-minute session; Peer Cash only
 * creates it, hands out its links, reads its status and confirms the account.
 * A connection never moves funds and never starts a cash-out.
 *
 * Curator contract: `curator/docs/appclip-sar-connections.md`. Account rules
 * mirror `curator/src/api/v2/sarConnection/sarConnectionAccount.ts` through
 * `sarConnectAccountSchema`; `scripts/check-curator-sar-contract.ts` compares
 * them with a live Curator.
 */
import type { Address, Hash } from 'viem';
import type { CurrencyType, RuntimeEnv } from '../sdk-types';
import {
  normalizeSarPayeeHandle,
  sarConnectAccountSchema,
  sarConnectAccountStatusSchema,
  sarConnectContextSchema,
  sarConnectCreatedSchema,
  sarConnectCurrenciesSchema,
  SAR_CONNECT_STATE_PATTERN,
  type SarConnectContextJson,
} from '../codecs/schemas';
import { buildCapabilities } from './capabilities';

export type SarConnectPlatform = 'cashapp' | 'paypal';
export type PayPalIdentityActionType = 'register_paypal' | 'register_business_paypal';

/** The seller-selected payout account. Curator binds the connection to it. */
export type SarConnectAccount =
  | { platform: 'cashapp'; payeeHandle: string }
  | {
      platform: 'paypal';
      payeeHandle: string;
      /** Required: the PayPal account email the receipts arrive at. */
      paypalEmail: string;
      /** Personal (default) or Business PayPal account. */
      identityActionType?: PayPalIdentityActionType | undefined;
    };

export type SarConnectInput = SarConnectAccount & {
  /**
   * HTTPS page the App Clip returns to. Its exact origin must be on the
   * Curator environment's `SAR_CONNECT_RETURN_ORIGINS` and CORS lists.
   */
  returnUrl: string;
  /** Payout currencies stored on the connection. Cash App is USD only; PayPal defaults to its catalog. */
  currencies?: readonly CurrencyType[];
  /** Your own 16-128 URL-safe character state. Defaults to 24 random bytes. */
  state?: string;
};

/** Wallet-owned create (`POST /v2/sar/connections`); omit for the wallet-free checkout route. */
export interface SarConnectWalletAuth {
  /** The seller's Privy access token. Curator re-reads its linked wallets. */
  privyAccessToken: string;
  /** The Privy-linked wallet that owns the maker profile. */
  callerAddress: Address;
  /** Reconnect only: the payee hash the new credential must match. */
  expectedPayeeIdHash?: Hash;
}

export type PreparedSarConnect = SarConnectAccount & {
  /**
   * A 15-minute capability for this connection. Persist it with the link, send
   * it only as the status Bearer token, and never log it.
   */
  requestId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  state: string;
  returnUrl: string;
  currencies: string[];
  environment: RuntimeEnv;
  /** iPhone Safari and desktop QR codes: the App Clip invocation exactly as Curator returned it. */
  url: string;
  /** Android and other mobile browsers: the same capability on `/connect`, which opens the installed Peer app. */
  appUrl: string;
};

export type SarConnectStatus = 'pending' | 'connecting' | 'connected' | 'cancelled' | 'expired';

export interface SarConnectResult {
  status: SarConnectStatus;
  /** Present when `connected`: the verified account's payee hash. */
  payeeIdHash?: Hash;
}

export type SarConnectDevice = 'ios-safari' | 'other-mobile' | 'desktop';

export type SarConnectErrorCode =
  | 'invalid_account'
  | 'invalid_return_url'
  | 'unavailable'
  | 'rate_limited'
  | 'expired'
  | 'busy'
  | 'unauthorized'
  | 'mismatch'
  | 'unconfirmed'
  | 'invalid_response'
  | 'timeout'
  | 'request_failed';

const RETRYABLE: ReadonlySet<SarConnectErrorCode> = new Set([
  'rate_limited',
  'busy',
  'unconfirmed',
  'timeout',
  'request_failed',
]);

/** Separate from `CashError`: an account connection is not a cash-out. */
export class SarConnectError extends Error {
  readonly code: SarConnectErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    code: SarConnectErrorCode,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SarConnectError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    if (options?.status !== undefined) this.status = options.status;
  }
}

export interface SarConnectOptions {
  environment: RuntimeEnv;
  /** Curator origin. Defaults by environment. */
  curatorUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Per-request deadline, including body parsing. Default 15000. */
  timeoutMs?: number;
}

export interface SarConnectWaitOptions {
  signal?: AbortSignal;
  /** Default 3000, matching Peer Payouts. */
  pollIntervalMs?: number;
  /**
   * Stop early: returns the latest `pending` / `connecting` status, or throws the
   * last retryable error if every read since the previous success failed.
   * Defaults to the link's own expiry.
   */
  timeoutMs?: number;
}

export interface SarConnectClient {
  prepare(input: SarConnectInput, auth?: SarConnectWalletAuth): Promise<PreparedSarConnect>;
  status(link: PreparedSarConnect, options?: { signal?: AbortSignal }): Promise<SarConnectResult>;
  wait(link: PreparedSarConnect, options?: SarConnectWaitOptions): Promise<SarConnectResult>;
  cancel(link: PreparedSarConnect): Promise<SarConnectResult>;
  isConnected(account: Pick<SarConnectAccount, 'platform' | 'payeeHandle'>): Promise<boolean>;
}

export const SAR_CONNECT_CURATOR_URLS: Record<RuntimeEnv, string> = {
  production: 'https://api.zkp2p.xyz',
  preproduction: 'https://api-preprod.zkp2p.xyz',
  staging: 'https://api-staging.zkp2p.xyz',
};
const ENVIRONMENT_PREFIX: Record<RuntimeEnv, string> = {
  production: 'p',
  preproduction: 't',
  staging: 's',
};
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 3_000;
/** Curator can report `connected` a moment before account status sees the credential. */
const CONFIRM_ATTEMPTS = 3;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}

/** 24 random bytes as base64url: 32 characters, inside Curator's 16-128 URL-safe range. */
function randomState(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

/** Normalize and check an account against Curator's rules before a link is minted. */
export function normalizeSarConnectAccount(account: SarConnectAccount): SarConnectAccount {
  const parsed = sarConnectAccountSchema.safeParse(account);
  if (!parsed.success) {
    throw new SarConnectError(
      'invalid_account',
      account.platform === 'cashapp'
        ? 'Enter a Cash App cashtag: letters and digits, up to 20.'
        : 'Enter a PayPal username (letters, digits, ".", "_" or "-") and the PayPal account email.',
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

/** Validate `returnUrl` and return it in the form Curator stores and echoes (`new URL(...).href`). */
function canonicalReturnUrl(returnUrl: string): string {
  let url: URL;
  try {
    url = new URL(returnUrl);
  } catch (cause) {
    throw new SarConnectError('invalid_return_url', 'returnUrl must be an absolute HTTPS URL.', {
      cause,
    });
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    returnUrl.includes('#') ||
    url.searchParams.has('sarState') ||
    url.searchParams.has('sarStatus') ||
    returnUrl.length > 2048
  ) {
    throw new SarConnectError(
      'invalid_return_url',
      'returnUrl must be HTTPS without credentials, a fragment, sarState or sarStatus.',
    );
  }
  return url.href;
}

/** Which link to show: Safari keeps the App Clip, other mobile browsers open the app, desktop shows a QR code. */
export function detectSarConnectDevice(
  nav:
    | { userAgent: string; platform?: string; maxTouchPoints?: number }
    | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): SarConnectDevice {
  if (!nav) return 'desktop';
  const ua = nav.userAgent;
  const appleMobile =
    /iPhone|iPod|iPad/u.test(ua) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1);
  if (appleMobile) {
    const safari =
      /Version\/\d+/u.test(ua) &&
      /Safari\//u.test(ua) &&
      !/CriOS|FxiOS|EdgiOS|OPiOS|OPT|DuckDuckGo|GSA|FBAN|FBAV|Instagram|Brave/u.test(ua);
    return safari ? 'ios-safari' : 'other-mobile';
  }
  return /Android|Mobi/u.test(ua) ? 'other-mobile' : 'desktop';
}

/** The link to open on `device`. A desktop QR code carries the App Clip URL; the scanning phone's landing page routes it. */
export function sarConnectUrlFor(
  link: Pick<PreparedSarConnect, 'url' | 'appUrl'>,
  device: SarConnectDevice,
): string {
  return device === 'other-mobile' ? link.appUrl : link.url;
}

function appUrlFrom(url: string, requestId: string): string {
  let invocation: URL;
  try {
    invocation = new URL(url);
  } catch (cause) {
    throw new SarConnectError('invalid_response', 'Curator returned an invalid connection link.', {
      cause,
    });
  }
  if (
    invocation.protocol !== 'https:' ||
    invocation.pathname !== '/clip/connect' ||
    invocation.searchParams.get('request') !== requestId
  ) {
    throw new SarConnectError('invalid_response', 'Curator returned an invalid connection link.');
  }
  // Both mobile routes accept the same capability; the landing page owns app schemes and store fallbacks.
  const app = new URL(invocation.href);
  app.pathname = '/connect';
  return app.href;
}

async function errorFor(response: Response): Promise<SarConnectError> {
  const { status } = response;
  let errorCode: unknown;
  try {
    errorCode = ((await response.json()) as { errorCode?: unknown }).errorCode;
  } catch {
    // Rate limits and Privy failures answer without Curator's envelope.
  }
  if (errorCode === 'return_url_is_not_an_approved_caller') {
    return new SarConnectError(
      'invalid_return_url',
      "This return URL's origin is not on the Curator environment's SAR_CONNECT_RETURN_ORIGINS.",
      { status },
    );
  }
  switch (status) {
    case 400:
    case 422:
      return new SarConnectError(
        'invalid_account',
        'Curator rejected this payout account or return URL.',
        {
          status,
        },
      );
    case 401:
    case 410:
      return new SarConnectError('expired', 'This link expired. Create a new one.', { status });
    case 403:
      return new SarConnectError(
        'unavailable',
        'This account connection is unavailable in this Curator environment.',
        { status },
      );
    case 409:
      return new SarConnectError(
        'busy',
        'This connection is still being processed. Check status.',
        {
          status,
        },
      );
    case 429:
      return new SarConnectError('rate_limited', 'Too many links. Wait a minute and try again.', {
        status,
      });
    default:
      return new SarConnectError('request_failed', `Curator returned HTTP ${status}.`, { status });
  }
}

export function createSarConnectClient(options: SarConnectOptions): SarConnectClient {
  const { environment } = options;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('SAR connect timeoutMs must be between 1 and 60000');
  }
  const curatorUrl = new URL(options.curatorUrl ?? SAR_CONNECT_CURATOR_URLS[environment]).origin;
  const endpoint = `${curatorUrl}/v2/sar/connections`;
  const paypalCurrencies =
    buildCapabilities(environment).platforms.find((capability) => capability.platform === 'paypal')
      ?.currencies ?? [];

  async function request(
    path: string,
    init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown; token?: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetchImplementation(`${endpoint}${path}`, {
        method: init.method,
        cache: 'no-store',
        credentials: 'omit',
        headers: {
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      if (!response.ok) throw await errorFor(response);
      let envelope: unknown;
      try {
        envelope = await response.json();
      } catch (cause) {
        throw new SarConnectError('invalid_response', 'Curator returned invalid JSON.', { cause });
      }
      if (
        typeof envelope !== 'object' ||
        envelope === null ||
        (envelope as { success?: unknown }).success !== true
      ) {
        throw new SarConnectError('invalid_response', 'Curator did not accept the request.');
      }
      return (envelope as { responseObject?: unknown }).responseObject;
    } catch (cause) {
      if (cause instanceof SarConnectError) throw cause;
      if (signal?.aborted) throw abortError();
      if (controller.signal.aborted) {
        throw new SarConnectError('timeout', 'Curator did not answer in time.', { cause });
      }
      throw new SarConnectError('request_failed', 'Could not reach Curator.', { cause });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  /** Accept only the exact connection this link created. */
  function matchContext(link: PreparedSarConnect, value: unknown): SarConnectContextJson {
    const parsed = sarConnectContextSchema.safeParse(value);
    if (!parsed.success) {
      throw new SarConnectError(
        'invalid_response',
        'Curator returned an invalid connection status.',
        {
          cause: parsed.error,
        },
      );
    }
    const context = parsed.data;
    if (
      context.environment !== environment ||
      context.platform !== link.platform ||
      context.payeeHandle !== link.payeeHandle ||
      (link.platform === 'paypal' &&
        (context.platform !== 'paypal' || context.paypalEmail !== link.paypalEmail)) ||
      context.state !== link.state ||
      context.returnUrl !== link.returnUrl
    ) {
      throw new SarConnectError('mismatch', 'The connection does not belong to this link.');
    }
    if (context.status === 'connected' && !context.payeeIdHash) {
      throw new SarConnectError(
        'invalid_response',
        'Curator reported a connection without its account.',
      );
    }
    return context;
  }

  function resultOf(context: SarConnectContextJson): SarConnectResult {
    return {
      status: context.status,
      ...(context.status === 'connected' && context.payeeIdHash
        ? { payeeIdHash: context.payeeIdHash.toLowerCase() as Hash }
        : {}),
    };
  }

  async function isConnected(
    account: Pick<SarConnectAccount, 'platform' | 'payeeHandle'>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const query = new URLSearchParams({
      platform: account.platform,
      payeeHandle: account.payeeHandle,
    });
    const parsed = sarConnectAccountStatusSchema.safeParse(
      await request(`/account-status?${query.toString()}`, { method: 'GET' }, signal),
    );
    if (!parsed.success) {
      throw new SarConnectError('invalid_response', 'Curator returned an invalid account status.', {
        cause: parsed.error,
      });
    }
    return parsed.data.status === 'active';
  }

  async function status(
    link: PreparedSarConnect,
    statusOptions?: { signal?: AbortSignal },
  ): Promise<SarConnectResult> {
    if (link.expiresAt <= Date.now()) return { status: 'expired' };
    try {
      const value = await request(
        '',
        { method: 'GET', token: link.requestId },
        statusOptions?.signal,
      );
      return resultOf(matchContext(link, value));
    } catch (cause) {
      if (cause instanceof SarConnectError && cause.code === 'expired')
        return { status: 'expired' };
      throw cause;
    }
  }

  return {
    async prepare(input, auth) {
      const account = normalizeSarConnectAccount(input);
      const returnUrl = canonicalReturnUrl(input.returnUrl);
      const state = input.state ?? randomState();
      if (!SAR_CONNECT_STATE_PATTERN.test(state)) {
        throw new SarConnectError('invalid_account', 'state must be 16-128 URL-safe characters.');
      }
      const currencies = [
        ...(input.currencies ?? (account.platform === 'cashapp' ? ['USD'] : paypalCurrencies)),
      ];
      if (account.platform === 'cashapp' && (currencies.length !== 1 || currencies[0] !== 'USD')) {
        throw new SarConnectError('invalid_account', 'Cash App connections are USD only.');
      }
      if (!sarConnectCurrenciesSchema.safeParse(currencies).success) {
        throw new SarConnectError('invalid_account', 'currencies must be 1-20 distinct ISO codes.');
      }
      const body = {
        ...account,
        returnUrl,
        state,
        currencies,
        ...(auth
          ? {
              callerAddress: auth.callerAddress,
              ...(auth.expectedPayeeIdHash
                ? { expectedPayeeIdHash: auth.expectedPayeeIdHash }
                : {}),
            }
          : {}),
      };
      let response: unknown;
      try {
        response = await request(auth ? '' : '/checkout', {
          method: 'POST',
          body,
          ...(auth ? { token: auth.privyAccessToken } : {}),
        });
      } catch (cause) {
        // On create, a 401 is Privy rejecting the token, not an expired link.
        if (cause instanceof SarConnectError && cause.status === 401) {
          throw new SarConnectError('unauthorized', 'Curator rejected the Privy access token.', {
            status: 401,
          });
        }
        // On the Privy route, a 403 means callerAddress is not linked to that Privy user.
        if (auth && cause instanceof SarConnectError && cause.status === 403) {
          throw new SarConnectError(
            'unauthorized',
            'callerAddress is not a wallet linked to this Privy account.',
            { status: 403 },
          );
        }
        throw cause;
      }
      const created = sarConnectCreatedSchema.safeParse(response);
      if (!created.success) {
        throw new SarConnectError(
          'invalid_response',
          'Curator returned an invalid connection link.',
          {
            cause: created.error,
          },
        );
      }
      const { requestId, url } = created.data;
      const expiresAt = Number(created.data.expiresAt);
      if (
        requestId[0] !== ENVIRONMENT_PREFIX[environment] ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= Date.now()
      ) {
        throw new SarConnectError(
          'invalid_response',
          'Curator returned a link for another environment.',
        );
      }
      return {
        ...account,
        requestId,
        expiresAt,
        state,
        returnUrl,
        currencies,
        environment,
        url,
        appUrl: appUrlFrom(url, requestId),
      };
    },

    status,

    async wait(link, waitOptions = {}) {
      const pollIntervalMs = waitOptions.pollIntervalMs ?? DEFAULT_POLL_MS;
      const deadline =
        waitOptions.timeoutMs === undefined ? Infinity : Date.now() + waitOptions.timeoutMs;
      const { signal } = waitOptions;
      let latest: SarConnectResult = { status: 'pending' };
      let lastError: SarConnectError | undefined;
      let unconfirmedReads = 0;
      for (;;) {
        if (signal?.aborted) throw abortError();
        try {
          // `status` reports `expired` once the link's own expiry passes, which ends the loop.
          latest = await status(link, signal ? { signal } : undefined);
          lastError = undefined;
          if (latest.status === 'cancelled' || latest.status === 'expired') return latest;
          // Curator's own credential check decides; the session status alone is a hint.
          if (latest.status === 'connected') {
            if (await isConnected(link, signal)) return latest;
            if (++unconfirmedReads >= CONFIRM_ATTEMPTS) {
              throw new SarConnectError(
                'unconfirmed',
                'Curator reported the connection, but the account is not active yet. Check isSarConnected again shortly.',
              );
            }
          }
        } catch (cause) {
          // Keep waiting through blips, rate limits and 503s, as Peer Payouts does.
          if (
            !(cause instanceof SarConnectError) ||
            !cause.retryable ||
            cause.code === 'unconfirmed'
          ) {
            throw cause;
          }
          lastError = cause;
        }
        if (Date.now() + pollIntervalMs >= deadline) {
          if (lastError) throw lastError;
          // Never hand back `connected` that account status has not confirmed.
          return latest.status === 'connected' ? { status: 'connecting' } : latest;
        }
        await sleep(pollIntervalMs, signal);
      }
    },

    async cancel(link) {
      if (link.expiresAt <= Date.now()) return { status: 'expired' };
      try {
        const value = await request('', { method: 'DELETE', token: link.requestId });
        const result = resultOf(matchContext(link, value));
        if (result.status !== 'cancelled') {
          throw new SarConnectError('invalid_response', 'Curator did not cancel the connection.');
        }
        return result;
      } catch (cause) {
        if (cause instanceof SarConnectError && cause.code === 'expired')
          return { status: 'expired' };
        throw cause;
      }
    },

    isConnected: (account) =>
      isConnected({
        platform: account.platform,
        payeeHandle: normalizeSarPayeeHandle(account.platform, account.payeeHandle),
      }),
  };
}
