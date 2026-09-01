import { describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import {
  CREATION_RATE_MAX_STALENESS_SECONDS,
  isCreationRateCorridor,
  readAlipayCnyCreationRate,
} from '../src/client/creationRate';

function clientFor(round: readonly [bigint, bigint, bigint, bigint, bigint]): PublicClient {
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'decimals' ? 8 : round,
    ),
  } as unknown as PublicClient;
}

describe('Alipay CNY creation rate', () => {
  it('recognizes only the Alipay/CNY corridor', () => {
    expect(isCreationRateCorridor('alipay', 'CNY')).toBe(true);
    expect(isCreationRateCorridor('ALIPAY', 'cny')).toBe(true);
    expect(isCreationRateCorridor('wise', 'CNY')).toBe(false);
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
