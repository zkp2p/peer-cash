import { describe, expect, it } from 'vitest';

import { RevenueTracker } from './revenue.js';

describe('RevenueTracker', () => {
  it('deduplicates settlement references', () => {
    const revenue = new RevenueTracker(10_000_000n);

    expect(revenue.record('0xabc', 6_000_000n)).toBe(true);
    expect(revenue.record('0xabc', 6_000_000n)).toBe(false);
    expect(revenue.snapshot()).toEqual({
      available: 6_000_000n,
      ready: false,
      reserved: 0n,
      settled: 6_000_000n,
      threshold: 10_000_000n,
    });
  });

  it('reserves only confirmed, unreserved revenue', () => {
    const revenue = new RevenueTracker(5_000_000n);
    revenue.record('0xabc', 7_000_000n);
    revenue.reserve(5_000_000n);

    expect(revenue.snapshot().available).toBe(2_000_000n);
    expect(() => revenue.reserve(3_000_000n)).toThrow(/exceeds unreserved settlements/);

    revenue.release(5_000_000n);
    expect(revenue.snapshot().available).toBe(7_000_000n);
  });
});
