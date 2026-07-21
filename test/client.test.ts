import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Abi,
  type Log,
  type WalletClient,
} from 'viem';

// --- Zkp2pClient mock (pure helpers stay real) ---

const mockInstance = {
  chainId: 8453,
  runtimeEnv: 'staging' as const,
  escrowV2Abi: undefined as Abi | undefined,
  escrowAbi: [] as Abi,
  publicClient: {
    getTransaction: vi.fn(),
    readContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  },
  indexer: {
    getDeposits: vi.fn(),
    getDepositsWithRelations: vi.fn(),
    getDepositsByIdsWithRelations: vi.fn(),
    getIntentsForDeposits: vi.fn(),
    getOwnerIntents: vi.fn(),
  },
  registerPayeeDetails: vi.fn(),
  createDeposit: vi.fn(),
  prepareCreateDeposit: vi.fn(),
  ensureAllowance: vi.fn(),
  withdrawDeposit: Object.assign(vi.fn(), { prepare: vi.fn() }),
  pruneExpiredIntents: Object.assign(vi.fn(), { prepare: vi.fn() }),
  addFunds: Object.assign(vi.fn(), { prepare: vi.fn() }),
  removeFunds: Object.assign(vi.fn(), { prepare: vi.fn() }),
};

vi.mock('@zkp2p/sdk', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@zkp2p/sdk')>();
  return {
    ...actual,
    Zkp2pClient: vi.fn(function MockZkp2pClient() {
      return mockInstance;
    }),
  };
});

import {
  currencyInfo,
  getAttributionDataSuffix,
  getPaymentMethodsCatalog,
  Zkp2pClient,
} from '@zkp2p/sdk';
import { createCashClient, CASH_ATTRIBUTION_CODE } from '../src/client/createCashClient';
import { isCashError, isUserRejectedError } from '../src/client/errors';

const NOW = Math.floor(Date.now() / 1000);
const ESCROW = '0x1111111111111111111111111111111111111111';
const DEPOSIT_ID = `${ESCROW}_5`;
const UNKNOWN_PAYMENT_METHOD_HASH = `0x${'11'.repeat(32)}`;

const DEPOSIT_RECEIVED_ABI: Abi = [
  {
    type: 'event',
    name: 'DepositReceived',
    inputs: [
      { name: 'depositId', type: 'uint256', indexed: true },
      { name: 'depositor', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
];

function depositReceivedLog(depositId: bigint): Log {
  return {
    address: ESCROW,
    topics: encodeEventTopics({
      abi: DEPOSIT_RECEIVED_ABI,
      eventName: 'DepositReceived',
      args: {
        depositId,
        depositor: '0x2222222222222222222222222222222222222222',
        token: '0x3333333333333333333333333333333333333333',
      },
    }),
    data: encodeAbiParameters([{ type: 'uint256' }], [5_000_000n]),
    blockNumber: 1n,
    blockHash: '0xb',
    logIndex: 0,
    transactionHash: '0xt',
    transactionIndex: 0,
    removed: false,
  } as unknown as Log;
}

const signer = {
  account: { address: '0xmaker' },
  chain: { id: 8453 },
  getChainId: vi.fn(async () => 8453),
} as unknown as WalletClient;
const sourceSigner = {
  account: { address: '0xmaker' },
  chain: { id: 10 },
  getChainId: vi.fn(async () => 10),
} as unknown as WalletClient;

function depositRow(overrides: Record<string, unknown> = {}) {
  const paymentMethodHash = getPaymentMethodsCatalog(8453, 'staging')['venmo']!.paymentMethodHash;
  return {
    id: DEPOSIT_ID,
    remainingDeposits: '5000000',
    outstandingIntentAmount: '0',
    totalAmountTaken: '0',
    totalWithdrawn: '0',
    status: 'ACTIVE',
    chainId: 8453,
    token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    totalIntents: 0,
    updatedAt: String(NOW - 30),
    intents: [],
    paymentMethods: [{ paymentMethodHash, payeeDetailsHash: '0xpayee', active: true }],
    currencies: [
      {
        paymentMethodHash,
        currencyCode: currencyInfo['USD']!.currencyCodeHash,
        spreadBps: 0,
        kind: 'oracle_chainlink',
      },
    ],
    ...overrides,
  };
}

function client() {
  return createCashClient({ environment: 'staging' });
}

describe('isUserRejectedError()', () => {
  it.each([
    'Rejected request',
    'Request rejected by user',
    new Error('Rejected request'),
    new Error('The wallet failed', { cause: 'User denied request' }),
  ])('recognizes cancellation wording without requiring an error object', (error) => {
    expect(isUserRejectedError(error)).toBe(true);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockInstance.escrowV2Abi = DEPOSIT_RECEIVED_ABI;
  mockInstance.registerPayeeDetails.mockResolvedValue({
    depositDetails: [{}],
    hashedOnchainIds: ['0xpayeehash'],
  });
  mockInstance.ensureAllowance.mockResolvedValue({ hadAllowance: true });
});

describe('environment routing', () => {
  it('uses the preproduction curator with preproduction contracts and indexer', () => {
    createCashClient({ environment: 'preproduction' });

    expect(Zkp2pClient).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeEnv: 'preproduction',
        baseApiUrl: 'https://api-preprod.zkp2p.xyz',
      }),
    );
  });
});

describe('fillStats()', () => {
  it('returns intent-attributed pair evidence through the public client verb', async () => {
    const venmoHash = getPaymentMethodsCatalog(8453, 'staging')['venmo']!.paymentMethodHash;
    mockInstance.indexer.getDepositsWithRelations.mockResolvedValue([
      {
        timestamp: NOW - 300,
        intents: [
          {
            paymentMethodHash: venmoHash,
            fiatCurrency: 'USD',
            fulfillTimestamp: NOW - 120,
          },
        ],
      },
    ]);

    await expect(client().fillStats()).resolves.toEqual({
      'venmo:USD': { fills: 1, medianFillSeconds: 180 },
    });
  });

  it('maps an unavailable indexer to the existing retryable read error', async () => {
    mockInstance.indexer.getDepositsWithRelations.mockRejectedValue(new Error('gateway timeout'));

    await expect(client().fillStats()).rejects.toMatchObject({
      code: 'INDEXER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('shares one cached snapshot across pair ETA and raw stats reads', async () => {
    const venmoHash = getPaymentMethodsCatalog(8453, 'staging')['venmo']!.paymentMethodHash;
    mockInstance.indexer.getDepositsWithRelations.mockResolvedValue([
      {
        timestamp: NOW - 300,
        intents: [
          {
            paymentMethodHash: venmoHash,
            fiatCurrency: 'USD',
            fulfillTimestamp: NOW - 120,
          },
        ],
      },
    ]);
    const cash = client();

    const [estimate, stats] = await Promise.all([
      cash.estimate({ amount: 1_000_000n, currency: 'USD', platform: 'venmo' }),
      cash.fillStats(),
    ]);
    const unmatchedPairEstimate = await cash.estimate({
      amount: 1_000_000n,
      currency: 'USD',
      platform: 'revolut',
    });

    expect(estimate.eta?.seconds).toBe(180);
    expect(unmatchedPairEstimate.eta).toEqual({
      label: 'Recent fill time unavailable',
    });
    expect(stats).toEqual({
      'venmo:USD': { fills: 1, medianFillSeconds: 180 },
    });
    expect(mockInstance.indexer.getDepositsWithRelations).toHaveBeenCalledTimes(1);
  });
});

describe('order()', () => {
  it('rejects a bare on-chain id before querying the composite-id index', async () => {
    await expect(client().order('123')).rejects.toMatchObject({ code: 'INVALID_DEPOSIT_ID' });
    expect(mockInstance.indexer.getDepositsByIdsWithRelations).not.toHaveBeenCalled();
  });

  it('canonicalizes a valid composite id before querying the indexer', async () => {
    const checksummedEscrow = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const canonicalId = `${checksummedEscrow.toLowerCase()}_5`;
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([
      depositRow({ id: canonicalId }),
    ]);

    const order = await client().order(`${checksummedEscrow}_0005`);

    expect(mockInstance.indexer.getDepositsByIdsWithRelations).toHaveBeenCalledWith(
      [canonicalId],
      expect.any(Object),
    );
    expect(order.depositId).toBe(canonicalId);
  });

  it('derives from deposit aggregates + intents', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([
      depositRow({
        outstandingIntentAmount: '1000000',
        remainingDeposits: '4000000',
        intents: [
          {
            intentHash: '0xa',
            status: 'SIGNALED',
            amount: '1000000',
            owner: '0xbuyer',
            signalTimestamp: String(NOW - 60),
            expiryTime: String(NOW + 3600),
          },
        ],
      }),
    ]);
    const order = await client().order(DEPOSIT_ID);
    expect(order.state).toBe('matched');
    expect(order.totalAmount).toBe(5_000_000n);
    expect(order.nextActions).toEqual(['wait']);
  });

  it('refuses an indexed deposit containing a method outside the active catalog', async () => {
    const genericHash = getPaymentMethodsCatalog(8453, 'staging')['zelle']!.paymentMethodHash;
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([
      depositRow({
        paymentMethods: [
          { paymentMethodHash: genericHash, payeeDetailsHash: '0xgeneric', active: true },
          {
            paymentMethodHash: UNKNOWN_PAYMENT_METHOD_HASH,
            payeeDetailsHash: '0xunknown',
            active: true,
          },
        ],
        currencies: [
          {
            paymentMethodHash: genericHash,
            currencyCode: currencyInfo['USD']!.currencyCodeHash,
            spreadBps: 0,
            kind: 'oracle_chainlink',
          },
        ],
      }),
    ]);

    await expect(client().order(DEPOSIT_ID)).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
  });

  it('falls back to intents-only when the deposit is not indexed yet', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([]);
    mockInstance.indexer.getIntentsForDeposits.mockResolvedValue([
      { intentHash: '0xa', status: 'SIGNALED', amount: '1000000', owner: '0xbuyer' },
    ]);
    const order = await client().order(DEPOSIT_ID);
    expect(order.state).toBe('matched');
  });

  it('throws retryable ORDER_NOT_FOUND when nothing is indexed', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([]);
    mockInstance.indexer.getIntentsForDeposits.mockResolvedValue([]);
    await expect(client().order(DEPOSIT_ID)).rejects.toMatchObject({
      code: 'ORDER_NOT_FOUND',
      retryable: true,
    });
  });

  it('wraps indexer transport failures instead of leaking raw errors', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockRejectedValue(
      new Error('indexer gateway timeout'),
    );

    await expect(client().order(DEPOSIT_ID)).rejects.toMatchObject({
      code: 'INDEXER_UNAVAILABLE',
      retryable: true,
    });
  });
});

