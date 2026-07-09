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
  return { ...actual, Zkp2pClient: vi.fn(() => mockInstance) };
});

import { getAttributionDataSuffix } from '@zkp2p/sdk';
import { createCashClient, CASH_ATTRIBUTION_CODE } from '../src/client/createCashClient';
import { isCashError } from '../src/client/errors';

const NOW = Math.floor(Date.now() / 1000);
const ESCROW = '0x1111111111111111111111111111111111111111';
const DEPOSIT_ID = `${ESCROW}_5`;

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

const signer = { account: { address: '0xmaker' } } as unknown as WalletClient;

function depositRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DEPOSIT_ID,
    remainingDeposits: '5000000',
    outstandingIntentAmount: '0',
    totalAmountTaken: '0',
    totalWithdrawn: '0',
    status: 'ACTIVE',
    totalIntents: 0,
    updatedAt: String(NOW - 30),
    intents: [],
    ...overrides,
  };
}

function client() {
  return createCashClient({ environment: 'staging' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInstance.escrowV2Abi = DEPOSIT_RECEIVED_ABI;
  mockInstance.registerPayeeDetails.mockResolvedValue({
    depositDetails: [{}],
    hashedOnchainIds: ['0xpayeehash'],
  });
  mockInstance.ensureAllowance.mockResolvedValue({ hadAllowance: true });
});

describe('order()', () => {
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
});

describe('orders()', () => {
  it('filters dust and sorts most-recent-first', async () => {
    mockInstance.indexer.getDeposits.mockResolvedValue([
      depositRow({ id: 'a_1', updatedAt: String(NOW - 100) }),
      depositRow({ id: 'a_2', remainingDeposits: '5', updatedAt: String(NOW - 10) }), // dust
      depositRow({ id: 'a_3', updatedAt: String(NOW - 50) }),
    ]);
    const orders = await client().orders('0xmaker');
    expect(orders.map((o) => o.depositId)).toEqual(['a_3', 'a_1']);
  });

  it('inFlight filters to live orders only', async () => {
    mockInstance.indexer.getDeposits.mockResolvedValue([
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

  it('can route a Relay source to Base USDC before creating the cash-out', async () => {
    const relayQuote = {
      details: {
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
      { signer, sourceSigner: signer },
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
      expect.objectContaining({ quote: relayQuote, wallet: signer }),
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
        { signer, sourceSigner: signer },
      ),
    ).rejects.toMatchObject({ code: 'PAYEE_REGISTRATION_FAILED' });

    expect(relayClient.actions.getQuote).toHaveBeenCalledOnce();
    expect(mockInstance.registerPayeeDetails).toHaveBeenCalledOnce();
    expect(relayClient.actions.execute).not.toHaveBeenCalled();
  });

  it('does not execute a Relay source route when Base approval fails first', async () => {
    const relayQuote = {
      details: {
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
    mockInstance.ensureAllowance.mockRejectedValue(new Error('approve rejected'));

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
        { signer, sourceSigner: signer },
      ),
    ).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });

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
        { signer, sourceSigner: signer },
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
        { signer, sourceSigner: signer },
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });

    expect(relayClient.actions.getQuote).not.toHaveBeenCalled();
    expect(relayClient.actions.execute).not.toHaveBeenCalled();
    expect(mockInstance.registerPayeeDetails).not.toHaveBeenCalled();
  });

  it('rejects dust Relay output before executing the source route', async () => {
    const relayQuote = {
      details: {
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
        { signer, sourceSigner: signer },
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

  it('maps any other raw revert to a wrapped TRANSACTION_FAILED (no raw leak)', async () => {
    mockInstance.indexer.getDepositsByIdsWithRelations.mockResolvedValue([depositRow()]);
    mockInstance.withdrawDeposit.mockRejectedValue(new Error('nonce too low'));
    const err = await client()
      .withdraw(DEPOSIT_ID, { signer })
      .catch((e) => e);
    expect(isCashError(err)).toBe(true);
    expect(err.code).toBe('TRANSACTION_FAILED');
  });
});

describe('cashout() - allowance visibility', () => {
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
});

describe('orders() - list-row nextActions honesty', () => {
  it('does NOT offer withdraw on a matched row (outstanding lock, no fill detail)', async () => {
    mockInstance.indexer.getDeposits.mockResolvedValue([
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
  it('rejects wise with PAYEE_VERIFICATION_REQUIRED before any network call', async () => {
    await expect(
      client().cashout(
        {
          amount: 5_000_000n,
          receive: { platform: 'wise', currency: 'USD', payee: { offchainId: 'wisetag' } },
        },
        { signer },
      ),
    ).rejects.toMatchObject({ code: 'PAYEE_VERIFICATION_REQUIRED', retryable: false });
    expect(mockInstance.registerPayeeDetails).not.toHaveBeenCalled();
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
