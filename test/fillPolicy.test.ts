import { describe, expect, it } from 'vitest';
import { resolveIntentAmountRange, type CashFillOptions } from '../src/client/fillPolicy';
import { usdc } from '../src/engine/amounts';

const venmo = [{ platform: 'venmo', currencies: ['USD'] }];
const presets = [
  [50, 50],
  [100, 100],
  [150, 150],
  [200, 200],
  [250, 250],
  [300, 300],
  [350, 350],
  [400, 400],
  [450, 450],
  [500, 500],
  [600, 300],
  [700, 350],
  [750, 250],
  [800, 400],
  [900, 300],
  [1000, 500],
  [1500, 500],
  [2000, 500],
  [2500, 500],
  [3000, 500],
  [3500, 500],
  [4000, 500],
  [4500, 500],
  [5000, 500],
  [5500, 500],
  [6000, 500],
  [6500, 500],
  [7000, 500],
  [7500, 500],
  [8000, 500],
  [8500, 500],
  [9000, 500],
  [9500, 500],
  [10000, 500],
] as const;

describe('fixed cash-out policy', () => {
  it.each(presets)('maps the approved $%i total to $%i tickets', (total, chunk) => {
    expect(resolveIntentAmountRange(usdc(total), {}, venmo)).toEqual({
      min: usdc(chunk),
      max: usdc(chunk),
    });
    expect(
      resolveIntentAmountRange(usdc(total), { fillMode: 'fixed', minChunkSize: usdc(50) }, venmo),
    ).toEqual({ min: usdc(chunk), max: usdc(chunk) });
  });

  it('rejects every unlisted $50 step, including mathematically divisible totals', () => {
    const allowed = new Set<number>(presets.map(([total]) => total));
    for (let total = 0; total <= 10_500; total += 50) {
      if (allowed.has(total)) continue;
      expect(() => resolveIntentAmountRange(usdc(total), {}, venmo)).toThrow(
        expect.objectContaining({ code: 'FIXED_AMOUNT_NOT_PRESET', retryable: false }),
      );
    }
  });

  it.each([-1n, 49_999_999n, 50_000_001n, 900_010_000n, 999_990_000n])(
    'rejects %s base units without rounding',
    (amount) => {
      expect(() => resolveIntentAmountRange(amount, {}, venmo)).toThrow(
        expect.objectContaining({ code: 'FIXED_AMOUNT_NOT_PRESET' }),
      );
    },
  );

  it.each(['venmo', 'paypal', 'cashapp'])('defaults %s/USD to fixed', (platform) => {
    expect(resolveIntentAmountRange(usdc(900), {}, [{ platform, currencies: ['USD'] }])).toEqual({
      min: usdc(300),
      max: usdc(300),
    });
  });

  it.each(['wise', 'revolut', 'zelle', 'chime', 'xmoney'])(
    'preserves flexible defaults for %s',
    (platform) => {
      expect(resolveIntentAmountRange(usdc(950), {}, [{ platform, currencies: ['USD'] }])).toEqual({
        min: usdc(1),
        max: usdc(950),
      });
    },
  );

  it('defaults to fixed only when every offered leg qualifies', () => {
    expect(
      resolveIntentAmountRange(usdc(900), {}, [
        ...venmo,
        { platform: 'cashapp', currencies: ['USD'] },
      ]),
    ).toEqual({ min: usdc(300), max: usdc(300) });
    for (const payouts of [
      [...venmo, { platform: 'wise', currencies: ['USD'] }],
      [{ platform: 'paypal', currencies: ['USD', 'EUR'] }],
      [{ platform: 'paypal', currencies: ['EUR'] }],
    ]) {
      expect(resolveIntentAmountRange(usdc(950), {}, payouts)).toEqual({
        min: usdc(1),
        max: usdc(950),
      });
    }
  });

  it('permits explicit fixed on other USD rails, but rejects non-USD legs', () => {
    expect(
      resolveIntentAmountRange(usdc(900), { fillMode: 'fixed' }, [
        { platform: 'wise', currencies: ['USD'] },
      ]),
    ).toEqual({ min: usdc(300), max: usdc(300) });
    expect(() =>
      resolveIntentAmountRange(usdc(900), { fillMode: 'fixed' }, [
        { platform: 'paypal', currencies: ['USD', 'EUR'] },
      ]),
    ).toThrow(expect.objectContaining({ code: 'FIXED_CURRENCY_UNSUPPORTED' }));
  });

  it('preserves flexible opt-out and existing explicit ranges', () => {
    expect(resolveIntentAmountRange(usdc(5), { fillMode: 'flexible' }, venmo)).toEqual({
      min: usdc(1),
      max: usdc(5),
    });
    expect(
      resolveIntentAmountRange(
        usdc(950),
        { intentAmountRange: { min: usdc(10), max: usdc(50) } },
        venmo,
      ),
    ).toEqual({ min: usdc(10), max: usdc(50) });
    expect(() =>
      resolveIntentAmountRange(
        usdc(950),
        { intentAmountRange: { min: usdc(50), max: usdc(10) } },
        venmo,
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_INTENT_AMOUNT_RANGE' }));
  });

  it.each([
    { fillMode: 'unknown' },
    { fillMode: 'fixed', intentAmountRange: { min: 1n, max: 1n } },
    { fillMode: 'fixed', intentAmount: usdc(300) },
    { minChunkSize: usdc(25) },
    { fillMode: 'flexible', minChunkSize: usdc(25) },
  ])('rejects invalid configuration %# from JavaScript callers', (options) => {
    expect(() => resolveIntentAmountRange(usdc(900), options as CashFillOptions, venmo)).toThrow(
      expect.objectContaining({ code: 'INVALID_FILL_CONFIGURATION' }),
    );
  });
});

describe('custom fixed chunk increments', () => {
  it.each([
    [25, 25, 25],
    [75, 25, 75],
    [525, 25, 175],
    [650, 25, 325],
    [900, 25, 450],
    [950, 25, 475],
    [10000, 25, 500],
    [600, 100, 300],
    [900, 75, 450],
    [1500, 300, 300],
    [10000, 500, 500],
  ])('sizes $%i with a $%i increment into $%i chunks', (total, increment, chunk) => {
    expect(
      resolveIntentAmountRange(
        usdc(total),
        {
          fillMode: 'fixed',
          minChunkSize: usdc(increment),
        },
        venmo,
      ),
    ).toEqual({ min: usdc(chunk), max: usdc(chunk) });
  });

  it.each([0n, 24_000_000n, 575_000_000n, 950_000_001n, 10_500_000_000n])(
    'rejects %s rather than rounding or producing too many payments',
    (amount) => {
      expect(() =>
        resolveIntentAmountRange(
          amount,
          {
            fillMode: 'fixed',
            minChunkSize: usdc(25),
          },
          venmo,
        ),
      ).toThrow(expect.objectContaining({ code: 'FIXED_AMOUNT_UNSPLITTABLE' }));
    },
  );

  it('does not relax the default presets when 50 is explicitly supplied', () => {
    expect(() =>
      resolveIntentAmountRange(
        usdc(950),
        {
          fillMode: 'fixed',
          minChunkSize: usdc(50),
        },
        venmo,
      ),
    ).toThrow(expect.objectContaining({ code: 'FIXED_AMOUNT_NOT_PRESET' }));
  });

  it.each([0n, -1n, 25_000_001n, 501_000_000n, null, '25000000', 25])(
    'rejects invalid increment %s',
    (minChunkSize) => {
      expect(() =>
        resolveIntentAmountRange(
          usdc(900),
          {
            fillMode: 'fixed',
            minChunkSize,
          } as CashFillOptions,
          venmo,
        ),
      ).toThrow(expect.objectContaining({ code: 'INVALID_MIN_CHUNK_SIZE' }));
    },
  );
});