describe('orders()', () => {
  it('excludes deposits that do not satisfy Peer Cash market-rate invariants', async () => {
    const paymentMethodHash = getPaymentMethodsCatalog(8453, 'staging')['venmo']!.paymentMethodHash;
    mockInstance.indexer.getDepositsWithRelations.mockResolvedValue([
      depositRow({
        id: 'a_fixed_rate',
        currencies: [
          {
            paymentMethodHash,
            currencyCode: currencyInfo['USD']!.currencyCodeHash,
            spreadBps: 100,
            kind: 'fixed',
          },
        ],
      }),
    ]);

    const orders = await client().orders('0xmaker');

    expect(orders).toEqual([]);
  });

  it('excludes deposits containing a method outside the active catalog', async () => {
    const genericHash = getPaymentMethodsCatalog(8453, 'staging')['zelle']!.paymentMethodHash;
    mockInstance.indexer.getDepositsWithRelations.mockResolvedValue([
      depositRow({
        paymentMethods: [
          { paymentMethodHash: genericHash, payeeDetailsHash: '0xgeneric', active: true },
          {
            paymentMethodHash: UNKNOWN_PAYMENT_METHOD_HASH,
            payeeDetailsHash: '0xunknown',
            active: true,
          },
        ],
        currencies: [
          {
            paymentMethodHash: genericHash,
            currencyCode: currencyInfo['USD']!.currencyCodeHash,
            spreadBps: 0,
            kind: 'oracle_chainlink',
          },
        ],
      }),
    ]);

    await expect(client().orders('0xmaker')).resolves.toEqual([]);
  });

  it('includes a cash-out at the exact minimum amount', async () => {
    mockInstance.indexer.getDepositsWithRelations.mockResolvedValue([
      depositRow({ id: 'a_min', remainingDeposits: '10000' }),
    ]);

    const orders = await client().orders('0xmaker');

    expect(orders.map((order) => order.depositId)).toEqual(['a_min']);
  });

  it('filters dust and sorts most-recent-first', async () => {
    mockInstance.indexer.getDepositsWithRelations.mockResolvedValue([
      depositRow({ id: 'a_1', updatedAt: String(NOW - 100) }),
      depositRow({ id: 'a_2', remainingDeposits: '5', updatedAt: String(NOW - 10) }), // dust
      depositRow({ id: 'a_3', updatedAt: String(NOW - 50) }),
    ]);
    const orders = await client().orders('0xmaker');
    expect(orders.map((o) => o.depositId)).toEqual(['a_3', 'a_1']);
  });

  it('inFlight filters to live orders only', async () => {
    mockInstance.indexer.getDepositsWithRelations.mockResolvedValue([
      depositRow({ id: 'a_1' }),
      depositRow({
        id: 'a_2',
        remainingDeposits: '0',
        totalWithdrawn: '5000000',
        status: 'WITHDRAWN',
      }),
    ]);
    const orders = await client().orders('0xmaker', { inFlight: true });
    expect(orders.map((o) => o.depositId)).toEqual(['a_1']);
    expect(orders[0]?.isInFlight).toBe(true);
  });

  it('wraps list-query transport failures instead of leaking raw errors', async () => {
    mockInstance.indexer.getDepositsWithRelations.mockRejectedValue(
      new Error('indexer gateway timeout'),
    );

    await expect(client().orders('0xmaker')).rejects.toMatchObject({
      code: 'INDEXER_UNAVAILABLE',
      retryable: true,
    });
  });
});

