import { describe, expect, it } from 'vitest';
import { deriveCashOrder } from '../src/engine/orderState';
import {
  capabilitiesFromJson,
  capabilitiesToJson,
  cashoutResultFromJson,
  cashoutResultToJson,
  estimateFromJson,
  estimateToJson,
  orderFromJson,
  orderToJson,
  prepareResultFromJson,
  prepareResultToJson,
  preparedTxFromJson,
  preparedTxToJson,
  withdrawResultFromJson,
  withdrawResultToJson,
  cashOrderJsonSchema,
} from '../src/codecs';
import { buildCapabilities } from '../src/client/capabilities';
import type { CashEstimate } from '../src/client/estimate';
import type { IntentEntity } from '../src/sdk-types';

const NOW = 1_800_000_000;

const order = deriveCashOrder(
  '0xescrow_1',
  [
    {
      intentHash: '0xa',
      status: 'SIGNALED',
      amount: '1000000',
      owner: '0xBuyer',
      fiatCurrency: 'USD',
      signalTimestamp: String(NOW - 60),
      expiryTime: String(NOW + 3600),
    } as unknown as IntentEntity,
  ],
  {
    remainingAmount: 4_000_000n,
    outstandingAmount: 1_000_000n,
    status: 'ACTIVE',
    intentCount: 1,
    updatedAt: NOW - 60,
    nowSeconds: NOW,
  },
);

describe('order codec', () => {
  it('round-trips losslessly through JSON.stringify', () => {
    const json = orderToJson(order);
    const wire = JSON.parse(JSON.stringify(json));
    const restored = orderFromJson(wire);

    expect(restored.depositId).toBe(order.depositId);
    expect(restored.state).toBe(order.state);
    expect(restored.totalAmount).toBe(order.totalAmount);
    expect(restored.pendingAmount).toBe(order.pendingAmount);
    expect(restored.nextActions).toEqual(order.nextActions);
    expect(restored.fills).toHaveLength(1);
    expect(restored.fills[0]?.amount).toBe(1_000_000n);
    expect(restored.fills[0]?.buyer).toBe('0xbuyer');
  });

  it('re-attaches explain() on parse', () => {
    const restored = orderFromJson(orderToJson(order));
    expect(restored.explain()).toBe(order.explain());
  });

  it('schema rejects malformed bigint strings', () => {
    const bad = { ...orderToJson(order), totalAmount: '12.5' };
    expect(cashOrderJsonSchema.safeParse(bad).success).toBe(false);
  });

  it('schema rejects unknown states', () => {
    const bad = { ...orderToJson(order), state: 'refunded' };
    expect(cashOrderJsonSchema.safeParse(bad).success).toBe(false);
  });
});

describe('estimate codec', () => {
  it('round-trips', () => {
    const estimate: CashEstimate = {
      kind: 'oracle-estimate',
      currency: 'EUR',
      amount: 1_000_000_000n,
      rate: 0.92,
      receiveAmount: 920,
      asOf: NOW,
    };
    const restored = estimateFromJson(JSON.parse(JSON.stringify(estimateToJson(estimate))));
    expect(restored).toEqual(estimate);
  });
});

describe('prepared tx + result codecs', () => {
  const tx = { to: '0xdead' as const, data: '0xbeef' as const, value: 0n, chainId: 8453 };

  it('preparedTx round-trips', () => {
    expect(preparedTxFromJson(JSON.parse(JSON.stringify(preparedTxToJson(tx))))).toEqual(tx);
  });

  it('prepareResult round-trips', () => {
    const result = {
      txs: [tx, tx],
      steps: [
        { kind: 'approve' as const, description: 'Approve Base USDC.' },
        { kind: 'createDeposit' as const, description: 'Create the order.' },
      ],
      register: { hashedOnchainIds: ['0x1'] },
    };
    expect(prepareResultFromJson(JSON.parse(JSON.stringify(prepareResultToJson(result))))).toEqual(
      result,
    );
  });

  it('cashoutResult round-trips including the nested order', () => {
    const result = {
      depositId: '0xescrow_1',
      txHash: '0xt' as const,
      escrowAddress: '0xescrow',
      onchainDepositId: 1n,
      order,
      source: { amount: 1_000_000n, requestId: 'relay-request', txHashes: ['0xrelay'] },
    };
    const restored = cashoutResultFromJson(JSON.parse(JSON.stringify(cashoutResultToJson(result))));
    expect(restored.onchainDepositId).toBe(1n);
    expect(restored.source?.amount).toBe(1_000_000n);
    expect(restored.order.state).toBe(order.state);
    expect(restored.order.explain()).toBe(order.explain());
  });

  it('withdrawResult round-trips with and without prune hash', () => {
    const withPrune = {
      depositId: 'd',
      pruneTxHash: '0xp' as const,
      withdrawTxHash: '0xw' as const,
    };
    const withoutPrune = { depositId: 'd', withdrawTxHash: '0xw' as const };
    expect(
      withdrawResultFromJson(JSON.parse(JSON.stringify(withdrawResultToJson(withPrune)))),
    ).toEqual(withPrune);
    expect(
      withdrawResultFromJson(JSON.parse(JSON.stringify(withdrawResultToJson(withoutPrune)))),
    ).toEqual(withoutPrune);
  });
});

describe('capabilities codec', () => {
  it('round-trips', () => {
    const caps = buildCapabilities('staging');
    const restored = capabilitiesFromJson(JSON.parse(JSON.stringify(capabilitiesToJson(caps))));
    expect(restored).toEqual(caps);
  });
});
