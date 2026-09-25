import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSarLink, readSarAccountStatus, readSarResult, restoreSarLink, saveSarLink } from './sar';

const requestId = `p${'A'.repeat(42)}`;
const apiBase = 'https://api.zkp2p.xyz';
const returnUrl = 'https://demo.peer.xyz/';

afterEach(() => vi.unstubAllGlobals());

describe('wallet-free App Clip SAR handoff', () => {
  it('mints a UPI request without Privy or a client-selected wallet', async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.zkp2p.xyz/v2/sar/connections/checkout');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({
        platform: 'upi', payeeHandle: '7014748022@apl', returnUrl, currencies: ['INR'],
      });
      expect(body).not.toHaveProperty('callerAddress');
      expect(body.state).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
      return Response.json({ success: true, responseObject: {
        requestId, expiresAt: String(Date.now() + 600_000),
        url: `https://mobile.peer.xyz/clip/connect?request=${requestId}`,
      } }, { status: 201 });
    });
    vi.stubGlobal('fetch', fetcher);
    const link = await createSarLink({ apiBase, platform: 'upi', payeeHandle: '7014748022@apl', returnUrl });
    expect(link.url).toBe(`https://mobile.peer.xyz/clip/connect?request=${requestId}`);
    expect(link.url).not.toContain('7014748022');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('accepts a preprod link and validates its matching status environment', async () => {
    const preprodId = `t${'A'.repeat(42)}`;
    const preprodApi = 'https://api-preprod.zkp2p.xyz';
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'POST') return Response.json({ success: true, responseObject: {
        requestId: preprodId, expiresAt: String(Date.now() + 600_000),
        url: `https://mobile.peer.xyz/clip/connect?request=${preprodId}`,
      } }, { status: 201 });
      return Response.json({ success: true, responseObject: {
        environment: 'preproduction', platform: 'upi', payeeHandle: '7014748022@apl',
        state: 'S'.repeat(36), returnUrl, status: 'connected', payeeIdHash: `0x${'a'.repeat(64)}`,
      } });
    });
    vi.stubGlobal('fetch', fetcher);
    const link = await createSarLink({
      apiBase: preprodApi, platform: 'upi', payeeHandle: '7014748022@apl', returnUrl,
    });
    expect(await readSarResult(preprodApi, { ...link, state: 'S'.repeat(36) })).toMatchObject({
      status: 'connected', payeeIdHash: `0x${'a'.repeat(64)}`,
    });
  });

  it('rejects a production link returned by preprod Curator', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, responseObject: {
      requestId, expiresAt: String(Date.now() + 600_000),
      url: `https://mobile.peer.xyz/clip/connect?request=${requestId}`,
    } }, { status: 201 })));
    await expect(createSarLink({
      apiBase: 'https://api-preprod.zkp2p.xyz', platform: 'upi', payeeHandle: '7014748022@apl', returnUrl,
    })).rejects.toThrow('invalid connection link');
  });

  it('rejects a link that opens a different App Clip destination', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, responseObject: {
      requestId, expiresAt: String(Date.now() + 600_000),
      url: `https://another.example/clip/connect?request=${requestId}`,
    } }, { status: 201 })));
    await expect(createSarLink({
      apiBase, platform: 'upi', payeeHandle: '7014748022@apl', returnUrl,
    })).rejects.toThrow('invalid connection link');
  });

  it('carries the selected PayPal username and email without a wallet token', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toMatchObject({
        platform: 'paypal', payeeHandle: 'rzl195', paypalEmail: 'seller@example.com',
      });
      expect(init.headers).not.toHaveProperty('Authorization');
      return Response.json({ success: true, responseObject: {
        requestId, expiresAt: String(Date.now() + 600_000),
        url: `https://mobile.peer.xyz/clip/connect?request=${requestId}`,
      } }, { status: 201 });
    });
    vi.stubGlobal('fetch', fetcher);
    const link = await createSarLink({
      apiBase, platform: 'paypal', payeeHandle: 'rzl195', paypalEmail: 'seller@example.com', returnUrl,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const data = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
    });
    saveSarLink(link);
    expect(restoreSarLink(apiBase, new URL(returnUrl).origin)).toEqual(link);
  });

  it('rejects a PayPal result with a different receipt email', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, responseObject: {
      platform: 'paypal', payeeHandle: 'rzl195', paypalEmail: 'another@example.com',
      environment: 'production', state: 'S'.repeat(36), returnUrl, status: 'connected',
      payeeIdHash: `0x${'a'.repeat(64)}`,
    } })));
    await expect(readSarResult(apiBase, {
      requestId, platform: 'paypal', payeeHandle: 'rzl195', paypalEmail: 'seller@example.com',
      returnUrl, state: 'S'.repeat(36), expiresAt: Date.now() + 600_000,
      url: `https://mobile.peer.xyz/clip/connect?request=${requestId}`,
    })).rejects.toThrow('does not belong');
  });

  it('reads account-level availability without authentication', async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(new URL(url).pathname).toBe('/v2/sar/connections/account-status');
      expect(new URL(url).searchParams.get('payeeHandle')).toBe('rzl195');
      expect(init.headers).toBeUndefined();
      return Response.json({ success: true, responseObject: { status: 'active' } });
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await readSarAccountStatus(apiBase, 'paypal', 'rzl195')).toBe('active');
  });

  it('rejects a connected result for another account or environment', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, responseObject: {
      platform: 'upi', payeeHandle: 'another@bank', environment: 'production', state: 'S'.repeat(36), returnUrl,
      status: 'connected', payeeIdHash: `0x${'a'.repeat(64)}`,
    } })));
    await expect(readSarResult(apiBase, {
      requestId, platform: 'upi', payeeHandle: '7014748022@apl', returnUrl,
      state: 'S'.repeat(36), expiresAt: Date.now() + 600_000,
      url: `https://mobile.peer.xyz/clip/connect?request=${requestId}`,
    })).rejects.toThrow('does not belong');
  });
});