describe('cashout()', () => {
  it('registers payee, ensures allowance, creates deposit, resolves composite id', async () => {
    mockInstance.createDeposit.mockResolvedValue({ hash: '0xhash' });
    mockInstance.publicClient.waitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      logs: [depositReceivedLog(5n)],
    });

    const result = await client().cashout(
      {
        amount: 5_000_000n,
        receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@andrew' } },
      },
      { signer },
    );

    expect(mockInstance.registerPayeeDetails).toHaveBeenCalledOnce();
    expect(mockInstance.ensureAllowance).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 5_000_000n }),
    );
    expect(mockInstance.createDeposit).toHaveBeenCalledOnce();
    expect(result.depositId).toBe(`${ESCROW}_5`);
    expect(result.onchainDepositId).toBe(5n);
    expect(result.txHash).toBe('0xhash');
    expect(result.order.state).toBe('awaiting-buyer');
  });

  it('creates a signed Zelle cashout with only the generic method', async () => {
    const payeeHashes = ['0xzelle'];
    mockInstance.registerPayeeDetails.mockResolvedValue({
      depositDetails: payeeHashes.map(() => ({})),
      hashedOnchainIds: payeeHashes,
    });
    mockInstance.createDeposit.mockResolvedValue({ hash: '0xhash' });
    mockInstance.publicClient.waitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      logs: [depositReceivedLog(5n)],
    });

    await client().cashout(
      {
        amount: 5_000_000n,
        receive: { platform: 'zelle', currency: 'USD', payee: { offchainId: 'a@example.com' } },
      },
      { signer },
    );

    const methods = ['zelle'];
    expect(mockInstance.registerPayeeDetails).toHaveBeenCalledWith({
      processorNames: methods,
      payeeData: methods.map(() => ({ offchainId: 'a@example.com' })),
    });
    expect(mockInstance.createDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        processorNames: methods,
        paymentMethodsOverride: methods.map(
          (method) => getPaymentMethodsCatalog(8453, 'staging')[method]!.paymentMethodHash,
        ),
        paymentMethodDataOverride: payeeHashes.map((payeeDetails) =>
          expect.objectContaining({ payeeDetails }),
        ),
      }),
    );
  });

  it('does not invite duplicate Base cashouts when submission returns no hash', async () => {
    mockInstance.createDeposit.mockRejectedValue(new Error('RPC timed out after broadcast'));

    const err = await client()
      .cashout(
        {
          amount: 5_000_000n,
          receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@andrew' } },
        },
        { signer },
      )
      .catch((error) => error);

    expect(err).toMatchObject({
      code: 'TRANSACTION_SUBMISSION_UNKNOWN',
      retryable: false,
      recovery: {
        kind: 'inspect-base-cashout-submission',
        amount: '5000000',
        depositor: '0xmaker',
        txHashes: [],
      },
    });
  });

  it('can route a Relay source to Base USDC before creating the cash-out', async () => {
    const relayQuote = {
      details: {
        sender: '0xmaker',
        recipient: '0xmaker',
        currencyIn: {
          amount: '1000000',
          currency: { chainId: 10, address: '0xsource', symbol: 'USDC', decimals: 6 },
        },
        currencyOut: {
          amount: '4900000',
          currency: {
            chainId: 8453,
            address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            symbol: 'USDC',
            decimals: 6,
          },
        },
      },
      steps: [
        {
          action: 'bridge',
          description: 'Bridge',
          kind: 'transaction',
          id: 'deposit',
          requestId: 'relay-request',
          items: [],
        },
      ],
    };
    const relayExecuted = {
      steps: [
        {
          action: 'bridge',
          description: 'Bridge',
          kind: 'transaction',
          id: 'deposit',
          requestId: 'relay-request',
          items: [{ status: 'complete', txHashes: [{ txHash: '0xrelay', chainId: 10 }] }],
        },
      ],
    };
    const relayClient = {
      chains: [
        {
          id: 10,
          name: 'optimism',
          displayName: 'Optimism',
          currency: {
            address: '0x0000000000000000000000000000000000000000',
            symbol: 'ETH',
            decimals: 18,
          },
        },
      ],
      actions: {
        getQuote: vi.fn(async () => relayQuote),
        execute: vi.fn(async () => ({
          data: relayExecuted,
          abortController: new AbortController(),
        })),
      },
    };
    mockInstance.createDeposit.mockResolvedValue({ hash: '0xhash' });
    mockInstance.publicClient.waitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      logs: [depositReceivedLog(5n)],
    });

    const result = await createCashClient({
      environment: 'staging',
      relay: { client: relayClient as never },
    }).cashout(
      {
        amount: 1_000_000n,
        source: { chainId: 10, currency: '0xsource' },
        receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@andrew' } },
      },
      { signer, sourceSigner },
    );

    expect(relayClient.actions.getQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 10,
        toChainId: 8453,
        amount: '1000000',
        user: '0xmaker',
        recipient: '0xmaker',
      }),
      false,
    );
    expect(relayClient.actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({ quote: relayQuote, wallet: sourceSigner }),
    );
    expect(mockInstance.ensureAllowance).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 4_900_000n }),
    );
    expect(mockInstance.ensureAllowance.mock.invocationCallOrder[0]).toBeLessThan(
      relayClient.actions.execute.mock.invocationCallOrder[0]!,
    );
    expect(result.source).toEqual({
      amount: 4_900_000n,
      requestId: 'relay-request',
      txHashes: ['0xrelay'],
      transactions: {
        origin: [{ hash: '0xrelay', chainId: 10 }],
        destination: [],
      },
    });
  });

  it('waits for the signer provider to observe a same-chain Relay nonce before depositing', async () => {
    const relayQuote = {
      details: {
        sender: '0xmaker',
        recipient: '0xmaker',
        currencyIn: {
          amount: '50000000000000',
          currency: {
            chainId: 8453,
            address: '0x0000000000000000000000000000000000000000',
            symbol: 'ETH',
            decimals: 18,
          },
        },
        currencyOut: {
          amount: '88800',
          currency: {
            chainId: 8453,
            address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            symbol: 'USDC',
            decimals: 6,
          },
        },
      },
      steps: [],
    };
    const relayExecuted = {
      steps: [
        {
          action: 'swap',
          description: 'Swap ETH to USDC',
          kind: 'transaction',
          id: 'swap',
          requestId: 'relay-base-request',
          items: [{ status: 'complete', txHashes: [{ txHash: '0xrelaybase', chainId: 8453 }] }],
        },
      ],
    };
    const relayClient = {
      chains: [
        {
          id: 8453,
          name: 'base',
          displayName: 'Base',
          currency: {
            address: '0x0000000000000000000000000000000000000000',
            symbol: 'ETH',
            decimals: 18,
          },
        },
      ],
      actions: {
        getQuote: vi.fn(async () => relayQuote),
        execute: vi.fn(async () => ({
          data: relayExecuted,
          abortController: new AbortController(),
        })),
      },
    };
    mockInstance.publicClient.getTransaction
      .mockRejectedValueOnce(new Error('transaction not found'))
      .mockResolvedValue({
        from: '0xmaker',
        nonce: 84,
      });
    mockInstance.createDeposit.mockResolvedValue({ hash: '0xdeposit' });
    mockInstance.publicClient.getTransaction.mockResolvedValue({
      from: '0xmaker',
      nonce: 84,
    });
    mockInstance.publicClient.waitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      logs: [depositReceivedLog(6n)],
    });

    const sameChainSigner = {
      ...signer,
      transport: {
        request: vi
          .fn()
          .mockRejectedValueOnce(new Error('provider timeout'))
          .mockResolvedValueOnce('0x54')
          .mockResolvedValue('0x55'),
      },
    } as unknown as WalletClient;

    await createCashClient({
      environment: 'staging',
      relay: { client: relayClient as never },
    }).cashout(
      {
        amount: 50_000_000_000_000n,
        source: {
          chainId: 8453,
          currency: '0x0000000000000000000000000000000000000000',
        },
        receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@andrew' } },
      },
      { signer: sameChainSigner },
    );

    expect(mockInstance.publicClient.getTransaction).toHaveBeenCalledWith({
      hash: '0xrelaybase',
    });
    expect(mockInstance.publicClient.getTransaction).toHaveBeenCalledTimes(2);
    expect(sameChainSigner.transport.request).toHaveBeenCalledWith({
      method: 'eth_getTransactionCount',
      params: ['0xmaker', 'pending'],
    });
    expect(sameChainSigner.transport.request).toHaveBeenCalledTimes(3);
    expect(mockInstance.createDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        txOverrides: expect.not.objectContaining({ nonce: expect.anything() }),
      }),
    );
  });

  it('does not treat a same-chain Relay batch identifier as a transaction hash', async () => {
    const relayQuote = {
      details: {
        sender: '0xmaker',
        recipient: '0xmaker',
        currencyIn: {
          amount: '50000000000000',
          currency: {
            chainId: 8453,
            address: '0x0000000000000000000000000000000000000000',
            symbol: 'ETH',
            decimals: 18,
          },
        },
        currencyOut: {
          amount: '88800',
          currency: {
            chainId: 8453,
            address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            symbol: 'USDC',
            decimals: 6,
          },
        },
      },
      steps: [],
    };
    const relayExecuted = {
      steps: [
        {
          action: 'swap',
          description: 'Swap ETH to USDC',
          kind: 'transaction',
          id: 'swap',
          requestId: 'relay-base-request',
          items: [
            {
              status: 'complete',
              internalTxHashes: [{ txHash: '0xbundle-id', chainId: 8453, isBatchTx: true }],
            },
          ],
        },
      ],
    };
    const relayClient = {
      chains: [{ id: 8453 }],
      actions: {
        getQuote: vi.fn(async () => relayQuote),
        execute: vi.fn(async () => ({
          data: relayExecuted,
          abortController: new AbortController(),
        })),
      },
    };
    mockInstance.createDeposit.mockResolvedValue({ hash: '0xdeposit' });
    mockInstance.publicClient.getTransaction.mockResolvedValue({
      from: '0xmaker',
      nonce: 84,
    });
    mockInstance.publicClient.waitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      logs: [depositReceivedLog(7n)],
    });
    const batchSigner = {
      ...signer,
      transport: {
        request: vi.fn().mockResolvedValueOnce('0x54').mockResolvedValue('0x55'),
      },
    } as unknown as WalletClient;
    const getCallsStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('wallet temporarily unavailable'))
      .mockResolvedValueOnce({ status: 'pending', statusCode: 100 })
      .mockResolvedValue({
        status: 'success',
        statusCode: 200,
        receipts: [{ transactionHash: '0xbatchtx' }],
      });
    const batchSourceSigner = { ...signer, getCallsStatus } as unknown as WalletClient;

    const cash = createCashClient({
      environment: 'staging',
      relay: { client: relayClient as never },
    });
    const input = {
      amount: 50_000_000_000_000n,
      source: {
        chainId: 8453,
        currency: '0x0000000000000000000000000000000000000000',
      },
      receive: {
        platform: 'venmo' as const,
        currency: 'USD' as const,
        payee: { offchainId: '@andrew' },
      },
    };
    const result = await cash.cashout(input, {
      signer: batchSigner,
      sourceSigner: batchSourceSigner,
    });

    expect(mockInstance.publicClient.getTransaction).toHaveBeenCalledWith({ hash: '0xbatchtx' });
    expect(getCallsStatus).toHaveBeenCalledTimes(3);
    expect(getCallsStatus).toHaveBeenCalledWith({ id: '0xbundle-id' });
    expect(batchSigner.transport.request).toHaveBeenCalledTimes(2);
    expect(mockInstance.createDeposit).toHaveBeenCalledOnce();
    expect(result.source?.transactions?.origin).toEqual([
      { hash: '0xbundle-id', chainId: 8453, isBatchTx: true },
    ]);

    getCallsStatus.mockReset().mockResolvedValue({
      status: 'success',
      statusCode: 200,
    });
    mockInstance.createDeposit.mockClear();

    const receiptless = await cash
      .cashout(input, { signer: batchSigner, sourceSigner: batchSourceSigner })
      .catch((error) => error);

    expect(receiptless).toMatchObject({
      code: 'SOURCE_ROUTE_COMPLETED_CASHOUT_FAILED',
      retryable: false,
      recovery: {
        kind: 'retry-base-usdc-cashout',
        amount: '88800',
        requestId: 'relay-base-request',
        txHashes: ['0xbundle-id'],
      },
    });
    expect(getCallsStatus).toHaveBeenCalledOnce();
    expect(mockInstance.createDeposit).not.toHaveBeenCalled();

    getCallsStatus.mockReset().mockResolvedValue({
      status: 'failure',
      statusCode: 500,
    });
    mockInstance.createDeposit.mockClear();

    const failed = await cash
      .cashout(input, { signer: batchSigner, sourceSigner: batchSourceSigner })
      .catch((error) => error);

    expect(failed).toMatchObject({
      code: 'SOURCE_EXECUTION_FAILED',
      retryable: false,
      recovery: {
        kind: 'inspect-relay-route',
        requestId: 'relay-base-request',
        txHashes: ['0xbundle-id'],
      },
    });
    expect(getCallsStatus).toHaveBeenCalledOnce();
    expect(mockInstance.createDeposit).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'treats a provider timeout as an indeterminate Base submission',
      error: new Error('RPC timed out after sending transaction'),
      code: 'SOURCE_CASHOUT_SUBMISSION_UNKNOWN',
      kind: 'inspect-base-cashout-submission',
    },
    {
      name: 'permits Base-only retry after a nested wallet rejection',
      error: new Error('The on-chain createDeposit call failed', {
        cause: Object.assign(new Error('User rejected the request'), { code: 4001 }),
      }),
      code: 'SOURCE_ROUTE_COMPLETED_CASHOUT_FAILED',
      kind: 'retry-base-usdc-cashout',
    },
  ] as const)('$name', async ({ error, code, kind }) => {
    const relayQuote = {
      details: {
        sender: '0xmaker',
        recipient: '0xmaker',
        currencyIn: {
          amount: '1000000',
          currency: { chainId: 10, address: '0xsource', symbol: 'USDC', decimals: 6 },
        },
        currencyOut: {
          minimumAmount: '990000',
          currency: {
            chainId: 8453,
            address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            symbol: 'USDC',
            decimals: 6,
          },
        },
      },
      steps: [],
    };
    const relayExecuted = {
      details: { currencyIn: { currency: { chainId: 10 } } },
      steps: [
        {
          action: 'bridge',
          description: 'Bridge',
          kind: 'transaction',
          id: 'deposit',
          requestId: 'relay-request',
          items: [{ status: 'complete', txHashes: [{ txHash: '0xrelay', chainId: 10 }] }],
        },
      ],
    };
    const relayClient = {
      chains: [{ id: 10 }],
      actions: {
        getQuote: vi.fn(async () => relayQuote),
        execute: vi.fn(async () => ({
          data: relayExecuted,
          abortController: new AbortController(),
        })),
      },
    };
    mockInstance.createDeposit.mockRejectedValue(error);

    const err = await createCashClient({
      environment: 'staging',
      relay: { client: relayClient as never },
    })
      .cashout(
        {
          amount: 1_000_000n,
          source: { chainId: 10, currency: '0xsource' },
          receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@andrew' } },
        },
        { signer, sourceSigner },
      )
      .catch((error) => error);

    expect(err).toMatchObject({
      code,
      retryable: false,
      recovery: {
        kind,
        amount: '990000',
        requestId: 'relay-request',
        txHashes: ['0xrelay'],
      },
    });
    if (kind === 'inspect-base-cashout-submission') {
      expect(err.recovery.depositor).toBe('0xmaker');
    }
    expect(err.toJSON()).toMatchObject({ recovery: { amount: '990000' } });
  });

  it('preserves both Relay and Base hashes when deposit receipt status is unknown', async () => {
    const relayQuote = {
      details: {
        sender: '0xmaker',
        recipient: '0xmaker',
        currencyIn: {
          amount: '1000000',
          currency: { chainId: 10, address: '0xsource', symbol: 'USDC', decimals: 6 },
        },
        currencyOut: {
          minimumAmount: '990000',
          currency: {
            chainId: 8453,
            address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            symbol: 'USDC',
            decimals: 6,
          },
        },
      },
      steps: [],
    };
    const relayExecuted = {
      details: { currencyIn: { currency: { chainId: 10 } } },
      steps: [
        {
          action: 'bridge',
          description: 'Bridge',
          kind: 'transaction',
          id: 'deposit',
          requestId: 'relay-request',
          items: [{ status: 'complete', txHashes: [{ txHash: '0xrelay', chainId: 10 }] }],
        },
      ],
    };
    const relayClient = {
      chains: [{ id: 10 }],
      actions: {
        getQuote: vi.fn(async () => relayQuote),
        execute: vi.fn(async () => ({
          data: relayExecuted,
          abortController: new AbortController(),
        })),
      },
    };
    mockInstance.createDeposit.mockResolvedValue({ hash: '0xbase-deposit' });
    mockInstance.publicClient.waitForTransactionReceipt.mockRejectedValue(
      new Error('RPC unavailable'),
    );

    const err = await createCashClient({
      environment: 'staging',
      relay: { client: relayClient as never },
    })
      .cashout(
        {
          amount: 1_000_000n,
          source: { chainId: 10, currency: '0xsource' },
          receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@andrew' } },
        },
        { signer, sourceSigner },
      )
      .catch((error) => error);

    expect(err).toMatchObject({
      code: 'SOURCE_CASHOUT_STATUS_UNKNOWN',
      retryable: false,
      recovery: {
        kind: 'inspect-base-cashout-transaction',
        amount: '990000',
        requestId: 'relay-request',
        txHashes: ['0xrelay'],
        depositTxHash: '0xbase-deposit',
      },
    });
  });

  it('requires a source-chain signer for non-Base Relay source cashout', async () => {
    const relayClient = {
      actions: { getQuote: vi.fn() },
    };

    await expect(
      createCashClient({
        environment: 'staging',
        relay: { client: relayClient as never },
      }).cashout(
        {
          amount: 1_000_000n,
          source: { chainId: 10, currency: '0xsource' },
          receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@andrew' } },
        },
        { signer },
      ),
    ).rejects.toMatchObject({ code: 'SIGNER_REQUIRED' });
    expect(relayClient.actions.getQuote).not.toHaveBeenCalled();
  });

  it('registers the payee before executing a Relay source route', async () => {
    const relayQuote = {
      details: {
        sender: '0xmaker',
        recipient: '0xmaker',
        currencyIn: {
          amount: '1000000',
          currency: { chainId: 10, address: '0xsource', symbol: 'USDC', decimals: 6 },
        },
        currencyOut: {
          amount: '4900000',
          currency: {
            chainId: 8453,
            address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            symbol: 'USDC',
            decimals: 6,
          },
        },
      },
      steps: [],
    };
    const relayClient = {
      actions: {
        getQuote: vi.fn(async () => relayQuote),
        execute: vi.fn(async () => {
          throw new Error('execute should not be called');
        }),
      },
    };
    mockInstance.registerPayeeDetails.mockRejectedValue(new Error('curator 500'));

    await expect(
      createCashClient({
        environment: 'staging',
        relay: { client: relayClient as never },
      }).cashout(
        {
          amount: 1_000_000n,
          source: { chainId: 10, currency: '0xsource' },
          receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@andrew' } },
        },
        { signer, sourceSigner },
      ),
    ).rejects.toMatchObject({ code: 'PAYEE_REGISTRATION_FAILED' });

    expect(relayClient.actions.getQuote).toHaveBeenCalledOnce();
    expect(mockInstance.registerPayeeDetails).toHaveBeenCalledOnce();
    expect(relayClient.actions.execute).not.toHaveBeenCalled();
  });

  it('does not execute a Relay source route when Base approval fails first', async () => {
    const relayQuote = {
      details: {
        sender: '0xmaker',
        recipient: '0xmaker',
        currencyIn: {
          amount: '1000000',
          currency: { chainId: 10, address: '0xsource', symbol: 'USDC', decimals: 6 },
        },
        currencyOut: {
          amount: '4900000',
          currency: {
            chainId: 8453,
            address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            symbol: 'USDC',
            decimals: 6,
          },
        },
      },
      steps: [],
    };
    const relayClient = {
      actions: {
        getQuote: vi.fn(async () => relayQuote),
        execute: vi.fn(async () => {
          throw new Error('execute should not be called');
        }),
      },
    };
    const rejection = new Error('The on-chain approve call failed', {
      cause: new Error('User rejected the request.'),
    });
    mockInstance.ensureAllowance.mockRejectedValue(rejection);

    await expect(
      createCashClient({
        environment: 'staging',
        relay: { client: relayClient as never },
      }).cashout(
        {
          amount: 1_000_000n,
          source: { chainId: 10, currency: '0xsource' },
          receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@andrew' } },
        },
        { signer, sourceSigner },
      ),
    ).rejects.toMatchObject({
      code: 'TRANSACTION_REJECTED',
      retryable: true,
      cause: rejection,
    });

    expect(relayClient.actions.getQuote).toHaveBeenCalledOnce();
    expect(mockInstance.registerPayeeDetails).toHaveBeenCalledOnce();
    expect(mockInstance.ensureAllowance).toHaveBeenCalledOnce();
    expect(relayClient.actions.execute).not.toHaveBeenCalled();
  });

  it('rejects a Relay source recipient that differs from the depositor', async () => {
    const relayClient = {
      actions: {
        getQuote: vi.fn(async () => {
          throw new Error('quote should not be called');
        }),
        execute: vi.fn(async () => {
          throw new Error('execute should not be called');
        }),
      },
    };

    await expect(
      createCashClient({
        environment: 'staging',
        relay: { client: relayClient as never },
      }).cashout(
        {
          amount: 1_000_000n,
          source: {
            chainId: 10,
            currency: '0xsource',
            recipient: '0x3333333333333333333333333333333333333333',
          },
          receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@andrew' } },
        },
        { signer, sourceSigner },
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_RECIPIENT_MISMATCH' });

    expect(relayClient.actions.getQuote).not.toHaveBeenCalled();
    expect(relayClient.actions.execute).not.toHaveBeenCalled();
    expect(mockInstance.registerPayeeDetails).not.toHaveBeenCalled();
  });

  it('validates the payout before executing a Relay source route', async () => {
    const relayClient = {
      actions: {
        getQuote: vi.fn(async () => {
          throw new Error('quote should not be called');
        }),
        execute: vi.fn(async () => {
          throw new Error('execute should not be called');
        }),
      },
    };

    await expect(
      createCashClient({
        environment: 'staging',
        relay: { client: relayClient as never },
      }).cashout(
        {
          amount: 1_000_000n,
          source: { chainId: 10, currency: '0xsource' },
          receive: { platform: 'not-a-platform', currency: 'USD', payee: { offchainId: '@a' } },
        },
        { signer, sourceSigner },
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });

    expect(relayClient.actions.getQuote).not.toHaveBeenCalled();
    expect(relayClient.actions.execute).not.toHaveBeenCalled();
    expect(mockInstance.registerPayeeDetails).not.toHaveBeenCalled();
  });

  it('rejects dust Relay output before executing the source route', async () => {
    const relayQuote = {
      details: {
        sender: '0xmaker',
        recipient: '0xmaker',
        currencyIn: {
          amount: '1000000',
          currency: { chainId: 10, address: '0xsource', symbol: 'USDC', decimals: 6 },
        },
        currencyOut: {
          amount: '9999',
          currency: {
            chainId: 8453,
            address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            symbol: 'USDC',
            decimals: 6,
          },
        },
      },
      steps: [],
    };
    const relayClient = {
      actions: {
        getQuote: vi.fn(async () => relayQuote),
        execute: vi.fn(async () => {
          throw new Error('execute should not be called');
        }),
      },
    };

    await expect(
      createCashClient({
        environment: 'staging',
        relay: { client: relayClient as never },
      }).cashout(
        {
          amount: 1_000_000n,
          source: { chainId: 10, currency: '0xsource' },
          receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@andrew' } },
        },
        { signer, sourceSigner },
      ),
    ).rejects.toMatchObject({ code: 'AMOUNT_BELOW_MINIMUM' });

    expect(relayClient.actions.getQuote).toHaveBeenCalledOnce();
    expect(relayClient.actions.execute).not.toHaveBeenCalled();
    expect(mockInstance.registerPayeeDetails).not.toHaveBeenCalled();
  });

  it('requires a signer', async () => {
    await expect(
      client().cashout(
        {
          amount: 5_000_000n,
          receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@a' } },
        },
        { signer: {} as WalletClient },
      ),
    ).rejects.toMatchObject({ code: 'SIGNER_REQUIRED' });
  });

  it('rejects a Base mutation signer that is connected to another chain', async () => {
    const wrongChainSigner = {
      account: { address: '0xmaker' },
      chain: { id: 10 },
      getChainId: vi.fn(async () => 10),
    } as unknown as WalletClient;

    await expect(
      client().cashout(
        {
          amount: 5_000_000n,
          receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@a' } },
        },
        { signer: wrongChainSigner },
      ),
    ).rejects.toMatchObject({
      code: 'SIGNER_CHAIN_MISMATCH',
      retryable: false,
    });
    expect(mockInstance.registerPayeeDetails).not.toHaveBeenCalled();
  });

  it('checks the live chain id for a chainless Base wallet before any side effect', async () => {
    const chainlessWrongSigner = {
      account: { address: '0xmaker' },
      chain: undefined,
      getChainId: vi.fn(async () => 10),
    } as unknown as WalletClient;

    await expect(
      client().cashout(
        {
          amount: 5_000_000n,
          receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@a' } },
        },
        { signer: chainlessWrongSigner },
      ),
    ).rejects.toMatchObject({ code: 'SIGNER_CHAIN_MISMATCH' });
    expect(chainlessWrongSigner.getChainId).toHaveBeenCalledOnce();
    expect(mockInstance.registerPayeeDetails).not.toHaveBeenCalled();
  });

  it('returns a typed error when a chainless wallet cannot report its chain', async () => {
    const disconnectedSigner = {
      account: { address: '0xmaker' },
      chain: undefined,
      getChainId: vi.fn(async () => {
        throw new Error('wallet disconnected');
      }),
    } as unknown as WalletClient;

    await expect(
      client().cashout(
        {
          amount: 5_000_000n,
          receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@a' } },
        },
        { signer: disconnectedSigner },
      ),
    ).rejects.toMatchObject({ code: 'SIGNER_CHAIN_UNAVAILABLE', retryable: true });
    expect(mockInstance.registerPayeeDetails).not.toHaveBeenCalled();
  });

  it('rejects a Relay source signer connected to a different source chain', async () => {
    const relayClient = { actions: { getQuote: vi.fn() } };
    const wrongSourceSigner = {
      account: { address: '0xmaker' },
      chain: { id: 42161 },
      getChainId: vi.fn(async () => 42161),
    } as unknown as WalletClient;

    await expect(
      createCashClient({
        environment: 'staging',
        relay: { client: relayClient as never },
      }).cashout(
        {
          amount: 1_000_000n,
          source: { chainId: 10, currency: '0xsource' },
          receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@a' } },
        },
        { signer, sourceSigner: wrongSourceSigner },
      ),
    ).rejects.toMatchObject({ code: 'SIGNER_CHAIN_MISMATCH' });
    expect(relayClient.actions.getQuote).not.toHaveBeenCalled();
  });

  it('rejects unsupported platform before any network call', async () => {
    await expect(
      client().cashout(
        {
          amount: 5_000_000n,
          receive: { platform: 'not-a-platform', currency: 'USD', payee: { offchainId: '@a' } },
        },
        { signer },
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
    expect(mockInstance.registerPayeeDetails).not.toHaveBeenCalled();
  });

  it('rejects unsupported currency before any network call', async () => {
    await expect(
      client().cashout(
        {
          amount: 5_000_000n,
          receive: { platform: 'venmo', currency: 'XYZ' as never, payee: { offchainId: '@a' } },
        },
        { signer },
      ),
    ).rejects.toMatchObject({ code: 'ORACLE_UNSUPPORTED_CURRENCY' });
  });

  it('rejects an oracle-supported currency that the payout platform cannot receive', async () => {
    await expect(
      client().cashout(
        {
          amount: 5_000_000n,
          receive: { platform: 'venmo', currency: 'EUR', payee: { offchainId: '@a' } },
        },
        { signer },
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM_CURRENCY', retryable: false });
    expect(mockInstance.registerPayeeDetails).not.toHaveBeenCalled();
  });

  it('rejects an invalid intent amount range before registering the payee', async () => {
    await expect(
      client().cashout(
        {
          amount: 5_000_000n,
          intentAmountRange: { min: 4_000_000n, max: 3_000_000n },
          receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@a' } },
        },
        { signer },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT_AMOUNT_RANGE', retryable: false });
    expect(mockInstance.registerPayeeDetails).not.toHaveBeenCalled();
  });

  it('maps curator failures to PAYEE_REGISTRATION_FAILED', async () => {
    mockInstance.registerPayeeDetails.mockRejectedValue(new Error('curator 500'));
    await expect(
      client().cashout(
        {
          amount: 5_000_000n,
          receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@a' } },
        },
        { signer },
      ),
    ).rejects.toMatchObject({ code: 'PAYEE_REGISTRATION_FAILED', retryable: true });
  });

  it('surfaces DEPOSIT_RESOLUTION_FAILED when the receipt has no DepositReceived', async () => {
    mockInstance.createDeposit.mockResolvedValue({ hash: '0xhash' });
    mockInstance.publicClient.waitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      logs: [],
    });
    await expect(
      client().cashout(
        {
          amount: 5_000_000n,
          receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@a' } },
        },
        { signer },
      ),
    ).rejects.toMatchObject({ code: 'DEPOSIT_RESOLUTION_FAILED' });
  });
});

describe('prepare()', () => {
  it('returns [approve, createDeposit] unsigned txs and the payee hashes', async () => {
    mockInstance.prepareCreateDeposit.mockResolvedValue({
      depositDetails: [{}],
      prepared: { to: ESCROW, data: '0xdeposit', value: 0n, chainId: 8453 },
    });

    const { txs, steps, register } = await client().prepare({
      amount: 5_000_000n,
      receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@a' } },
    });

    expect(txs).toHaveLength(2);
    expect(steps.map((s) => s.kind)).toEqual(['approve', 'createDeposit']);
    expect(txs[0]?.to.toLowerCase()).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'); // USDC approve
    expect(txs[0]?.data.startsWith('0x095ea7b3')).toBe(true); // approve selector
    expect(txs[1]).toMatchObject({ to: ESCROW, data: '0xdeposit' });
    expect(register.hashedOnchainIds).toEqual(['0xpayeehash']);
    // No signing surface touched.
    expect(mockInstance.createDeposit).not.toHaveBeenCalled();
    expect(mockInstance.ensureAllowance).not.toHaveBeenCalled();
  });

  it('creates a prepared Zelle cashout with only the generic method', async () => {
    const payeeHashes = ['0xzelle'];
    mockInstance.registerPayeeDetails.mockResolvedValue({
      depositDetails: payeeHashes.map(() => ({})),
      hashedOnchainIds: payeeHashes,
    });
    mockInstance.prepareCreateDeposit.mockResolvedValue({
      depositDetails: payeeHashes.map(() => ({})),
      prepared: { to: ESCROW, data: '0xdeposit', value: 0n, chainId: 8453 },
    });

    const result = await client().prepare({
      amount: 5_000_000n,
      receive: { platform: 'zelle', currency: 'USD', payee: { offchainId: '+12025550123' } },
    });

    const methods = ['zelle'];
    expect(mockInstance.registerPayeeDetails).toHaveBeenCalledWith({
      processorNames: methods,
      payeeData: methods.map(() => ({ offchainId: '+12025550123' })),
    });
    expect(mockInstance.prepareCreateDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        processorNames: methods,
        paymentMethodsOverride: methods.map(
          (method) => getPaymentMethodsCatalog(8453, 'staging')[method]!.paymentMethodHash,
        ),
      }),
    );
    expect(result.register.hashedOnchainIds).toEqual(payeeHashes);
  });

  it('rejects Relay source routing because prepare cannot execute the bridge pre-step', async () => {
    await expect(
      client().prepare({
        amount: 1_000_000n,
        source: { chainId: 10, currency: '0xsource' },
        receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@a' } },
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_ROUTE_UNSUPPORTED_IN_PREPARE' });
    expect(mockInstance.prepareCreateDeposit).not.toHaveBeenCalled();
  });
});

describe('withdraw()', () => {
  it('rejects a malformed deposit id before any indexer or chain call', async () => {
    await expect(client().withdraw(`${ESCROW}_`, { signer })).rejects.toMatchObject({
      code: 'INVALID_DEPOSIT_ID',
      retryable: false,
    });
    expect(mockInstance.indexer.getDepositsByIdsWithRelations).not.toHaveBeenCalled();
    expect(mockInstance.withdrawDeposit).not.toHaveBeenCalled();
  });

  it('blocks conservatively when the indexer reports locked funds without intent detail', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([
      depositRow({
        remainingDeposits: '4000000',
        outstandingIntentAmount: '1000000',
        intents: [],
      }),
    ]);

    await expect(client().withdraw(DEPOSIT_ID, { signer })).rejects.toMatchObject({
      code: 'ACTIVE_INTENT_BLOCKS_WITHDRAWAL',
      retryable: true,
    });
    expect(mockInstance.withdrawDeposit).not.toHaveBeenCalled();
  });

  it('blocks while a live buyer intent locks funds', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([
      depositRow({
        remainingDeposits: '4000000',
        outstandingIntentAmount: '1000000',
        intents: [
          {
            intentHash: '0xa',
            status: 'SIGNALED',
            amount: '1000000',
            owner: '0xbuyer',
            expiryTime: String(NOW + 3600),
          },
        ],
      }),
    ]);
    await expect(client().withdraw(DEPOSIT_ID, { signer })).rejects.toMatchObject({
      code: 'ACTIVE_INTENT_BLOCKS_WITHDRAWAL',
      retryable: true,
    });
    expect(mockInstance.withdrawDeposit).not.toHaveBeenCalled();
  });

  it('withdraws directly while awaiting-buyer', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([depositRow()]);
    mockInstance.withdrawDeposit.mockResolvedValue('0xw');
    mockInstance.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });

    const result = await client().withdraw(DEPOSIT_ID, { signer });
    expect(result.withdrawTxHash).toBe('0xw');
    expect(result.pruneTxHash).toBeUndefined();
    expect(mockInstance.pruneExpiredIntents).not.toHaveBeenCalled();
    expect(mockInstance.withdrawDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ depositId: 5n, escrowAddress: ESCROW }),
    );
  });

  it('prunes expired intents first, then withdraws', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([
      depositRow({
        remainingDeposits: '4000000',
        outstandingIntentAmount: '1000000',
        intents: [
          {
            intentHash: '0xa',
            status: 'SIGNALED',
            amount: '1000000',
            owner: '0xbuyer',
            expiryTime: String(NOW - 60), // expired
          },
        ],
      }),
    ]);
    mockInstance.pruneExpiredIntents.mockResolvedValue('0xp');
    mockInstance.withdrawDeposit.mockResolvedValue('0xw');
    mockInstance.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });

    const result = await client().withdraw(DEPOSIT_ID, { signer });
    expect(result.pruneTxHash).toBe('0xp');
    expect(result.withdrawTxHash).toBe('0xw');
    expect(mockInstance.pruneExpiredIntents).toHaveBeenCalledWith(
      expect.objectContaining({ depositId: 5n }),
    );
  });

  it('rejects terminal orders with NOTHING_TO_WITHDRAW', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([
      depositRow({ remainingDeposits: '0', totalWithdrawn: '5000000', status: 'WITHDRAWN' }),
    ]);
    await expect(client().withdraw(DEPOSIT_ID, { signer })).rejects.toMatchObject({
      code: 'NOTHING_TO_WITHDRAW',
    });
  });

  it('requires a signer', async () => {
    await expect(
      client().withdraw(DEPOSIT_ID, { signer: {} as WalletClient }),
    ).rejects.toMatchObject({ code: 'SIGNER_REQUIRED' });
  });
});

