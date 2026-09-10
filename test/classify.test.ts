import { describe, expect, it } from 'vitest';
import { isCashPayoutSet } from '../src/client/classify';
import type { CashPayoutInfo } from '../src/engine/types';

function payout(overrides: Partial<CashPayoutInfo> = {}): CashPayoutInfo {
  return {
    platform: 'alipay',
    platformHash: '0xplatform',
    currency: 'CNY',
    currencyHash: '0xcurrency',
    payeeHash: '0xpayee',
    active: true,
    pricing: { marketRate: false, fixedAtCreation: true, fixedRate: 6.72 },
    ...overrides,
  };
}

describe('Cash payout classification', () => {
  it('keeps zero-spread oracle deposits structurally resumable', () => {
    expect(
      isCashPayoutSet([
        payout({
          platform: 'venmo',
          currency: 'USD',
          pricing: { marketRate: true, spreadBps: 0, kind: 'oracle_chainlink' },
        }),
      ]),
    ).toBe(true);
  });

  it.each([
    ['alipay', 'CNY'],
    ['upi', 'INR'],
  ])('requires peer-cash attribution for fixed %s/%s deposits', (platform, currency) => {
    const rows = [payout({ platform, currency })];
    expect(isCashPayoutSet(rows)).toBe(false);
    expect(isCashPayoutSet(rows, true)).toBe(true);
  });

  it('rejects UPI with the wrong currency or missing creation-rate evidence', () => {
    expect(isCashPayoutSet([payout({ platform: 'upi', currency: 'CNY' })], true)).toBe(false);
    for (const pricing of [
      { marketRate: false, fixedRate: 95 },
      { marketRate: false, fixedAtCreation: true, fixedRate: 0 },
    ]) {
      expect(isCashPayoutSet([payout({ platform: 'upi', currency: 'INR', pricing })], true)).toBe(
        false,
      );
    }
  });

  it('does not let attribution admit another fixed corridor', () => {
    expect(isCashPayoutSet([payout({ platform: 'wise' })], true)).toBe(false);
  });
});
