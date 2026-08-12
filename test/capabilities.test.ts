import { describe, expect, it } from 'vitest';
import { buildCapabilities } from '../src/client/capabilities';
import { isMarketRateSupported } from '../src/engine/marketRate';

describe('buildCapabilities', () => {
  for (const env of ['production', 'staging'] as const) {
    it(`${env}: advertises only oracle-priced corridors`, () => {
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
        for (const currency of platform.currencies) {
          expect(isMarketRateSupported(currency)).toBe(true);
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

  it('flags Wise and PayPal as requiring an identity attestation; others do not', () => {
    const caps = buildCapabilities('production');
    for (const platform of caps.platforms) {
      const expected = platform.platform === 'wise' || platform.platform === 'paypal';
      expect(platform.requiresIdentityAttestation).toBe(expected);
    }
    // both must be present so the flag is observable
    expect(caps.platforms.some((p) => p.platform === 'wise')).toBe(true);
    expect(caps.platforms.some((p) => p.platform === 'paypal')).toBe(true);
  });

  it('is synchronous and deterministic', () => {
    const a = buildCapabilities('production');
    const b = buildCapabilities('production');
    expect(JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(
      JSON.stringify(b, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
  });
});