describe('watch()', () => {
  it('yields on change, tolerates early indexer lag, ends at terminal state', async () => {
    const sequence = [
      [], // not indexed yet → ORDER_NOT_FOUND internally, keep polling
      [depositRow()],
      [depositRow()], // unchanged → no yield
      [
        depositRow({
          remainingDeposits: '0',
          totalWithdrawn: '5000000',
          status: 'WITHDRAWN',
        }),
      ],
    ];
    let call = 0;
    mockInstance.indexer.getDepositsByIdsWithRelations.mockImplementation(async () => {
      const step = sequence[Math.min(call, sequence.length - 1)];
      call += 1;
      return step;
    });
    mockInstance.indexer.getIntentsForDeposits.mockResolvedValue([]);

    const seen: string[] = [];
    for await (const order of client().watch(DEPOSIT_ID, { pollIntervalMs: 1 })) {
      seen.push(order.state);
    }
    expect(seen).toEqual(['awaiting-buyer', 'returned']);
  });

  it('throws WATCH_TIMEOUT when the order never terminates', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([depositRow()]);
    const iterate = async () => {
      for await (const order of client().watch(DEPOSIT_ID, {
        pollIntervalMs: 1,
        timeoutMs: 25,
      })) {
        void order;
      }
    };
    await expect(iterate()).rejects.toMatchObject({ code: 'WATCH_TIMEOUT', retryable: true });
  });

  it('stops cleanly on abort', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([depositRow()]);
    const controller = new AbortController();
    const seen: string[] = [];
    for await (const order of client().watch(DEPOSIT_ID, {
      pollIntervalMs: 1,
      signal: controller.signal,
    })) {
      seen.push(order.state);
      controller.abort();
    }
    expect(seen).toEqual(['awaiting-buyer']);
  });
});

