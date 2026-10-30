import { describe, expect, it, vi } from 'vitest';
import {
  buildCapabilities,
  createCashClient,
  createSarConnectClient,
  detectSarConnectDevice,
  preparedSarConnectFromJson,
  preparedSarConnectToJson,
  sarConnectResultFromJson,
  sarConnectResultToJson,
  sarConnectUrlFor,
  SarConnectError,
  type PreparedSarConnect,
  type SarConnectInput,
} from '../src';

const PREPROD_API = 'https://api-preprod.zkp2p.xyz';
const requestId = `t${'A'.repeat(42)}`;
const returnUrl = 'https://peer-cash-appclip-demo.vercel.app/';
const payeeIdHash = `0x${'AB'.repeat(32)}`;

type Call = { url: string; init: RequestInit };

function envelope(responseObject: unknown, status = 200): Response {
  return Response.json(
    { success: true, message: 'ok', responseObject, statusCode: status },
    { status },
  );
}

function created(id = requestId, url = `https://mobile.peer.xyz/clip/connect?request=${id}`) {
  return envelope({ requestId: id, expiresAt: String(Date.now() + 900_000), url }, 201);
}

function curator(...responses: Array<Response | ((call: Call) => Response)>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${call.url}`);
    return typeof next === 'function' ? next(call) : next;
  });
  return { calls, client: createSarConnectClient({ environment: 'preproduction', fetch }) };
}

function body(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function headers(call: Call): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

function context(link: PreparedSarConnect, overrides: Record<string, unknown> = {}) {
  return {
    environment: 'preproduction',
    platform: link.platform,
    payeeHandle: link.payeeHandle,
    ...(link.platform === 'paypal' ? { paypalEmail: link.paypalEmail } : {}),
    callerAddress: `0x${'1'.repeat(40)}`,
    callerName: 'peer-cash-appclip-demo.vercel.app',
    returnUrl: link.returnUrl,
    state: link.state,
    currencies: link.currencies,
    expiresAt: String(link.expiresAt),
    status: 'pending',
    ...overrides,
  };
}

const cashApp: SarConnectInput = { platform: 'cashapp', payeeHandle: ' $Alice99 ', returnUrl };
const paypal: SarConnectInput = {
  platform: 'paypal',
  payeeHandle: '@Seller.Name',
  paypalEmail: ' Seller@Example.com ',
  returnUrl,
};

async function prepared(input: SarConnectInput = cashApp): Promise<PreparedSarConnect> {
  const { client } = curator(created());
  return client.prepare(input);
}

describe('SAR connect: create', () => {
  it('creates a wallet-free Cash App link with both mobile links', async () => {
    const { client, calls } = curator(created());
    const link = await client.prepare(cashApp);

    expect(calls[0]!.url).toBe(`${PREPROD_API}/v2/sar/connections/checkout`);
    expect(calls[0]!.init.method).toBe('POST');
    expect(headers(calls[0]!)).not.toHaveProperty('Authorization');
    const sent = body(calls[0]!);
    expect(sent).toEqual({
      platform: 'cashapp',
      payeeHandle: 'alice99',
      returnUrl,
      state: link.state,
      currencies: ['USD'],
    });
    expect(link.state).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(link).toMatchObject({
      platform: 'cashapp',
      payeeHandle: 'alice99',
      requestId,
      environment: 'preproduction',
      url: `https://mobile.peer.xyz/clip/connect?request=${requestId}`,
      appUrl: `https://mobile.peer.xyz/connect?request=${requestId}`,
    });
  });

  it('keeps the host Curator returned when building the Android link', async () => {
    const { client } = curator(
      created(requestId, `https://mobile-preprod.example/clip/connect?request=${requestId}`),
    );
    const link = await client.prepare(cashApp);
    expect(link.appUrl).toBe(`https://mobile-preprod.example/connect?request=${requestId}`);
  });

  it('creates a PayPal Personal link with the lowercased email and the PayPal catalog', async () => {
    const { client, calls } = curator(created());
    const link = await client.prepare(paypal);
    const sent = body(calls[0]!);
    const catalog = buildCapabilities('preproduction').platforms.find(
      (capability) => capability.platform === 'paypal',
    )!.currencies;
    expect(sent).toMatchObject({
      platform: 'paypal',
      payeeHandle: 'seller.name',
      paypalEmail: 'seller@example.com',
      currencies: catalog,
    });
    expect(sent).not.toHaveProperty('identityActionType');
    expect(link).toMatchObject({ paypalEmail: 'seller@example.com' });
  });

  it('passes PayPal Business through identityActionType', async () => {
    const { client, calls } = curator(created());
    await client.prepare({
      ...paypal,
      identityActionType: 'register_business_paypal',
      currencies: ['USD'],
    } as SarConnectInput);
    expect(body(calls[0]!)).toMatchObject({
      identityActionType: 'register_business_paypal',
      currencies: ['USD'],
    });
  });

  it('uses the Privy route with the caller wallet for wallet-owned links', async () => {
    const callerAddress = `0x${'2'.repeat(40)}` as const;
    const { client, calls } = curator(created());
    await client.prepare(cashApp, { privyAccessToken: 'privy-jwt', callerAddress });
    expect(calls[0]!.url).toBe(`${PREPROD_API}/v2/sar/connections`);
    expect(headers(calls[0]!).Authorization).toBe('Bearer privy-jwt');
    expect(body(calls[0]!)).toMatchObject({ callerAddress });
  });

  it('reports a rejected Privy token as unauthorized, not expired', async () => {
    const { client } = curator(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    await expect(
      client.prepare(cashApp, { privyAccessToken: 'bad', callerAddress: `0x${'2'.repeat(40)}` }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it.each([
    ['too long', { ...cashApp, payeeHandle: `$${'a'.repeat(21)}` }],
    ['punctuation', { ...cashApp, payeeHandle: '$alice.b' }],
    ['non-USD', { ...cashApp, currencies: ['EUR'] }],
    ['PayPal without email', { platform: 'paypal', payeeHandle: 'seller', returnUrl }],
    ['PayPal bad email', { ...paypal, paypalEmail: 'not-an-email' }],
    ['PayPal.Me link', { ...paypal, payeeHandle: 'paypal.me/seller' }],
    ['duplicate currencies', { ...paypal, currencies: ['USD', 'USD'] }],
    ['short state', { ...cashApp, state: 'short' }],
  ])('rejects %s before calling Curator', async (_label, input) => {
    const { client, calls } = curator();
    await expect(client.prepare(input as SarConnectInput)).rejects.toMatchObject({
      code: 'invalid_account',
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    'http://peer-cash-appclip-demo.vercel.app/',
    'https://peer-cash-appclip-demo.vercel.app/#done',
    'https://peer-cash-appclip-demo.vercel.app/?sarState=x',
    'https://user:pass@peer-cash-appclip-demo.vercel.app/',
    'not a url',
  ])('rejects return URL %s', async (bad) => {
    const { client, calls } = curator();
    await expect(client.prepare({ ...cashApp, returnUrl: bad })).rejects.toMatchObject({
      code: 'invalid_return_url',
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['a bare origin', 'https://partner.example', 'https://partner.example/'],
    ['an uppercase host', 'https://Partner.EXAMPLE/Connected', 'https://partner.example/Connected'],
    [
      'the default port',
      'https://partner.example:443/done?x=1',
      'https://partner.example/done?x=1',
    ],
  ])('sends and keeps %s as Curator stores it', async (_label, raw, canonical) => {
    let stored = '';
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const sent = JSON.parse(String(init.body)) as { returnUrl: string; state: string };
        stored = new URL(sent.returnUrl).toString(); // Curator's mint
        return created();
      }
      return envelope({
        environment: 'preproduction',
        platform: 'cashapp',
        payeeHandle: 'alice99',
        returnUrl: stored,
        state: link.state,
        expiresAt: String(link.expiresAt),
        status: 'pending',
      });
    });
    const client = createSarConnectClient({ environment: 'preproduction', fetch });
    const link = await client.prepare({ ...cashApp, returnUrl: raw });
    expect(link.returnUrl).toBe(canonical);
    expect(stored).toBe(canonical);
    await expect(client.status(link)).resolves.toEqual({ status: 'pending' });
  });

  it('names an unlinked wallet on the Privy route', async () => {
    const { client } = curator(new Response('', { status: 403 }));
    await expect(
      client.prepare(cashApp, { privyAccessToken: 'jwt', callerAddress: `0x${'2'.repeat(40)}` }),
    ).rejects.toMatchObject({ code: 'unauthorized', status: 403 });
  });

  it('names an unapproved return origin', async () => {
    const { client } = curator(
      Response.json(
        {
          success: false,
          message: 'Return URL is not an approved caller',
          responseObject: null,
          statusCode: 400,
          errorCode: 'return_url_is_not_an_approved_caller',
        },
        { status: 400 },
      ),
    );
    await expect(client.prepare(cashApp)).rejects.toMatchObject({
      code: 'invalid_return_url',
      status: 400,
      message: expect.stringContaining('SAR_CONNECT_RETURN_ORIGINS'),
    });
  });

  it('rejects a production capability from preproduction Curator', async () => {
    const { client } = curator(created(`p${'A'.repeat(42)}`));
    await expect(client.prepare(cashApp)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects an invocation URL for another request', async () => {
    const { client } = curator(
      created(requestId, `https://mobile.peer.xyz/clip/connect?request=t${'B'.repeat(42)}`),
    );
    await expect(client.prepare(cashApp)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([
    [429, 'rate_limited', true],
    [403, 'unavailable', false],
    [400, 'invalid_account', false],
    [503, 'request_failed', true],
  ] as const)('maps HTTP %i to %s', async (status, code, retryable) => {
    const { client } = curator(new Response('nope', { status }));
    const error = await client.prepare(cashApp).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SarConnectError);
    expect(error).toMatchObject({ code, retryable, status });
  });
});

describe('SAR connect: status, wait, cancel', () => {
  it('reads connected status with the capability as Bearer token', async () => {
    const link = await prepared();
    const { client, calls } = curator(
      envelope(context(link, { status: 'connected', payeeIdHash })),
    );
    await expect(client.status(link)).resolves.toEqual({
      status: 'connected',
      payeeIdHash: payeeIdHash.toLowerCase(),
    });
    expect(calls[0]!.url).toBe(`${PREPROD_API}/v2/sar/connections`);
    expect(calls[0]!.init.method).toBe('GET');
    expect(headers(calls[0]!).Authorization).toBe(`Bearer ${requestId}`);
  });

  it.each([401, 410])('treats HTTP %i as expired', async (status) => {
    const link = await prepared();
    const { client } = curator(new Response('', { status }));
    await expect(client.status(link)).resolves.toEqual({ status: 'expired' });
  });

  it('reports a locally expired link without calling Curator', async () => {
    const link = { ...(await prepared()), expiresAt: Date.now() - 1 };
    const { client, calls } = curator();
    await expect(client.status(link)).resolves.toEqual({ status: 'expired' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['state', { state: 'S'.repeat(32) }],
    ['environment', { environment: 'production' }],
    ['payout account', { payeeHandle: 'bob' }],
    ['return URL', { returnUrl: 'https://other.example/' }],
  ])('rejects a session with a different %s', async (_label, overrides) => {
    const link = await prepared();
    const { client } = curator(envelope(context(link, overrides)));
    await expect(client.status(link)).rejects.toMatchObject({ code: 'mismatch' });
  });

  it('rejects a PayPal session bound to another email', async () => {
    const link = await prepared(paypal);
    const { client } = curator(envelope(context(link, { paypalEmail: 'other@example.com' })));
    await expect(client.status(link)).rejects.toMatchObject({ code: 'mismatch' });
  });

  it('rejects connected without a payee hash', async () => {
    const link = await prepared();
    const { client } = curator(envelope(context(link, { status: 'connected' })));
    await expect(client.status(link)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('waits through pending and connecting, then confirms account status', async () => {
    const link = await prepared();
    const { client, calls } = curator(
      envelope(context(link)),
      envelope(context(link, { status: 'connecting' })),
      envelope(context(link, { status: 'connected', payeeIdHash })),
      envelope({ status: 'active' }),
    );
    await expect(client.wait(link, { pollIntervalMs: 1 })).resolves.toEqual({
      status: 'connected',
      payeeIdHash: payeeIdHash.toLowerCase(),
    });
    expect(calls[3]!.url).toBe(
      `${PREPROD_API}/v2/sar/connections/account-status?platform=cashapp&payeeHandle=alice99`,
    );
  });

  it('does not report connected until Curator account status is active', async () => {
    const link = await prepared();
    const connected = () => envelope(context(link, { status: 'connected', payeeIdHash }));
    const { client } = curator(
      connected(),
      envelope({ status: 'inactive' }),
      connected(),
      envelope({ status: 'inactive' }),
      connected(),
      envelope({ status: 'inactive' }),
    );
    await expect(client.wait(link, { pollIntervalMs: 1 })).rejects.toMatchObject({
      code: 'unconfirmed',
      retryable: true,
    });
  });

  it('keeps waiting through a 503, a rate limit and a network error', async () => {
    const link = await prepared();
    const { client } = curator(
      new Response('Connection storage is unavailable', { status: 503 }),
      new Response('Too many requests', { status: 429 }),
      () => {
        throw new TypeError('fetch failed');
      },
      envelope(context(link, { status: 'connected', payeeIdHash })),
      new Response('', { status: 503 }),
      envelope(context(link, { status: 'connected', payeeIdHash })),
      envelope({ status: 'active' }),
    );
    await expect(client.wait(link, { pollIntervalMs: 1 })).resolves.toEqual({
      status: 'connected',
      payeeIdHash: payeeIdHash.toLowerCase(),
    });
  });

  it('returns connecting, not connected, when timeoutMs ends before account status confirms', async () => {
    const link = await prepared();
    const { client } = curator(
      envelope(context(link, { status: 'connected', payeeIdHash })),
      envelope({ status: 'inactive' }),
    );
    await expect(client.wait(link, { pollIntervalMs: 50, timeoutMs: 10 })).resolves.toEqual({
      status: 'connecting',
    });
  });

  it('throws the last retryable error when timeoutMs ends a failing wait', async () => {
    const link = await prepared();
    const { client } = curator(new Response('', { status: 503 }));
    await expect(client.wait(link, { pollIntervalMs: 50, timeoutMs: 10 })).rejects.toMatchObject({
      code: 'request_failed',
      status: 503,
    });
  });

  it('rejects a mismatched session on the first poll', async () => {
    const link = await prepared();
    const { client, calls } = curator(envelope(context(link, { state: 'S'.repeat(32) })));
    await expect(client.wait(link, { pollIntervalMs: 1 })).rejects.toMatchObject({
      code: 'mismatch',
    });
    expect(calls).toHaveLength(1);
  });

  it('stops waiting when the link expires', async () => {
    const link = await prepared();
    const { client } = curator(new Response('', { status: 410 }));
    await expect(client.wait(link, { pollIntervalMs: 1 })).resolves.toEqual({ status: 'expired' });
  });

  it('returns the latest status when timeoutMs ends the wait first', async () => {
    const link = await prepared();
    const { client } = curator(envelope(context(link, { status: 'connecting' })));
    await expect(client.wait(link, { pollIntervalMs: 50, timeoutMs: 10 })).resolves.toEqual({
      status: 'connecting',
    });
  });

  it('stops waiting when Curator cancels the link', async () => {
    const link = await prepared();
    const { client } = curator(
      envelope(context(link)),
      envelope(context(link, { status: 'cancelled' })),
    );
    await expect(client.wait(link, { pollIntervalMs: 1 })).resolves.toEqual({
      status: 'cancelled',
    });
  });

  it('cancels a pending link', async () => {
    const link = await prepared();
    const { client, calls } = curator(envelope(context(link, { status: 'cancelled' })));
    await expect(client.cancel(link)).resolves.toEqual({ status: 'cancelled' });
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(headers(calls[0]!).Authorization).toBe(`Bearer ${requestId}`);
  });

  it('normalizes the account-status query like Curator', async () => {
    const { client, calls } = curator(
      envelope({ status: 'active' }),
      envelope({ status: 'inactive' }),
    );
    await expect(
      client.isConnected({ platform: 'cashapp', payeeHandle: ' $Alice ' }),
    ).resolves.toBe(true);
    await expect(client.isConnected({ platform: 'paypal', payeeHandle: '@Seller' })).resolves.toBe(
      false,
    );
    expect(calls.map((call) => new URL(call.url).search)).toEqual([
      '?platform=cashapp&payeeHandle=alice',
      '?platform=paypal&payeeHandle=seller',
    ]);
  });
});

describe('SAR connect: links per device', () => {
  const iPhoneSafari =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const iPhoneChrome =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1';
  const android =
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
  const desktop =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

  it.each([
    [iPhoneSafari, undefined, 'ios-safari'],
    [desktop, { platform: 'MacIntel', maxTouchPoints: 5 }, 'ios-safari'],
    [iPhoneChrome, undefined, 'other-mobile'],
    [android, undefined, 'other-mobile'],
    [desktop, { platform: 'MacIntel', maxTouchPoints: 0 }, 'desktop'],
  ] as const)('classifies %s', (userAgent, extra, device) => {
    expect(detectSarConnectDevice({ userAgent, ...extra })).toBe(device);
  });

  it('opens the App Clip on iPhone Safari and desktop QR, and the app elsewhere', async () => {
    const link = await prepared();
    expect(sarConnectUrlFor(link, 'ios-safari')).toBe(link.url);
    expect(sarConnectUrlFor(link, 'desktop')).toBe(link.url);
    expect(sarConnectUrlFor(link, 'other-mobile')).toBe(link.appUrl);
  });
});

describe('SAR connect: CashClient and codecs', () => {
  it('routes the client verbs to the environment Curator', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => created());
    const cash = createCashClient({ environment: 'preproduction', sarConnect: { fetch } });
    await cash.prepareSarConnect(cashApp);
    expect(String(fetch.mock.calls[0]![0])).toBe(`${PREPROD_API}/v2/sar/connections/checkout`);
  });

  it('honours an explicit curatorUrl', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => created());
    const cash = createCashClient({
      environment: 'preproduction',
      curatorUrl: 'https://curator.example/ignored-path',
      sarConnect: { fetch },
    });
    await cash.prepareSarConnect(cashApp);
    expect(String(fetch.mock.calls[0]![0])).toBe(
      'https://curator.example/v2/sar/connections/checkout',
    );
  });

  it('round-trips prepared links and results', async () => {
    for (const link of [await prepared(), await prepared(paypal)]) {
      const json = JSON.parse(JSON.stringify(preparedSarConnectToJson(link))) as unknown;
      expect(preparedSarConnectFromJson(json)).toEqual(link);
    }
    const result = { status: 'connected' as const, payeeIdHash: `0x${'ab'.repeat(32)}` as const };
    expect(sarConnectResultFromJson(sarConnectResultToJson(result))).toEqual(result);
    expect(() => preparedSarConnectFromJson({ platform: 'paypal' })).toThrow();
  });
});
