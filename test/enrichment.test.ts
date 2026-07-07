import { describe, expect, it } from 'vitest';
import { currencyInfo, getPaymentMethodsCatalog } from '@zkp2p/sdk';
import { deriveCashOrder, isFillLive } from '../src/engine/orderState';
import { derivePayouts } from '../src/engine/payouts';
import { deriveBuyerProfile } from '../src/engine/buyerProfile';
import { fiatFromUsdc, rateToNumber, fiatToNumber, centsToNumber } from '../src/engine/amounts';
import {
  orderFromJson,
  orderToJson,
  buyerProfileToJson,
  buyerProfileFromJson,
} from '../src/codecs';
import type { IntentEntity } from '../src/sdk-types';

const NOW = 1_800_000_000;
const USD_HASH = currencyInfo['USD']!.currencyCodeHash;
const EUR_HASH = currencyInfo['EUR']!.currencyCodeHash;
const RATE_0_92 = 920_000_000_000_000_000n; // 0.92 fiat per USDC, 1e18

function intent(seed: Partial<IntentEntity> & { intentHash: string }): IntentEntity {
  return {
    id: seed.intentHash,
    depositId: 'esc_1',
    status: 'SIGNALED',
    amount: '1000000',
    owner: '0xBuyer',
    fiatCurrency: USD_HASH,
    signalTimestamp: String(NOW - 600),
    ...seed,
  } as unknown as IntentEntity;
}

describe('fiat math (mirrors protocol clients)', () => {
  it('computes fiat from USDC at 1e18 rate, rounding UP to the cent', () => {
    // 1 USDC at 0.92 → 0.92 fiat exactly (6dp)
    expect(fiatFromUsdc(1_000_000n, RATE_0_92)).toBe(920_000n);
    // 1.005 USDC at 0.92 → 0.9246 → rounds up to 0.93
    expect(fiatFromUsdc(1_005_000n, RATE_0_92)).toBe(930_000n);
  });

  it('decodes rates, fiat units, and cents', () => {
    expect(rateToNumber(RATE_0_92)).toBeCloseTo(0.92, 12);
    expect(fiatToNumber(920_000n)).toBeCloseTo(0.92, 12);
    expect(centsToNumber(9_200n)).toBe(92);
  });
});

describe('fill enrichment', () => {
  it('decodes currency, locked rate, and fiat owed', () => {
    const order = deriveCashOrder(
      'esc_1',
      [
        intent({
          intentHash: '0xa',
          fiatCurrency: EUR_HASH,
          conversionRate: RATE_0_92.toString(),
          expiryTime: String(NOW + 3600),
        } as never),
      ],
      { remainingAmount: 4_000_000n, outstandingAmount: 1_000_000n, nowSeconds: NOW },
    );
    const fill = order.fills[0]!;
    expect(fill.currency).toBe('EUR');
    expect(fill.currencyHash).toBe(EUR_HASH);
    expect(fill.rate).toBeCloseTo(0.92, 12);
    expect(fill.conversionRate).toBe(RATE_0_92);
    expect(fill.fiatOwed).toBeCloseTo(0.92, 12);
  });

  it('surfaces the verified receipt on fulfilled fills', () => {
    const order = deriveCashOrder(
      'esc_1',
      [
        intent({
          intentHash: '0xa',
          status: 'FULFILLED',
          conversionRate: RATE_0_92.toString(),
          fulfillTimestamp: String(NOW - 100),
          paymentAmount: '92', // cents
          paymentCurrency: EUR_HASH,
          paymentTimestamp: String(NOW - 150),
          paymentId: 'REV-12345',
          releasedAmount: '1000000',
        } as never),
      ],
      { takenAmount: 1_000_000n, nowSeconds: NOW },
    );
    const fill = order.fills[0]!;
    expect(fill.fiatPaid).toBe(0.92);
    expect(fill.paidCurrency).toBe('EUR');
    expect(fill.paymentId).toBe('REV-12345');
    expect(fill.paidAt).toBe(NOW - 150);
    expect(fill.releasedAmount).toBe(1_000_000n);
    expect(fill.fillLatencySeconds).toBe(500); // signal NOW-600 → fulfill NOW-100
  });

  it('isFillLive honors the indexer isExpired flag even when the clock disagrees', () => {
    const liveByClock = {
      status: 'SIGNALED',
      expiresAt: NOW + 3600,
      isExpired: true,
    } as never;
    expect(isFillLive(liveByClock, NOW)).toBe(false);

    const liveBoth = { status: 'SIGNALED', expiresAt: NOW + 3600 } as never;
    expect(isFillLive(liveBoth, NOW)).toBe(true);

    const expiredByClock = { status: 'SIGNALED', expiresAt: NOW - 1 } as never;
    expect(isFillLive(expiredByClock, NOW)).toBe(false);
  });

  it('nextActions offers withdraw when the indexer flags the only intent expired', () => {
    const order = deriveCashOrder(
      'esc_1',
      [
        intent({
          intentHash: '0xa',
          isExpired: true,
          expiryTime: String(NOW + 3600), // reconciler ahead of a skewed clock
        } as never),
      ],
      { remainingAmount: 4_000_000n, outstandingAmount: 1_000_000n, nowSeconds: NOW },
    );
    expect(order.nextActions).toEqual(['wait', 'withdraw']);
  });
});