describe('order() enrichment', () => {
  it('reconstructs decoded payout legs from deposit relations', async () => {
    const { getPaymentMethodsCatalog, currencyInfo } =
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports
      await vi.importActual<typeof import('@zkp2p/sdk')>('@zkp2p/sdk');
    const catalog = getPaymentMethodsCatalog(8453, 'staging');
    const zelleHash = catalog['zelle']!.paymentMethodHash;

    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([
      depositRow({
        successRateBps: 10_000,
        paymentMethods: [
          { paymentMethodHash: zelleHash, payeeDetailsHash: '0xpayee', active: true },
        ],
        currencies: [
          {
            paymentMethodHash: zelleHash,
            currencyCode: currencyInfo['USD']!.currencyCodeHash,
            spreadBps: 0,
            kind: 'oracle_chainlink',
            rateSource: 'ORACLE',
          },
        ],
      }),
    ]);

    const order = await client().order(DEPOSIT_ID);
    expect(order.successRateBps).toBe(10_000);
    expect(order.payouts).toHaveLength(1);
    expect(order.payouts?.[0]).toMatchObject({
      platform: 'zelle',
      currency: 'USD',
      payeeHash: '0xpayee',
      pricing: expect.objectContaining({ marketRate: true, spreadBps: 0 }),
    });
  });
});

