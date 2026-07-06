import { describe, expect, it } from 'vitest';
import { deriveCashOrder, explainOrder } from '../src/engine/orderState';
import type { IntentEntity } from '../src/sdk-types';

const NOW = 1_800_000_000; // fixed clock for expiry-sensitive assertions

type IntentSeed = Partial<IntentEntity> & { intentHash: string; status: IntentEntity['status'] };

function intent(seed: IntentSeed): IntentEntity {
  return {
    id: seed.intentHash,
    depositId: 'esc_1',
    orchestratorAddress: '0xorch',
    verifier: '0xver',
    owner: '0xBuYeR',
    toAddress: '0xto',
    amount: '1000000',
    fiatCurrency: 'USD',
    conversionRate: '1000000000000000000',
    signalTimestamp: String(NOW - 600),
    blockNumber: '1',
    timestamp: String(NOW - 600),
    txHash: '0xtx',
    ...seed,
  } as IntentEntity;
}

describe('deriveCashOrder — state transitions', () => {
  it('awaiting-buyer: live funds, no intents', () => {
    const order = deriveCashOrder('esc_1', [], {
      remainingAmount: 5_000_000n,
      status: 'ACTIVE',
      nowSeconds: NOW,
    });
    expect(order.state).toBe('awaiting-buyer');
    expect(order.totalAmount).toBe(5_000_000n);
    expect(order.isInFlight).toBe(true);
    expect(order.nextActions).toEqual(['wait', 'withdraw']);
  });

  it('matched: one live signaled intent, nothing taken yet', () => {
    const order = deriveCashOrder(
      'esc_1',
      [intent({ intentHash: '0xa', status: 'SIGNALED', expiryTime: String(NOW + 3600) })],
      {
        remainingAmount: 4_000_000n,
        outstandingAmount: 1_000_000n,
        status: 'ACTIVE',
        nowSeconds: NOW,
      },
    );
    expect(order.state).toBe('matched');
    expect(order.pendingAmount).toBe(1_000_000n);
    expect(order.primaryIntentHash).toBe('0xa');
    expect(order.matchedAt).toBe(NOW - 600);
    // funds locked by a live intent — withdrawal is not offered
    expect(order.nextActions).toEqual(['wait']);
  });

  it('matched with EXPIRED intent: withdraw becomes available (prune-then-withdraw)', () => {
    const order = deriveCashOrder(
      'esc_1',
      [intent({ intentHash: '0xa', status: 'SIGNALED', expiryTime: String(NOW - 60) })],
      {
        remainingAmount: 4_000_000n,
        outstandingAmount: 1_000_000n,
        status: 'ACTIVE',
        nowSeconds: NOW,
      },
    );
    expect(order.state).toBe('matched');
    expect(order.nextActions).toEqual(['wait', 'withdraw']);
  });

  it('delivering: partial fill — some taken, live funds remain', () => {
    const order = deriveCashOrder(
      'esc_1',
      [
        intent({ intentHash: '0xa', status: 'FULFILLED', fulfillTimestamp: String(NOW - 100) }),
        intent({ intentHash: '0xb', status: 'SIGNALED', expiryTime: String(NOW + 3600) }),
      ],
      {
        remainingAmount: 3_000_000n,
        outstandingAmount: 1_000_000n,
        takenAmount: 1_000_000n,
        status: 'ACTIVE',
        nowSeconds: NOW,
      },
    );
    expect(order.state).toBe('delivering');
    expect(order.filledAmount).toBe(1_000_000n);
    expect(order.pendingAmount).toBe(1_000_000n);
    expect(order.deliveredAt).toBe(NOW - 100);
    expect(order.nextActions).toEqual(['wait']);
  });

  it('delivering: taken > 0 with remaining funds but no outstanding intent', () => {
    const order = deriveCashOrder('esc_1', [], {
      remainingAmount: 3_000_000n,
      takenAmount: 2_000_000n,
      status: 'ACTIVE',
      nowSeconds: NOW,
    });
    expect(order.state).toBe('delivering');
    expect(order.nextActions).toEqual(['wait', 'withdraw']);
  });

  it('delivered: fully taken, no live funds', () => {
    const order = deriveCashOrder(
      'esc_1',
      [intent({ intentHash: '0xa', status: 'FULFILLED', fulfillTimestamp: String(NOW - 50) })],
      {
        remainingAmount: 0n,
        takenAmount: 5_000_000n,
        status: 'CLOSED',
        nowSeconds: NOW,
      },
    );
    expect(order.state).toBe('delivered');
    expect(order.isInFlight).toBe(false);
    expect(order.nextActions).toEqual([]);
    expect(order.withdrawn).toBe(true);
  });

  it('returned: withdrawn without any fill', () => {
    const order = deriveCashOrder('esc_1', [], {
      remainingAmount: 0n,
      withdrawnAmount: 5_000_000n,
      status: 'WITHDRAWN',
      nowSeconds: NOW,
    });
    expect(order.state).toBe('returned');
    expect(order.returnedAmount).toBe(5_000_000n);
    expect(order.totalAmount).toBe(5_000_000n);
    expect(order.nextActions).toEqual([]);
    expect(order.withdrawn).toBe(true);
  });

  it('returned: pruned intent then withdrawn (non-delivery unwind)', () => {
    const order = deriveCashOrder(
      'esc_1',
      [intent({ intentHash: '0xa', status: 'PRUNED', prunedTimestamp: String(NOW - 10) })],
      {
        remainingAmount: 0n,
        withdrawnAmount: 5_000_000n,
        status: 'WITHDRAWN',
        nowSeconds: NOW,
      },
    );
    expect(order.state).toBe('returned');
    expect(order.fills[0]?.status).toBe('PRUNED');
    expect(order.fills[0]?.prunedAt).toBe(NOW - 10);
  });

  it('partial-fill terminal: delivered part + withdrawn remainder reads as returned with filledAmount kept', () => {
    const order = deriveCashOrder(
      'esc_1',
      [intent({ intentHash: '0xa', status: 'FULFILLED', fulfillTimestamp: String(NOW - 500) })],
      {
        remainingAmount: 0n,
        takenAmount: 2_000_000n,
        withdrawnAmount: 3_000_000n,
        status: 'WITHDRAWN',
        nowSeconds: NOW,
      },
    );
    // taken > 0 and no live funds → delivered wins over returned in the derivation
    expect(order.state).toBe('delivered');
    expect(order.filledAmount).toBe(2_000_000n);
    expect(order.returnedAmount).toBe(3_000_000n);
    expect(order.totalAmount).toBe(5_000_000n);
  });

  it('MANUALLY_RELEASED counts as fulfilled', () => {
    const order = deriveCashOrder(
      'esc_1',
      [intent({ intentHash: '0xa', status: 'MANUALLY_RELEASED', fulfillTimestamp: String(NOW) })],
      { remainingAmount: 0n, status: 'CLOSED', nowSeconds: NOW },
    );
    expect(order.state).toBe('delivered');
    expect(order.filledAmount).toBe(1_000_000n); // falls back to summing fills
  });
});

