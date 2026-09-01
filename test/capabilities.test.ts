import { describe, expect, it } from 'vitest';
import { buildCapabilities, platformRequiresIdentityAttestation } from '../src/client/capabilities';
import { isCashCorridorSupported } from '../src/engine/marketRate';

describe('buildCapabilities', () => {
  for (const env of ['production', 'staging'] as const) {
    it(`${env}: advertises only supported Cash corridors`, () => {
      const caps = buildCapabilities(env);

      expect(caps.chainId).toBe(8453);
      expect(caps.token.symbol).toBe('USDC');
      expect(caps.token.decimals).toBe(6);
      expect(caps.destination).toEqual({ chainId: 8453, token: caps.token });
      expect(caps.source.default).toEqual({ chainId: 8453, token: caps.token });
      expect(caps.source.relay).toBeUndefined();
      expect(caps.pricing).toEqual({ kind: 'oracle-market-rate', spreadBps: 0 });
      expect(caps.amount.min).toBe(10_000n);
      expect(caps.amount.recommendedMin).toBe(1_000_000n);

      expect(caps.platforms.length).toBeGreaterThan(0);
      for (const platform of caps.platforms) {
        expect(platform.currencies.length).toBeGreaterThan(0);
        expect(platform.payeeHint.length).toBeGreaterThan(0);
        expect(platform.requiresAtomicAccessPolicy).toBe(false);
        for (const currency of platform.currencies) {
          expect(isCashCorridorSupported(platform.platform, currency)).toBe(true);
          expect(platform.pricing[currency]).toBeDefined();
        }
      }

      expect(caps.currencies.length).toBeGreaterThan(0);
    });
  }

  it('includes the flagship venmo/USD corridor', () => {
    const caps = buildCapabilities('staging');
    const venmo = caps.platforms.find((p) => p.platform === 'venmo');
    expect(venmo).toBeDefined();
    expect(venmo?.currencies).toContain('USD');
  });

  it('keeps staging UPI fail-closed unless explicitly enabled', () => {
    expect(buildCapabilities('production', { upi: true }).platforms).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ platform: 'upi' })]),
    );
    expect(buildCapabilities('staging').platforms).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ platform: 'upi' })]),
    );
    expect(buildCapabilities('staging', { upi: true }).platforms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: 'upi',
          currencies: ['INR'],
          payeeHint: 'Any valid UPI ID from any bank (e.g. seller@bank)',
          requiresIdentityAttestation: false,
        }),
      ]),
    );
  });

  it('presents generic Zelle as one platform', () => {
    const caps = buildCapabilities('production');
    const zelle = caps.platforms.filter((platform) => platform.platform.startsWith('zelle'));

    expect(zelle).toEqual([
      expect.objectContaining({
        platform: 'zelle',
        currencies: expect.arrayContaining(['USD']),
      }),
    ]);
  });

  it('flags Wise, PayPal, and Alipay as requiring an identity attestation', () => {
    const caps = buildCapabilities('production');
    for (const platform of caps.platforms) {
      const expected = ['wise', 'paypal', 'alipay'].includes(platform.platform);
      expect(platform.requiresIdentityAttestation).toBe(expected);
    }
    // both must be present so the flag is observable
    expect(caps.platforms.some((p) => p.platform === 'wise')).toBe(true);
    expect(caps.platforms.some((p) => p.platform === 'paypal')).toBe(true);
    expect(caps.platforms.some((p) => p.platform === 'alipay')).toBe(true);
    expect(platformRequiresIdentityAttestation('ALIPAY')).toBe(true);
  });

  it('advertises Alipay/CNY as a creation-time Chainlink snapshot', () => {
    const alipay = buildCapabilities('production').platforms.find((p) => p.platform === 'alipay');
    expect(alipay).toMatchObject({
      currencies: ['CNY'],
      payeeHint: 'Email address linked to your Alipay account',
      requiresIdentityAttestation: true,
      pricing: {
        CNY: {
          kind: 'fixed-at-deposit-creation',
          source: 'chainlink-ethereum',
          spreadBps: 0,
        },
      },
    });
  });

  it('is synchronous and deterministic', () => {
    const a = buildCapabilities('production');
    const b = buildCapabilities('production');
    expect(JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(
      JSON.stringify(b, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
  });
});
