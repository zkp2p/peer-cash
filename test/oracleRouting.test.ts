import { afterEach, describe, expect, it, vi } from 'vitest';
import { custom, encodeAbiParameters, toFunctionSelector, type Hex } from 'viem';
import { createCashClient } from '../src/client/createCashClient';

afterEach(() => vi.unstubAllGlobals());

describe('Cash Base oracle routing', () => {
  it.each([
    ['upi', 'INR', '0x053a03f1704ae3f71082d3cdfd50bc830415a326', 1_039_177n],
    ['alipay', 'CNY', '0xc034d806dbea6b13980d94174ea5ff83e1c191c3', 14_892_033n],
  ] as const)(
    'reads %s/%s only through the configured Base transport',
    async (platform, currency, feed, answer) => {
      // Any implicit HTTP client (including the removed Ethereum/Polygon readers)
      // must fail this test. Only the supplied Base transport may serve the read.
      const fetch = vi.fn(() => {
        throw new Error('Unexpected HTTP request');
      });
      vi.stubGlobal('fetch', fetch);
      const updatedAt = BigInt(Math.floor(Date.now() / 1000) - 60);
      const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
        expect(method).toBe('eth_call');
        const call = params?.[0] as { to: string; data: Hex };
        expect(call.to.toLowerCase()).toBe(feed);
        expect(call.data).toBe(toFunctionSelector('latestRoundData()'));
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
      });
      const cash = createCashClient({
        environment: 'preproduction',
        transport: custom({ request }, { retryCount: 0 }),
      });
      const estimate = await cash.estimate(
        { amount: 1_000_000n, platform, currency },
        { includeEta: false },
      );
      expect(estimate.binding).toBe('intent-signal');
      expect(estimate.rate).toBeCloseTo(1e8 / Number(answer), 10);
      expect(estimate.oracleUpdatedAt).toBe(Number(updatedAt));
      expect(request).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
