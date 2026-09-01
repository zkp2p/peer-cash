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

  it('requires peer-cash attribution for fixed Alipay/CNY deposits', () => {
    expect(isCashPayoutSet([payout()])).toBe(false);
    expect(isCashPayoutSet([payout()], true)).toBe(true);
  });

  it('does not let attribution admit another fixed corridor', () => {
    expect(isCashPayoutSet([payout({ platform: 'wise' })], true)).toBe(false);
  });
});
