import { describe, expect, it } from 'vitest';
import { deriveCashOrder } from '../src/engine/orderState';
import {
  capabilitiesFromJson,
  capabilitiesToJson,
  cashoutResultFromJson,
  cashoutResultToJson,
  cashErrorJsonSchema,
  cashErrorFromJson,
  cashErrorToJson,
  estimateFromJson,
  estimateToJson,
  fillStatsFromJson,
  fillStatsToJson,
  fillFromJson,
  orderFromJson,
  orderToJson,
  prepareResultFromJson,
  prepareResultToJson,
  preparedTxFromJson,
  preparedTxToJson,
  relayQuoteFromJson,
  relayQuoteToJson,
  relayExecutionResultFromJson,
  relayExecutionResultToJson,
  relayStatusFromJson,
  relayStatusToJson,
  sourceCapabilitiesFromJson,
  sourceCapabilitiesToJson,
  withdrawResultFromJson,
  withdrawResultToJson,
  cashOrderJsonSchema,
} from '../src/codecs';
import { buildCapabilities } from '../src/client/capabilities';
import { errors, isCashError } from '../src/client/errors';
import type { CashEstimate } from '../src/client/estimate';
import type {
  CashSourceCapabilities,
  RelayExecutionResult,
  RelayQuote,
  RelayStatus,
} from '../src/client/relay';
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

  it('schema rejects negative monetary bigint strings', () => {
    const bad = { ...orderToJson(order), returnedAmount: '-1' };
    expect(cashOrderJsonSchema.safeParse(bad).success).toBe(false);
  });

  it('refuses to serialize negative internal monetary values', () => {
    expect(() => orderToJson({ ...order, returnedAmount: -1n })).toThrow();
  });

  it('schema rejects unknown states', () => {
    const bad = { ...orderToJson(order), state: 'refunded' };
    expect(cashOrderJsonSchema.safeParse(bad).success).toBe(false);
  });

  it('fillFromJson validates unknown wire input before converting bigints', () => {
    expect(() =>
      fillFromJson({ intentHash: '0xa', status: 'UNKNOWN', amount: '1', buyer: '0xb' }),
    ).toThrow();
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

  it('strips Relay request headers when serializing source quotes', () => {
    const estimate: CashEstimate = {
      kind: 'oracle-estimate',
      currency: 'USD',
      amount: 970_000n,
      rate: 1,
      receiveAmount: 0.97,
      asOf: NOW,
      source: {
        kind: 'relay',
        asset: { chainId: 10, address: '0xsource', symbol: 'USDC', decimals: 6 },
        inputAmount: 1_000_000n,
        relayQuote: {
          source: { chainId: 10, address: '0xsource', symbol: 'USDC', decimals: 6 },
          destination: {
            chainId: 8453,
            address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            symbol: 'USDC',
            decimals: 6,
          },
          inputAmount: 1_000_000n,
          outputAmount: 970_000n,
          txs: [],
          raw: {
            request: {
              url: 'https://api.relay.link/quote/v2',
              headers: { 'x-api-key': 'secret-relay-key', authorization: 'Bearer secret' },
            },
            steps: [],
          },
        },
      },
    };

    const json = estimateToJson(estimate);
    expect(JSON.stringify(json)).not.toContain('secret');
    expect(
      (json.source?.relayQuote.raw as { request?: { headers?: unknown } }).request?.headers,
    ).toBeUndefined();
  });
});

describe('fill stats codec', () => {
  it('round-trips plain JSON evidence and rejects invalid counts', () => {
    const stats = {
      'venmo:USD': { fills: 12, medianFillSeconds: 3_600 },
      'zelle:USD': { fills: 4 },
    };
    expect(fillStatsFromJson(JSON.parse(JSON.stringify(fillStatsToJson(stats))))).toEqual(stats);
    expect(() => fillStatsFromJson({ 'venmo:USD': { fills: -1 } })).toThrow();
  });
});

