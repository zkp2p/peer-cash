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

  it('is synchronous and deterministic', () => {
    const a = buildCapabilities('production');
    const b = buildCapabilities('production');
    expect(JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(
      JSON.stringify(b, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
  });
});
