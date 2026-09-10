import { describe, expect, it, vi } from 'vitest';
import { custom, encodeAbiParameters, toFunctionSelector, type Hex } from 'viem';
import { createCashClient } from '../src/client/createCashClient';

const POLYGON_PROXY = '0xda0f8df6f5db15b346f4b8d1156722027e194e60';
const ETHEREUM_REGISTRY = '0x47fb2585d2c56fe188d0e6ec628a38b74fceeedf';

function oracleTransport(chainId: number, address: string, answer: bigint, registry = false) {
  const updatedAt = BigInt(Math.floor(Date.now() / 1000) - 60);
  const decimalsSelector = toFunctionSelector(
    registry ? 'decimals(address,address)' : 'decimals()',
  );
  const roundSelector = toFunctionSelector(
    registry ? 'latestRoundData(address,address)' : 'latestRoundData()',
  );
  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
    if (method !== 'eth_call') throw new Error(`Unexpected RPC method: ${method}`);
    const call = params?.[0] as { to: string; data: Hex };
    expect(call.to.toLowerCase()).toBe(address);
    const selector = call.data.slice(0, 10);
    if (selector === decimalsSelector) return encodeAbiParameters([{ type: 'uint8' }], [8]);
    if (selector === roundSelector)
      return encodeAbiParameters(
        [
          { type: 'uint80' },
          { type: 'int256' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint80' },
        ],
        [1n, answer, updatedAt, updatedAt, 1n],
      );
    throw new Error(`Unexpected oracle selector: ${selector}`);
  });
  return { request, transport: custom({ request }, { retryCount: 0 }) };
}

function setup(polygonChainId = 137) {
  const ethereum = oracleTransport(1, ETHEREUM_REGISTRY, 14_871_215n, true);
  const polygon = oracleTransport(polygonChainId, POLYGON_PROXY, 1_050_700n);
  const baseRequest = vi.fn(async () => {
    throw new Error('Base RPC must not serve creation rates');
  });
  const cash = createCashClient({
    environment: 'preproduction',
    transport: custom({ request: baseRequest }, { retryCount: 0 }),
    creationRateTransport: ethereum.transport,
    upiCreationRateTransport: polygon.transport,
  });
  return { cash, ethereum, polygon, baseRequest };
}

describe('Cash client creation-rate transport routing', () => {
  it('uses the dedicated Polygon transport for UPI with the real viem reader', async () => {
    const { cash, ethereum, polygon, baseRequest } = setup();
    const estimate = await cash.estimate(
      { amount: 1_000_000n, platform: 'upi', currency: 'INR' },
      { includeEta: false },
    );
    expect(estimate.binding).toBe('deposit-creation');
    expect(estimate.rate).toBeCloseTo(95.17464547444561, 10);
    expect(polygon.request.mock.calls.map(([call]) => call.method)).toEqual([
      'eth_chainId',
      'eth_call',
      'eth_call',
    ]);
    expect(ethereum.request).not.toHaveBeenCalled();
    expect(baseRequest).not.toHaveBeenCalled();
  });

  it('preserves the Ethereum registry transport for Alipay/CNY', async () => {
    const { cash, ethereum, polygon, baseRequest } = setup();
    const estimate = await cash.estimate(
      { amount: 1_000_000n, platform: 'alipay', currency: 'CNY' },
      { includeEta: false },
    );
    expect(estimate.binding).toBe('deposit-creation');
    expect(estimate.rate).toBeCloseTo(6.7244, 3);
    expect(ethereum.request).toHaveBeenCalledTimes(2);
    expect(polygon.request).not.toHaveBeenCalled();
    expect(baseRequest).not.toHaveBeenCalled();
  });

  it('wraps a wrong-chain UPI transport as ORACLE_READ_FAILED without fallback', async () => {
    const { cash, ethereum, polygon, baseRequest } = setup(1);
    await expect(
      cash.estimate(
        { amount: 1_000_000n, platform: 'upi', currency: 'INR' },
        { includeEta: false },
      ),
    ).rejects.toMatchObject({ code: 'ORACLE_READ_FAILED' });
    expect(polygon.request.mock.calls.map(([call]) => call.method)).toEqual(['eth_chainId']);
    expect(ethereum.request).not.toHaveBeenCalled();
    expect(baseRequest).not.toHaveBeenCalled();
  });
});