describe('buyer()', () => {
  it('aggregates the buyer profile from their intent history', async () => {
    mockInstance.indexer.getOwnerIntents.mockResolvedValue([
      { intentHash: '0x1', status: 'FULFILLED', signalTimestamp: String(NOW - 500) },
      { intentHash: '0x2', status: 'PRUNED', signalTimestamp: String(NOW - 400) },
      { intentHash: '0x3', status: 'SIGNALED', signalTimestamp: String(NOW - 10) },
    ]);
    const profile = await client().buyer('0xBuyer');
    expect(mockInstance.indexer.getOwnerIntents).toHaveBeenCalledWith('0xBuyer', [
      'SIGNALED',
      'FULFILLED',
      'PRUNED',
      'MANUALLY_RELEASED',
    ]);
    expect(profile).toMatchObject({
      address: '0xbuyer',
      totalIntents: 3,
      fulfilled: 1,
      pruned: 1,
      signaled: 1,
      successRateBps: 5000,
    });
  });

  it('wraps profile-query transport failures instead of leaking raw errors', async () => {
    mockInstance.indexer.getOwnerIntents.mockRejectedValue(new Error('indexer unavailable'));

    await expect(client().buyer('0xBuyer')).rejects.toMatchObject({
      code: 'INDEXER_UNAVAILABLE',
      retryable: true,
    });
  });
});

