import { describe, expect, it } from 'vitest';
import { encodeEventTopics, encodeAbiParameters, type Abi, type Log } from 'viem';
import { parseCompositeDepositId, resolveCashDepositId } from '../src/engine/resolveDeposit';

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

const ESCROW = '0x1111111111111111111111111111111111111111';

function depositReceivedLog(depositId: bigint): Log {
  const topics = encodeEventTopics({
    abi: DEPOSIT_RECEIVED_ABI,
    eventName: 'DepositReceived',
    args: {
      depositId,
      depositor: '0x2222222222222222222222222222222222222222',
      token: '0x3333333333333333333333333333333333333333',
    },
  });
  return {
    address: ESCROW,
    topics,
    data: encodeAbiParameters([{ type: 'uint256' }], [5_000_000n]),
    blockNumber: 1n,
    blockHash: '0xb',
    logIndex: 0,
    transactionHash: '0xt',
    transactionIndex: 0,
    removed: false,
  } as unknown as Log;
}

describe('resolveCashDepositId', () => {
  it('decodes the deposit id and builds the composite id', () => {
    const resolved = resolveCashDepositId({
      logs: [depositReceivedLog(42n)],
      abi: DEPOSIT_RECEIVED_ABI,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.onchainDepositId).toBe(42n);
    expect(resolved?.escrowAddress.toLowerCase()).toBe(ESCROW);
    expect(resolved?.compositeId).toBe(`${ESCROW}_42`);
  });

  it('returns null when no DepositReceived event is present', () => {
    const resolved = resolveCashDepositId({ logs: [], abi: DEPOSIT_RECEIVED_ABI });
    expect(resolved).toBeNull();
  });
});

describe('parseCompositeDepositId', () => {
  it('splits escrow_onchainId', () => {
    const { escrowAddress, onchainDepositId } = parseCompositeDepositId(`${ESCROW}_7`);
    expect(escrowAddress).toBe(ESCROW);
    expect(onchainDepositId).toBe(7n);
  });

  it('treats a bare number as the on-chain id', () => {
    const { escrowAddress, onchainDepositId } = parseCompositeDepositId('123');
    expect(escrowAddress).toBe('');
    expect(onchainDepositId).toBe(123n);
  });

  it('round-trips with resolveCashDepositId output', () => {
    const resolved = resolveCashDepositId({
      logs: [depositReceivedLog(9n)],
      abi: DEPOSIT_RECEIVED_ABI,
    });
    const parsed = parseCompositeDepositId(resolved!.compositeId);
    expect(parsed.onchainDepositId).toBe(9n);
    expect(parsed.escrowAddress.toLowerCase()).toBe(ESCROW);
  });
});
