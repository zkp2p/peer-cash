import { describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import {
  CREATION_RATE_MAX_STALENESS_SECONDS,
  isCreationRateCorridor,
  readAlipayCnyCreationRate,
  readCashCreationRate,
} from '../src/client/creationRate';

function clientFor(
  round: readonly [bigint, bigint, bigint, bigint, bigint],
  chainId = 137,
): PublicClient {
  return {
    getChainId: vi.fn(async () => chainId),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'decimals' ? 8 : round,
    ),
  } as unknown as PublicClient;
}

describe('creation-time rates', () => {
  it('recognizes Alipay/CNY and UPI/INR corridors', () => {
    expect(isCreationRateCorridor('alipay', 'CNY')).toBe(true);
    expect(isCreationRateCorridor('ALIPAY', 'cny')).toBe(true);
    expect(isCreationRateCorridor('upi', 'INR')).toBe(true);
    expect(isCreationRateCorridor('wise', 'CNY')).toBe(false);
  });

  it('reads the Polygon INR/USD proxy and rounds the inverted maker floor up', async () => {
    const now = 2_000_000_000;
    const answer = 1_050_700n;
    const client = clientFor([1n, answer, 0n, BigInt(now - 60), 1n]);
    const snapshot = await readCashCreationRate(client, 'upi', 'INR', now);
    expect(client.getChainId).toHaveBeenCalled();
    expect(client.readContract).toHaveBeenCalledTimes(2);
    for (const functionName of ['decimals', 'latestRoundData']) {
      expect(client.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: '0xDA0F8Df6F5dB15b346f4B8D1156722027E194E60',
          functionName,
        }),
      );
    }
    for (const [request] of vi.mocked(client.readContract).mock.calls) {
      expect(request.args).toBeUndefined();
    }
    expect(snapshot.rate1e18).toBe(95_174_645_474_445_607_691n);
    expect(snapshot.rate1e18 * answer).toBeGreaterThanOrEqual(10n ** 26n);
    expect((snapshot.rate1e18 - 1n) * answer).toBeLessThan(10n ** 26n);
    expect(snapshot.updatedAt).toBe(now - 60);
  });

  it('rejects a UPI reader on Ethereum before reading a price', async () => {
    const client = clientFor([1n, 1_050_700n, 0n, 1n, 1n], 1);
    await expect(readCashCreationRate(client, 'upi', 'INR')).rejects.toThrow(/Polygon|137/u);
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it.each([
    ['zero answer', 0n, -60, 1n, /INR\/USD.*invalid round/u],
    ['negative answer', -1n, -60, 1n, /INR\/USD.*invalid round/u],
    ['incomplete round', 1n, -60, 0n, /INR\/USD.*invalid round/u],
    ['future timestamp', 1n, 1, 1n, /INR\/USD.*invalid timestamp/u],
    ['stale timestamp', 1n, -CREATION_RATE_MAX_STALENESS_SECONDS - 1, 1n, /INR\/USD.*stale/u],
  ] as const)(
    'rejects UPI %s with an INR-specific error',
    async (_, answer, offset, answeredInRound, error) => {
      const now = 2_000_000_000;
      await expect(
        readCashCreationRate(
          clientFor([1n, answer, 0n, BigInt(now + offset), answeredInRound]),
          'upi',
          'INR',
          now,
        ),
      ).rejects.toThrow(error);
    },
  );

  it('accepts the exact freshness boundary but rejects a missing UPI timestamp', async () => {
    const now = 2_000_000_000;
    await expect(
      readCashCreationRate(
        clientFor([1n, 1_050_700n, 0n, BigInt(now - CREATION_RATE_MAX_STALENESS_SECONDS), 1n]),
        'upi',
        'INR',
        now,
      ),
    ).resolves.toMatchObject({ updatedAt: now - CREATION_RATE_MAX_STALENESS_SECONDS });
    await expect(
      readCashCreationRate(clientFor([1n, 1n, 0n, 0n, 1n]), 'upi', 'INR', now),
    ).rejects.toThrow(/INR\/USD.*invalid round/u);
  });

  it('inverts Chainlink CNY/USD and rounds the maker floor up at 1e18', async () => {
    const now = 2_000_000_000;
    const answer = 14_871_215n; // 0.14871215 USD per CNY
    const snapshot = await readAlipayCnyCreationRate(
      clientFor([1n, answer, 0n, BigInt(now - 60), 1n]),
      now,
    );

    const expected = (10n ** 26n + answer - 1n) / answer;
    expect(snapshot.rate1e18).toBe(expected);
    expect(snapshot.rate).toBeCloseTo(6.7244, 3);
    expect(snapshot.updatedAt).toBe(now - 60);
  });

  it('rejects invalid and stale rounds', async () => {
    const now = 2_000_000_000;
    await expect(
      readAlipayCnyCreationRate(clientFor([2n, 1n, 0n, BigInt(now - 60), 1n]), now),
    ).rejects.toThrow(/invalid round/u);
    await expect(
      readAlipayCnyCreationRate(
        clientFor([1n, 14_871_215n, 0n, BigInt(now - CREATION_RATE_MAX_STALENESS_SECONDS - 1), 1n]),
        now,
      ),
    ).rejects.toThrow(/stale/u);
  });
});