describe('Relay codecs', () => {
  it('round-trips a quote losslessly while removing request credentials', () => {
    const quote: RelayQuote = {
      requestId: 'relay-request',
      source: { chainId: 10, address: '0xsource', symbol: 'USDC', decimals: 6 },
      destination: {
        chainId: 8453,
        address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        symbol: 'USDC',
        decimals: 6,
      },
      inputAmount: 1_000_000n,
      outputAmount: 975_000n,
      rate: 0.975,
      timeEstimateSeconds: 30,
      fees: { solverGas: 12_345n },
      txs: [{ to: '0xrelay', data: '0x01', value: 0n, chainId: 10 }],
      raw: {
        request: { url: 'https://api.relay.link/quote/v2', headers: { 'x-api-key': 'secret' } },
        metadata: { quoteBlock: 123n },
        steps: [],
      } as unknown as RelayQuote['raw'],
    };

    const json = relayQuoteToJson(quote);
    const restored = relayQuoteFromJson(JSON.parse(JSON.stringify(json)));

    expect(restored.inputAmount).toBe(quote.inputAmount);
    expect(restored.outputAmount).toBe(quote.outputAmount);
    expect(restored.fees).toEqual(quote.fees);
    expect(restored.txs).toEqual(quote.txs);
    expect(
      (restored.raw as unknown as { metadata: { quoteBlock: bigint } }).metadata.quoteBlock,
    ).toBe(123n);
    expect(JSON.stringify(json)).not.toContain('secret');
  });

  it('round-trips Relay source capabilities', () => {
    const capabilities: CashSourceCapabilities = {
      destination: {
        chainId: 8453,
        address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        symbol: 'USDC',
        decimals: 6,
      },
      chains: [
        {
          id: 10,
          name: 'optimism',
          displayName: 'Optimism',
          disabled: false,
          depositEnabled: true,
          blockProductionLagging: false,
          vmType: 'evm',
          tokens: [
            {
              chainId: 10,
              address: '0xsource',
              symbol: 'USDC',
              decimals: 6,
            },
          ],
        },
      ],
      source: 'relay-sdk',
      asOf: NOW,
    };

    expect(sourceCapabilitiesFromJson(sourceCapabilitiesToJson(capabilities))).toEqual(
      capabilities,
    );
  });

  it('round-trips Relay status data', () => {
    const status: RelayStatus = {
      requestId: 'relay-request',
      status: 'success',
      details: 'delivered',
      inTxHashes: ['0xorigin'],
      txHashes: ['0xdestination'],
      updatedAt: NOW,
      originChainId: 10,
      destinationChainId: 8453,
      quoteCreatedAt: NOW - 30,
      raw: { status: 'success', destinationBlock: 456n },
    };

    expect(relayStatusFromJson(JSON.parse(JSON.stringify(relayStatusToJson(status))))).toEqual(
      status,
    );
  });

  it('round-trips Relay execution transactions while removing request credentials', () => {
    const result: RelayExecutionResult = {
      requestId: 'relay-request',
      txHashes: ['0xorigin', '0xdestination'],
      transactions: {
        origin: [{ hash: '0xorigin', chainId: 10 }],
        destination: [{ hash: '0xdestination', chainId: 8453, isBatchTx: true }],
      },
      quote: {
        request: { url: 'https://api.relay.link/quote/v2', headers: { authorization: 'secret' } },
        steps: [
          {
            action: 'bridge',
            description: 'Bridge',
            kind: 'transaction',
            id: 'deposit',
            items: [{ status: 'complete', receipt: { gasUsed: 21_000n } }],
          },
        ],
      } as unknown as RelayExecutionResult['quote'],
    };

    const json = relayExecutionResultToJson(result);
    const restored = relayExecutionResultFromJson(JSON.parse(JSON.stringify(json)));

    expect(restored.transactions).toEqual(result.transactions);
    expect(restored.txHashes).toEqual(result.txHashes);
    expect(JSON.stringify(json)).not.toContain('secret');
    expect(() => JSON.stringify(json)).not.toThrow();
    expect(
      (restored.quote.steps[0]?.items[0]?.receipt as { gasUsed?: bigint } | undefined)?.gasUsed,
    ).toBe(21_000n);
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
      source: {
        amount: 1_000_000n,
        requestId: 'relay-request',
        txHashes: ['0xrelay'],
        transactions: {
          origin: [{ hash: '0xorigin', chainId: 10 }],
          destination: [{ hash: '0xdestination', chainId: 8453 }],
        },
      },
    };
    const restored = cashoutResultFromJson(JSON.parse(JSON.stringify(cashoutResultToJson(result))));
    expect(restored.onchainDepositId).toBe(1n);
    expect(restored.source?.amount).toBe(1_000_000n);
    expect(restored.source?.transactions).toEqual(result.source.transactions);
    expect(restored.order.state).toBe(order.state);
    expect(restored.order.explain()).toBe(order.explain());
  });

  it('accepts 0.1.3 source results that predate chain-aware transactions', () => {
    const legacy = cashoutResultToJson({
      depositId: '0xescrow_1',
      txHash: '0xt',
      escrowAddress: '0xescrow',
      onchainDepositId: 1n,
      order,
      source: { amount: 1_000_000n, requestId: 'relay-request', txHashes: ['0xrelay'] },
    });

    expect(cashoutResultFromJson(legacy).source).toMatchObject({
      amount: 1_000_000n,
      txHashes: ['0xrelay'],
    });
    expect(cashoutResultFromJson(legacy).source?.transactions).toBeUndefined();
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

describe('CashError codec', () => {
  it('round-trips a retryable wallet rejection', () => {
    const error = errors.transactionRejected('cashout', new Error('User rejected the request'));
    const restored = cashErrorFromJson(cashErrorToJson(error));

    expect(restored.toJSON()).toEqual({
      code: 'TRANSACTION_REJECTED',
      message: 'The cashout wallet request was cancelled.',
      retryable: true,
      remediation:
        'Retry the original Peer Cash action and approve the wallet request when you are ready.',
    });
  });

  it('rejects error codes outside the public CashError contract', () => {
    const json = errors.sourceQuoteFailed().toJSON();
    expect(cashErrorJsonSchema.safeParse({ ...json, code: 'UNKNOWN_ERROR' }).success).toBe(false);
  });

  it('round-trips recovery data and restores CashError behavior', () => {
    const error = errors.sourceRouteCompletedCashoutFailed({
      amount: 975_000n,
      requestId: 'relay-request',
      txHashes: ['0xorigin', '0xdestination'],
      transactions: {
        origin: [{ hash: '0xorigin', chainId: 10 }],
        destination: [{ hash: '0xdestination', chainId: 8453 }],
      },
    });

    const restored = cashErrorFromJson(JSON.parse(JSON.stringify(cashErrorToJson(error))));

    expect(isCashError(restored)).toBe(true);
    expect(restored.toJSON()).toEqual(error.toJSON());
  });

  it('round-trips an indeterminate Base transaction recovery without losing its hash', () => {
    const error = errors.sourceCashoutStatusUnknown(
      {
        amount: 975_000n,
        txHashes: ['0xorigin'],
        transactions: { origin: [{ hash: '0xorigin', chainId: 10 }], destination: [] },
      },
      '0xdeposit',
    );

    const restored = cashErrorFromJson(cashErrorToJson(error));

    expect(restored.code).toBe('SOURCE_CASHOUT_STATUS_UNKNOWN');
    expect(restored.recovery).toMatchObject({
      kind: 'inspect-base-cashout-transaction',
      depositTxHash: '0xdeposit',
    });
  });

  it('round-trips a Base submission whose transaction hash was never returned', () => {
    const error = errors.sourceCashoutSubmissionUnknown(
      { amount: 975_000n, txHashes: ['0xorigin'] },
      '0x2222222222222222222222222222222222222222',
    );

    const restored = cashErrorFromJson(cashErrorToJson(error));

    expect(restored.recovery).toMatchObject({
      kind: 'inspect-base-cashout-submission',
      depositor: '0x2222222222222222222222222222222222222222',
      amount: '975000',
    });
  });

  it('round-trips an indeterminate Base operation without making it retryable', () => {
    const error = errors.transactionSubmissionUnknown('withdrawDeposit', new Error('timeout'), {
      kind: 'inspect-base-operation-submission',
      operation: 'withdrawDeposit',
    });

    const restored = cashErrorFromJson(cashErrorToJson(error));

    expect(restored).toMatchObject({
      code: 'TRANSACTION_SUBMISSION_UNKNOWN',
      retryable: false,
      recovery: {
        kind: 'inspect-base-operation-submission',
        operation: 'withdrawDeposit',
      },
    });
  });

  it('round-trips an unknown Base receipt with its submitted hash', () => {
    const error = errors.transactionStatusUnknown(
      '0xsubmitted',
      new Error('RPC timeout'),
      'withdrawDeposit',
    );

    const restored = cashErrorFromJson(cashErrorToJson(error));

    expect(restored.recovery).toEqual({
      kind: 'inspect-base-transaction',
      transactionHash: '0xsubmitted',
      operation: 'withdrawDeposit',
    });
  });

  it('round-trips Relay evidence captured after an uncertain execution', () => {
    const error = errors.sourceExecutionFailed(new Error('status disconnected'), {
      requestId: 'relay-request',
      txHashes: ['0xorigin'],
      transactions: { origin: [{ hash: '0xorigin', chainId: 10 }], destination: [] },
    });

    const restored = cashErrorFromJson(cashErrorToJson(error));

    expect(restored.recovery).toEqual({
      kind: 'inspect-relay-route',
      requestId: 'relay-request',
      txHashes: ['0xorigin'],
      transactions: { origin: [{ hash: '0xorigin', chainId: 10 }], destination: [] },
    });
  });
});
