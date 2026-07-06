import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Abi, type Log, type WalletClient } from 'viem';

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
    getDepositsByIdsWithRelations: vi.fn(),
    getIntentsForDeposits: vi.fn(),
  },
  registerPayeeDetails: vi.fn(),
  createDeposit: vi.fn(),
  prepareCreateDeposit: vi.fn(),
  ensureAllowance: vi.fn(),
  withdrawDeposit: vi.fn(),
  pruneExpiredIntents: vi.fn(),
};

vi.mock('@zkp2p/sdk', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@zkp2p/sdk')>();
  return { ...actual, Zkp2pClient: vi.fn(() => mockInstance) };
});

import { createCashClient } from '../src/client/createCashClient';
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

    const { txs, register } = await client().prepare({
      amount: 5_000_000n,
      receive: { platform: 'venmo', currency: 'USD', payee: { offchainId: '@a' } },
    });

    expect(txs).toHaveLength(2);
    expect(txs[0]?.to.toLowerCase()).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'); // USDC approve
    expect(txs[0]?.data.startsWith('0x095ea7b3')).toBe(true); // approve selector
    expect(txs[1]).toMatchObject({ to: ESCROW, data: '0xdeposit' });
    expect(register.hashedOnchainIds).toEqual(['0xpayeehash']);
    // No signing surface touched.
    expect(mockInstance.createDeposit).not.toHaveBeenCalled();
    expect(mockInstance.ensureAllowance).not.toHaveBeenCalled();
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