describe('ERC-8021 attribution', () => {
  it('cashout stamps peer-cash on approve and createDeposit', async () => {
    mockInstance.createDeposit.mockResolvedValue({ hash: '0xhash' });
    mockInstance.publicClient.waitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      logs: [depositReceivedLog(5n)],
    });

    await client().cashout(
      {
        amount: 5_000_000n,
        receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@a' } },
      },
      { signer },
    );

    expect(mockInstance.ensureAllowance).toHaveBeenCalledWith(
      expect.objectContaining({ txOverrides: { referrer: [CASH_ATTRIBUTION_CODE] } }),
    );
    expect(mockInstance.createDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ txOverrides: { referrer: [CASH_ATTRIBUTION_CODE] } }),
    );
  });

  it('integrator referrer codes stack after peer-cash', async () => {
    const cash = createCashClient({ environment: 'staging', referrer: 'acme-app' });
    mockInstance.createDeposit.mockResolvedValue({ hash: '0xhash' });
    mockInstance.publicClient.waitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      logs: [depositReceivedLog(5n)],
    });

    await cash.cashout(
      {
        amount: 5_000_000n,
        receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@a' } },
      },
      { signer },
    );

    expect(mockInstance.createDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        txOverrides: { referrer: [CASH_ATTRIBUTION_CODE, 'acme-app'] },
      }),
    );
  });

  it('prepare() appends the attribution suffix to the manual approve calldata', async () => {
    mockInstance.prepareCreateDeposit.mockResolvedValue({
      depositDetails: [{}],
      prepared: { to: ESCROW, data: '0xdeposit', value: 0n, chainId: 8453 },
    });

    const { txs } = await client().prepare({
      amount: 5_000_000n,
      receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@a' } },
    });

    const suffix = getAttributionDataSuffix([CASH_ATTRIBUTION_CODE]).slice(2);
    expect(txs[0]?.data.endsWith(suffix)).toBe(true);
    expect(mockInstance.prepareCreateDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ txOverrides: { referrer: [CASH_ATTRIBUTION_CODE] } }),
    );
  });
});

describe('topUp()', () => {
  it('settles allowance against the order escrow, then adds funds', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([depositRow()]);
    mockInstance.addFunds.mockResolvedValue('0xtopup');
    mockInstance.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });

    const result = await client().topUp(DEPOSIT_ID, 2_000_000n, { signer });

    expect(mockInstance.ensureAllowance).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2_000_000n, spender: ESCROW }),
    );
    expect(mockInstance.addFunds).toHaveBeenCalledWith(
      expect.objectContaining({
        depositId: 5n,
        amount: 2_000_000n,
        escrowAddress: ESCROW,
        txOverrides: { referrer: [CASH_ATTRIBUTION_CODE] },
      }),
    );
    expect(result).toEqual({ depositId: DEPOSIT_ID, txHash: '0xtopup' });
  });

  it('rejects terminal orders with ORDER_NOT_ACTIVE', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([
      depositRow({ remainingDeposits: '0', totalWithdrawn: '5000000', status: 'WITHDRAWN' }),
    ]);
    await expect(client().topUp(DEPOSIT_ID, 2_000_000n, { signer })).rejects.toMatchObject({
      code: 'ORDER_NOT_ACTIVE',
      retryable: false,
    });
    expect(mockInstance.addFunds).not.toHaveBeenCalled();
  });

  it('rejects dust amounts before any network call', async () => {
    await expect(client().topUp(DEPOSIT_ID, 9_999n, { signer })).rejects.toMatchObject({
      code: 'AMOUNT_BELOW_MINIMUM',
    });
    expect(mockInstance.indexer.getDepositsByIdsWithRelations).not.toHaveBeenCalled();
  });

  it('requires a signer', async () => {
    await expect(
      client().topUp(DEPOSIT_ID, 2_000_000n, { signer: {} as WalletClient }),
    ).rejects.toMatchObject({ code: 'SIGNER_REQUIRED' });
  });

  it('prepareTopUp returns [approve, addFunds] unsigned txs', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([depositRow()]);
    mockInstance.addFunds.prepare.mockResolvedValue({
      to: ESCROW,
      data: '0xaddfunds',
      value: 0n,
      chainId: 8453,
    });

    const { txs, steps } = await client().prepareTopUp(DEPOSIT_ID, 2_000_000n);
    expect(txs).toHaveLength(2);
    expect(steps.map((s) => s.kind)).toEqual(['approve', 'addFunds']);
    expect(txs[0]?.to.toLowerCase()).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    expect(txs[0]?.data.startsWith('0x095ea7b3')).toBe(true);
    expect(txs[1]).toMatchObject({ to: ESCROW, data: '0xaddfunds' });
  });
});

describe('withdraw() - partial', () => {
  it('withdraws a partial amount via removeFunds', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([depositRow()]);
    mockInstance.removeFunds.mockResolvedValue('0xpartial');
    mockInstance.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });

    const result = await client().withdraw(DEPOSIT_ID, { signer, amount: 2_000_000n });
    expect(mockInstance.removeFunds).toHaveBeenCalledWith(
      expect.objectContaining({ depositId: 5n, amount: 2_000_000n }),
    );
    expect(mockInstance.withdrawDeposit).not.toHaveBeenCalled();
    expect(result.withdrawTxHash).toBe('0xpartial');
  });

  it('a live buyer intent does NOT block partial withdrawal of unlocked funds', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([
      depositRow({
        remainingDeposits: '4000000',
        outstandingIntentAmount: '1000000',
        intents: [
          {
            intentHash: '0xa',
            status: 'SIGNALED',
            amount: '1000000',
            owner: '0xbuyer',
            expiryTime: String(NOW + 3600),
          },
        ],
      }),
    ]);
    mockInstance.removeFunds.mockResolvedValue('0xpartial');
    mockInstance.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });

    const result = await client().withdraw(DEPOSIT_ID, { signer, amount: 4_000_000n });
    expect(result.withdrawTxHash).toBe('0xpartial');
  });

  it('rejects amounts above the unlocked balance', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([
      depositRow({ remainingDeposits: '4000000', outstandingIntentAmount: '1000000' }),
    ]);
    await expect(
      client().withdraw(DEPOSIT_ID, { signer, amount: 4_500_000n }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_AVAILABLE_FUNDS', retryable: true });
    expect(mockInstance.removeFunds).not.toHaveBeenCalled();
  });
});