describe('deriveCashOrder — dust and fallbacks', () => {
  it('dust remainder is not treated as live funds', () => {
    const order = deriveCashOrder('esc_1', [], {
      remainingAmount: 9_999n, // below $0.01 dust threshold
      takenAmount: 4_990_001n,
      status: 'ACTIVE',
      nowSeconds: NOW,
    });
    expect(order.state).toBe('delivered');
  });

  it('sums fills when aggregates are absent', () => {
    const order = deriveCashOrder(
      'esc_1',
      [
        intent({ intentHash: '0xa', status: 'FULFILLED', amount: '2000000' }),
        intent({ intentHash: '0xb', status: 'SIGNALED', amount: '1500000' }),
      ],
      { nowSeconds: NOW },
    );
    expect(order.filledAmount).toBe(2_000_000n);
    expect(order.pendingAmount).toBe(1_500_000n);
    expect(order.totalAmount).toBe(3_500_000n);
  });

  it('tolerates malformed amounts and timestamps', () => {
    const order = deriveCashOrder(
      'esc_1',
      [
        intent({
          intentHash: '0xa',
          status: 'SIGNALED',
          amount: 'not-a-number',
          signalTimestamp: 'garbage',
        }),
      ],
      { nowSeconds: NOW },
    );
    expect(order.fills[0]?.amount).toBe(0n);
    expect(order.fills[0]?.signaledAt).toBeUndefined();
    expect(order.matchedAt).toBeUndefined();
  });

  it('empty everything derives a terminal returned order', () => {
    const order = deriveCashOrder('esc_1', [], { nowSeconds: NOW });
    expect(order.state).toBe('returned');
    expect(order.totalAmount).toBe(0n);
    expect(order.isInFlight).toBe(false);
  });

  it('buyer address is lowercased', () => {
    const order = deriveCashOrder(
      'esc_1',
      [intent({ intentHash: '0xa', status: 'SIGNALED', owner: '0xABCDEF' })],
      { nowSeconds: NOW },
    );
    expect(order.fills[0]?.buyer).toBe('0xabcdef');
  });
});

describe('explainOrder', () => {
  it('every state produces one non-empty sentence with no countdown language', () => {
    const cases = [
      deriveCashOrder('esc_1', [], { remainingAmount: 5_000_000n, status: 'ACTIVE', nowSeconds: NOW }),
      deriveCashOrder('esc_1', [intent({ intentHash: '0xa', status: 'SIGNALED' })], {
        remainingAmount: 4_000_000n,
        outstandingAmount: 1_000_000n,
        status: 'ACTIVE',
        nowSeconds: NOW,
      }),
      deriveCashOrder('esc_1', [], {
        remainingAmount: 3_000_000n,
        takenAmount: 2_000_000n,
        status: 'ACTIVE',
        nowSeconds: NOW,
      }),
      deriveCashOrder('esc_1', [], { takenAmount: 5_000_000n, status: 'CLOSED', nowSeconds: NOW }),
      deriveCashOrder('esc_1', [], {
        withdrawnAmount: 5_000_000n,
        status: 'WITHDRAWN',
        nowSeconds: NOW,
      }),
    ];
    for (const order of cases) {
      const sentence = order.explain();
      expect(sentence.length).toBeGreaterThan(20);
      expect(sentence).not.toMatch(/minutes|seconds|ETA|estimated time/i);
      expect(sentence).toBe(explainOrder(order));
    }
  });

  it('formats USDC base units as dollars', () => {
    const order = deriveCashOrder('esc_1', [], {
      remainingAmount: 1_234_560_000n,
      status: 'ACTIVE',
      nowSeconds: NOW,
    });
    expect(order.explain()).toContain('1234.56 USDC');
  });
});