describe('derivePayouts', () => {
  const catalog = getPaymentMethodsCatalog(8453, 'production');
  const zelleHash = catalog['zelle']!.paymentMethodHash;

  it('decodes platform and currency from their hashes with the pricing proof', () => {
    const payouts = derivePayouts(
      [{ paymentMethodHash: zelleHash, payeeDetailsHash: '0xpayee', active: true }],
      [
        {
          paymentMethodHash: zelleHash,
          currencyCode: USD_HASH,
          spreadBps: 0,
          kind: 'oracle_chainlink',
          rateSource: 'ORACLE',
          oracleRate: '1000000000000000000',
          lastOracleUpdatedAt: String(NOW - 60),
        },
      ],
      catalog,
    );

    expect(payouts).toHaveLength(1);
    const payout = payouts[0]!;
    expect(payout.platform).toBe('zelle');
    expect(payout.currency).toBe('USD');
    expect(payout.payeeHash).toBe('0xpayee');
    expect(payout.pricing.marketRate).toBe(true); // the zero-spread invariant, verifiable
    expect(payout.pricing.spreadBps).toBe(0);
    expect(payout.pricing.oracleRate).toBeCloseTo(1, 12);
    expect(payout.pricing.lastOracleUpdatedAt).toBe(NOW - 60);
  });

  it('keeps raw hashes when the catalog cannot decode, and marketRate false off-oracle', () => {
    const payouts = derivePayouts(
      [{ paymentMethodHash: '0xdeadbeef', payeeDetailsHash: '0xp', active: false }],
      [{ paymentMethodHash: '0xdeadbeef', currencyCode: '0xunknown', spreadBps: 25, kind: null }],
      catalog,
    );
    const payout = payouts[0]!;
    expect(payout.platform).toBeUndefined();
    expect(payout.platformHash).toBe('0xdeadbeef');
    expect(payout.currency).toBeUndefined();
    expect(payout.currencyHash).toBe('0xunknown');
    expect(payout.active).toBe(false);
    expect(payout.pricing.marketRate).toBe(false);
    expect(payout.pricing.spreadBps).toBe(25);
  });
});

describe('deriveBuyerProfile', () => {
  it('aggregates the track record', () => {
    const profile = deriveBuyerProfile('0xBuYeR', [
      intent({ intentHash: '0x1', status: 'FULFILLED', signalTimestamp: String(NOW - 9000) }),
      intent({ intentHash: '0x2', status: 'FULFILLED', signalTimestamp: String(NOW - 5000) }),
      intent({
        intentHash: '0x3',
        status: 'MANUALLY_RELEASED',
        signalTimestamp: String(NOW - 4000),
      }),
      intent({ intentHash: '0x4', status: 'PRUNED', signalTimestamp: String(NOW - 3000) }),
      intent({ intentHash: '0x5', status: 'SIGNALED', signalTimestamp: String(NOW - 100) }),
    ]);

    expect(profile.address).toBe('0xbuyer');
    expect(profile.totalIntents).toBe(5);
    expect(profile.fulfilled).toBe(3);
    expect(profile.pruned).toBe(1);
    expect(profile.signaled).toBe(1);
    expect(profile.successRateBps).toBe(7500); // 3 of 4 settled
    expect(profile.firstSeenAt).toBe(NOW - 9000);
    expect(profile.lastSeenAt).toBe(NOW - 100);
  });

  it('omits successRateBps with no settled history', () => {
    const profile = deriveBuyerProfile('0xNew', [intent({ intentHash: '0x1' })]);
    expect(profile.successRateBps).toBeUndefined();
  });
});

describe('enriched codecs', () => {
  it('order with receipt fills + payouts round-trips losslessly', () => {
    const catalog = getPaymentMethodsCatalog(8453, 'production');
    const zelleHash = catalog['zelle']!.paymentMethodHash;
    const payouts = derivePayouts(
      [{ paymentMethodHash: zelleHash, payeeDetailsHash: '0xpayee', active: true }],
      [
        {
          paymentMethodHash: zelleHash,
          currencyCode: USD_HASH,
          spreadBps: 0,
          kind: 'oracle_chainlink',
          oracleRate: '1000000000000000000',
        },
      ],
      catalog,
    );
    const order = deriveCashOrder(
      'esc_1',
      [
        intent({
          intentHash: '0xa',
          status: 'FULFILLED',
          conversionRate: RATE_0_92.toString(),
          fulfillTimestamp: String(NOW - 100),
          paymentAmount: '92',
          paymentCurrency: USD_HASH,
          paymentId: 'ZELLE-1',
          releasedAmount: '1000000',
        } as never),
      ],
      { takenAmount: 1_000_000n, successRateBps: 10_000, payouts, nowSeconds: NOW },
    );

    const restored = orderFromJson(JSON.parse(JSON.stringify(orderToJson(order))));
    expect(restored.fills[0]?.conversionRate).toBe(RATE_0_92);
    expect(restored.fills[0]?.fiatPaid).toBe(0.92);
    expect(restored.fills[0]?.paymentId).toBe('ZELLE-1');
    expect(restored.fills[0]?.releasedAmount).toBe(1_000_000n);
    expect(restored.payouts?.[0]?.platform).toBe('zelle');
    expect(restored.payouts?.[0]?.pricing.marketRate).toBe(true);
    expect(restored.successRateBps).toBe(10_000);
    expect(restored.explain()).toBe(order.explain());
  });

  it('buyer profile round-trips', () => {
    const profile = deriveBuyerProfile('0xBuyer', [
      intent({ intentHash: '0x1', status: 'FULFILLED' }),
      intent({ intentHash: '0x2', status: 'PRUNED' }),
    ]);
    expect(buyerProfileFromJson(JSON.parse(JSON.stringify(buyerProfileToJson(profile))))).toEqual(
      profile,
    );
  });
});
