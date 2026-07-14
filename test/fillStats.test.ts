import { describe, expect, it, vi } from 'vitest';
import { currencyInfo, getPaymentMethodsCatalog } from '@zkp2p/sdk';
import {
  computeFillStats,
  FILL_STATS_WINDOW_SECONDS,
  readFillStats,
  type FillStatsDepositLike,
} from '../src/client/fillEta';

const NOW = 1_800_000_000;
const CREATED = NOW - 10 * 24 * 60 * 60;
const catalog = getPaymentMethodsCatalog(8453, 'staging');
const hashes = Object.fromEntries(
  Object.entries(catalog).map(([method, entry]) => [method, entry.paymentMethodHash]),
) as Record<string, string>;
const USD_HASH = currencyInfo['USD']!.currencyCodeHash;

type Fill = {
  method: string;
  currency: string;
  at: number;
};

function deposit(createdAt: number, fills: Fill[]): FillStatsDepositLike {
  return {
    timestamp: createdAt,
    intents: fills.map(({ method, currency, at }) => ({
      paymentMethodHash: hashes[method]!,
      fiatCurrency: currency,
      fulfillTimestamp: at,
    })),
  };
}

describe('computeFillStats', () => {
  it('attributes a fill only to the intent pair, not sibling methods advertised by the deposit', () => {
    const row = {
      ...deposit(CREATED, [{ method: 'venmo', currency: 'USD', at: CREATED + 60 }]),
      paymentMethods: [
        { paymentMethodHash: hashes['venmo'] },
        { paymentMethodHash: hashes['revolut'] },
      ],
      currencies: [
        { paymentMethodHash: hashes['venmo'], currencyCode: USD_HASH },
        { paymentMethodHash: hashes['revolut'], currencyCode: USD_HASH },
      ],
    };

    const stats = computeFillStats([row], NOW, 'staging');

    expect(stats['venmo:USD']).toEqual({ fills: 1, medianFillSeconds: 60 });
    expect(stats['revolut:USD']).toBeUndefined();
  });

  it('aggregates bank-scoped Zelle variants into one base-platform pair', () => {
    const stats = computeFillStats(
      [
        deposit(CREATED, [{ method: 'zelle-chase', currency: 'USD', at: CREATED + 100 }]),
        deposit(CREATED, [{ method: 'zelle-bofa', currency: 'USD', at: CREATED + 300 }]),
        deposit(CREATED, [{ method: 'zelle-citi', currency: 'USD', at: CREATED + 500 }]),
      ],
      NOW,
      'staging',
    );

    expect(stats).toEqual({ 'zelle:USD': { fills: 3, medianFillSeconds: 300 } });
  });

  it('normalizes both bytes32 currency hashes and plain currency codes', () => {
    const stats = computeFillStats(
      [
        deposit(CREATED, [{ method: 'venmo', currency: USD_HASH, at: CREATED + 100 }]),
        deposit(CREATED, [{ method: 'venmo', currency: 'usd', at: CREATED + 300 }]),
      ],
      NOW,
      'staging',
    );

    expect(stats['venmo:USD']).toEqual({ fills: 2, medianFillSeconds: 200 });
  });

  it('counts every fill but samples each deposit at its first pair fill for the median', () => {
    const stats = computeFillStats(
      [
        deposit(CREATED, [
          { method: 'revolut', currency: 'EUR', at: CREATED + 400 },
          { method: 'revolut', currency: 'EUR', at: CREATED + 100 },
        ]),
        deposit(CREATED, [{ method: 'revolut', currency: 'EUR', at: CREATED + 300 }]),
      ],
      NOW,
      'staging',
    );

    expect(stats['revolut:EUR']).toEqual({ fills: 3, medianFillSeconds: 200 });
  });

  it('includes the exact window boundary and omits latency for older deposits', () => {
    const windowStart = NOW - FILL_STATS_WINDOW_SECONDS;
    const stats = computeFillStats(
      [
        deposit(windowStart, [{ method: 'venmo', currency: 'USD', at: windowStart }]),
        deposit(windowStart - 100, [
          { method: 'revolut', currency: 'EUR', at: windowStart },
          { method: 'wise', currency: 'GBP', at: windowStart - 1 },
        ]),
      ],
      NOW,
      'staging',
    );

    expect(stats['venmo:USD']).toEqual({ fills: 1, medianFillSeconds: 0 });
    expect(stats['revolut:EUR']).toEqual({ fills: 1 });
    expect(stats['wise:GBP']).toBeUndefined();
  });
});

describe('readFillStats', () => {
  it('uses the shared paginated query and stops when a full page exits the window', async () => {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - FILL_STATS_WINDOW_SECONDS;
    const page = Array.from({ length: 250 }, (_, index) =>
      deposit(windowStart - index - 1, [
        { method: 'venmo', currency: 'USD', at: windowStart + 60 + index },
      ]),
    );
    const getDepositsWithRelations = vi.fn(async () => page);
    const client = { indexer: { getDepositsWithRelations } };

    const stats = await readFillStats(client as never, 'staging');

    expect(stats['venmo:USD']?.fills).toBe(250);
    expect(stats['venmo:USD']?.medianFillSeconds).toBeUndefined();
    expect(getDepositsWithRelations).toHaveBeenCalledOnce();
    expect(getDepositsWithRelations).toHaveBeenCalledWith(
      { chainId: 8453 },
      { limit: 250, offset: 0, orderBy: 'timestamp', orderDirection: 'desc' },
      { includeIntents: true, intentStatuses: ['FULFILLED', 'MANUALLY_RELEASED'] },
    );
  });
});