describe('prepareWithdraw()', () => {
  it('labels direct full-close withdraw txs', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([depositRow()]);
    mockInstance.withdrawDeposit.prepare.mockResolvedValue({
      to: ESCROW,
      data: '0xwithdraw',
      value: 0n,
      chainId: 8453,
    });

    const { txs, steps } = await client().prepareWithdraw(DEPOSIT_ID);
    expect(txs).toHaveLength(1);
    expect(steps.map((s) => s.kind)).toEqual(['withdrawDeposit']);
  });

  it('labels prune + withdraw when an expired intent must be cleared first', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([
      depositRow({
        remainingDeposits: '4000000',
        outstandingIntentAmount: '1000000',
        intents: [
          {
            intentHash: '0xa',
            status: 'SIGNALED',
            amount: '1000000',
            owner: '0xbuyer',
            expiryTime: String(NOW - 60),
          },
        ],
      }),
    ]);
    mockInstance.pruneExpiredIntents.prepare.mockResolvedValue({
      to: ESCROW,
      data: '0xprune',
      value: 0n,
      chainId: 8453,
    });
    mockInstance.withdrawDeposit.prepare.mockResolvedValue({
      to: ESCROW,
      data: '0xwithdraw',
      value: 0n,
      chainId: 8453,
    });

    const { txs, steps } = await client().prepareWithdraw(DEPOSIT_ID);
    expect(txs).toHaveLength(2);
    expect(steps.map((s) => s.kind)).toEqual(['pruneExpiredIntents', 'withdrawDeposit']);
  });

  it('labels partial withdraw txs', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([depositRow()]);
    mockInstance.removeFunds.prepare.mockResolvedValue({
      to: ESCROW,
      data: '0xremove',
      value: 0n,
      chainId: 8453,
    });

    const { txs, steps } = await client().prepareWithdraw(DEPOSIT_ID, { amount: 2_000_000n });
    expect(txs).toHaveLength(1);
    expect(steps.map((s) => s.kind)).toEqual(['removeFunds']);
  });
});

describe('withdraw() - receipt safety and error mapping', () => {
  it('classifies a nested wallet cancellation as retryable', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([depositRow()]);
    mockInstance.withdrawDeposit.mockRejectedValue(
      new Error('The on-chain withdraw call failed', {
        cause: Object.assign(new Error('Request denied by user'), { code: 4001 }),
      }),
    );

    await expect(client().withdraw(DEPOSIT_ID, { signer })).rejects.toMatchObject({
      code: 'TRANSACTION_REJECTED',
      retryable: true,
      recovery: undefined,
    });
  });

  it('does not invite a duplicate submission when receipt status is unknown', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([depositRow()]);
    mockInstance.withdrawDeposit.mockResolvedValue('0xw');
    mockInstance.publicClient.waitForTransactionReceipt.mockRejectedValue(
      new Error('RPC unavailable'),
    );

    await expect(client().withdraw(DEPOSIT_ID, { signer })).rejects.toMatchObject({
      code: 'TRANSACTION_STATUS_UNKNOWN',
      retryable: false,
      message: expect.stringContaining('0xw'),
      recovery: {
        kind: 'inspect-base-transaction',
        transactionHash: '0xw',
        operation: 'withdrawDeposit',
      },
    });
  });

  it('throws TRANSACTION_FAILED when the full withdraw reverts (never false success)', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([depositRow()]);
    mockInstance.withdrawDeposit.mockResolvedValue('0xw');
    mockInstance.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });

    await expect(client().withdraw(DEPOSIT_ID, { signer })).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
    });
  });

  it('throws TRANSACTION_FAILED when a partial withdraw reverts', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([depositRow()]);
    mockInstance.removeFunds.mockResolvedValue('0xpartial');
    mockInstance.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });

    await expect(
      client().withdraw(DEPOSIT_ID, { signer, amount: 2_000_000n }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
  });

  it('maps a raw "paused" revert on withdrawDeposit to ESCROW_PAUSED', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([depositRow()]);
    mockInstance.withdrawDeposit.mockRejectedValue(
      new Error('execution reverted: Pausable: paused'),
    );
    await expect(client().withdraw(DEPOSIT_ID, { signer })).rejects.toMatchObject({
      code: 'ESCROW_PAUSED',
      retryable: true,
    });
  });

  it('treats an ambiguous mutation submission as indeterminate (no blind retry)', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([depositRow()]);
    mockInstance.withdrawDeposit.mockRejectedValue(new Error('nonce too low'));
    const err = await client()
      .withdraw(DEPOSIT_ID, { signer })
      .catch((e) => e);
    expect(isCashError(err)).toBe(true);
    expect(err.code).toBe('TRANSACTION_SUBMISSION_UNKNOWN');
    expect(err.retryable).toBe(false);
    expect(err.recovery).toMatchObject({
      kind: 'inspect-base-operation-submission',
      operation: 'withdrawDeposit',
    });
  });
});

describe('cashout() - allowance visibility', () => {
  it('does not misclassify an insufficient token balance as stale allowance', async () => {
    mockInstance.ensureAllowance.mockRejectedValue(
      new Error('ERC20: transfer amount exceeds balance'),
    );

    await expect(
      client().cashout(
        {
          amount: 5_000_000n,
          receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@a' } },
        },
        { signer },
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_TOKEN_BALANCE', retryable: false });
  });

  it('throws retryable ALLOWANCE_NOT_VISIBLE when the approve never surfaces', async () => {
    vi.useFakeTimers();
    try {
      mockInstance.ensureAllowance.mockResolvedValue({ hadAllowance: false, hash: '0xapprove' });
      // approve receipt is fine, but the read path never shows the allowance
      mockInstance.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });
      mockInstance.publicClient.readContract.mockResolvedValue(0n);

      const promise = client()
        .cashout(
          {
            amount: 5_000_000n,
            receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@a' } },
          },
          { signer },
        )
        .catch((e) => e);
      await vi.runAllTimersAsync();
      const err = await promise;
      expect(isCashError(err)).toBe(true);
      expect(err.code).toBe('ALLOWANCE_NOT_VISIBLE');
      expect(err.retryable).toBe(true);
      expect(mockInstance.createDeposit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('wraps allowance-read RPC failures after a mined approval', async () => {
    vi.useFakeTimers();
    try {
      mockInstance.ensureAllowance.mockResolvedValue({ hadAllowance: false, hash: '0xapprove' });
      mockInstance.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });
      mockInstance.publicClient.readContract.mockRejectedValue(new Error('RPC read failed'));

      const promise = client()
        .cashout(
          {
            amount: 5_000_000n,
            receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@a' } },
          },
          { signer },
        )
        .catch((error) => error);
      await vi.runAllTimersAsync();
      const err = await promise;

      expect(err).toMatchObject({ code: 'ALLOWANCE_NOT_VISIBLE', retryable: true });
      expect(isCashError(err)).toBe(true);
      expect(mockInstance.createDeposit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('orders() - list-row nextActions honesty', () => {
  it('does NOT offer withdraw on a matched row (outstanding lock, no fill detail)', async () => {
    mockInstance.indexer.getDepositsWithRelations.mockResolvedValue([
      depositRow({
        id: 'a_1',
        remainingDeposits: '4000000',
        outstandingIntentAmount: '1000000',
        // list query returns no intents
      }),
    ]);
    const orders = await client().orders('0xmaker');
    expect(orders[0]?.state).toBe('matched');
    expect(orders[0]?.nextActions).toEqual(['wait']);
  });
});

describe('cashout() - verified platforms', () => {
  it('reuses a pre-registered Wise payee without requiring a new attestation', async () => {
    mockInstance.createDeposit.mockResolvedValue({ hash: '0xhash' });
    mockInstance.publicClient.waitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      logs: [depositReceivedLog(5n)],
    });

    await client().cashout(
      {
        amount: 5_000_000n,
        receive: { platform: 'wise', currency: 'USD', payee: { offchainId: 'wisetag' } },
      },
      { signer },
    );

    expect(mockInstance.registerPayeeDetails).toHaveBeenCalledOnce();
  });

  it('maps a missing Wise identity attestation reported by the curator', async () => {
    mockInstance.registerPayeeDetails.mockRejectedValue(
      new Error('identityAttestation is required for unregistered Wise payees'),
    );

    await expect(
      client().cashout(
        {
          amount: 5_000_000n,
          receive: { platform: 'wise', currency: 'USD', payee: { offchainId: 'new-wisetag' } },
        },
        { signer },
      ),
    ).rejects.toMatchObject({ code: 'PAYEE_VERIFICATION_REQUIRED', retryable: false });
    expect(mockInstance.registerPayeeDetails).toHaveBeenCalledOnce();
    expect(mockInstance.ensureAllowance).not.toHaveBeenCalled();
  });

  it('allows wise when an identity attestation is supplied', async () => {
    mockInstance.createDeposit.mockResolvedValue({ hash: '0xhash' });
    mockInstance.publicClient.waitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      logs: [depositReceivedLog(5n)],
    });
    await client().cashout(
      {
        amount: 5_000_000n,
        receive: {
          platform: 'wise',
          currency: 'USD',
          payee: { offchainId: 'wisetag', identityAttestation: { sig: '0x' } } as never,
        },
      },
      { signer },
    );
    expect(mockInstance.registerPayeeDetails).toHaveBeenCalledOnce();
  });
});

describe('typed errors', () => {
  it('CashError serializes for tool results', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([]);
    mockInstance.indexer.getIntentsForDeposits.mockResolvedValue([]);
    try {
      await client().order(DEPOSIT_ID);
      expect.unreachable();
    } catch (err) {
      expect(isCashError(err)).toBe(true);
      if (isCashError(err)) {
        const json = err.toJSON();
        expect(json).toMatchObject({ code: 'ORDER_NOT_FOUND', retryable: true });
        expect(json.remediation.length).toBeGreaterThan(10);
      }
    }
  });
});
