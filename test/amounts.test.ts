import { describe, expect, it } from 'vitest';
import { formatUsdc, usdc } from '../src/client/amounts';

describe('usdc()', () => {
  it('converts whole and fractional amounts', () => {
    expect(usdc(1000)).toBe(1_000_000_000n);
    expect(usdc('12.34')).toBe(12_340_000n);
    expect(usdc('0.000001')).toBe(1n);
    expect(usdc(0)).toBe(0n);
  });

  it('rejects malformed input', () => {
    expect(() => usdc('12.3456789')).toThrow(/decimals/);
    expect(() => usdc('abc')).toThrow(/Invalid/);
    expect(() => usdc('-5')).toThrow(/Invalid/);
  });
});

describe('formatUsdc()', () => {
  it('round-trips with usdc()', () => {
    expect(formatUsdc(usdc('12.34'))).toBe('12.34');
    expect(formatUsdc(usdc(1000))).toBe('1000');
    expect(formatUsdc(1n)).toBe('0.000001');
  });
});
