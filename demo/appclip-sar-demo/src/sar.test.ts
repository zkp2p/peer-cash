import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSarLink, readActiveSarAccounts, readSarAccountStatus, readSarResult } from './sar';

const wallet = '0x1111111111111111111111111111111111111111' as const;
const requestId = `p${'A'.repeat(42)}`;
const apiBase = 'https://api.zkp2p.xyz';
const returnUrl = 'https://demo.peer.xyz/';

afterEach(() => vi.unstubAllGlobals());

describe('App Clip SAR capability handoff', () => {
  it('mints a production UPI request with a Privy bearer token and no credential in its URL', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer privy-token');
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({
        platform: 'upi', payeeHandle: '7014748022@apl', callerAddress: wallet, returnUrl, currencies: ['INR'],
      });
      expect(body.state).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
      return Response.json({ success: true, responseObject: {
        requestId, expiresAt: String(Date.now() + 600_000),
      } }, { status: 201 });
    });
    vi.stubGlobal('fetch', fetcher);
    const link = await createSarLink({
      apiBase, platform: 'upi', payeeHandle: '7014748022@apl', callerAddress: wallet, accessToken: 'privy-token', returnUrl,
    });
    expect(link.url).toBe(`https://mobile.peer.xyz/clip/connect?request=${requestId}`);
    expect(link.url).not.toContain('privy-token');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('carries the selected PayPal username and email in the scoped request body', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toMatchObject({
        platform: 'paypal', payeeHandle: 'rzl195', paypalEmail: 'seller@example.com',
      });
      return Response.json({ success: true, responseObject: {
        requestId, expiresAt: String(Date.now() + 600_000),
      } }, { status: 201 });
    });
    vi.stubGlobal('fetch', fetcher);
    await createSarLink({
      apiBase, platform: 'paypal', payeeHandle: 'rzl195', paypalEmail: 'seller@example.com',
      callerAddress: wallet, accessToken: 'privy-token', returnUrl,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('reads account-level availability without a wallet token or owner identity', async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(new URL(url).pathname).toBe('/v2/sar/connections/account-status');
      expect(new URL(url).searchParams.get('platform')).toBe('paypal');
      expect(new URL(url).searchParams.get('payeeHandle')).toBe('rzl195');
      expect(init.headers).toBeUndefined();
      return Response.json({ success: true, responseObject: { status: 'active' } });
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await readSarAccountStatus(apiBase, 'paypal', 'rzl195')).toBe('active');
  });

  it('does not accept a connected result for another wallet or environment', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, responseObject: {
      platform: 'upi', payeeHandle: '7014748022@apl', environment: 'production', state: 'S'.repeat(36), returnUrl,
      callerAddress: '0x2222222222222222222222222222222222222222', status: 'connected',
      payeeIdHash: `0x${'a'.repeat(64)}`,
    } })));
    await expect(readSarResult(apiBase, {
      requestId, platform: 'upi', payeeHandle: '7014748022@apl', callerAddress: wallet, returnUrl,
      state: 'S'.repeat(36), expiresAt: Date.now() + 600_000,
      url: `https://mobile.peer.xyz/clip/connect?request=${requestId}`,
    })).rejects.toThrow('does not belong');
  });

  it('reads only active, unrevoked accounts from the authenticated maker profile', async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.zkp2p.xyz/v2/me');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer privy-token');
      return Response.json({ success: true, responseObject: { profile: null, connectedAccounts: [
        { platform: 'upi', offchainId: '7014748022@apl', payeeIdHash: `0x${'a'.repeat(64)}`,
          credentialStatus: 'active', revoked: false },
        { platform: 'paypal', offchainId: 'old-account', payeeIdHash: `0x${'b'.repeat(64)}`,
          credentialStatus: 'inactive', revoked: false },
        { platform: 'cashapp', offchainId: '$revoked', payeeIdHash: `0x${'c'.repeat(64)}`,
          credentialStatus: 'active', revoked: true },
        { platform: 'venmo', offchainId: '@other', payeeIdHash: `0x${'d'.repeat(64)}`,
          credentialStatus: 'active', revoked: false },
      ] } });
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await readActiveSarAccounts(apiBase, 'privy-token')).toEqual([{
      platform: 'upi', offchainId: '7014748022@apl', payeeIdHash: `0x${'a'.repeat(64)}`,
    }]);
  });
});
