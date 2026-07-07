import { describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import { CHAINLINK_ORACLE_FEEDS } from '@zkp2p/sdk';
import { readEstimate } from '../src/client/estimate';
import { isCashError } from '../src/client/errors';

function mockPublicClient(answer: bigint, updatedAt = 0n): PublicClient {
  return {
    readContract: vi.fn(async () => [1n, answer, 0n, updatedAt, 1n] as const),
  } as unknown as PublicClient;
}

describe('readEstimate', () => {
  it('USD is a passthrough (rate 1, no oracle read)', async () => {
    const pc = mockPublicClient(0n);
    const est = await readEstimate(pc, { amount: 1_000_000_000n, currency: 'USD' });
    expect(est.kind).toBe('oracle-estimate');
    expect(est.rate).toBe(1);
    expect(est.receiveAmount).toBe(1000);
    expect(pc.readContract).not.toHaveBeenCalled();
  });

  it('reads the Chainlink feed for EUR and applies feed semantics', async () => {
    const feed = (CHAINLINK_ORACLE_FEEDS as Record<string, { decimals: number; invert: boolean }>)[
      'EUR'
    ];
    expect(feed).toBeDefined();

    // Answer chosen so price = 1.08 in feed units.
    const answer = BigInt(Math.round(1.08 * 10 ** feed!.decimals));
    const pc = mockPublicClient(answer);
    const est = await readEstimate(pc, { amount: 1_000_000_000n, currency: 'EUR' });

    const expectedRate = feed!.invert ? 1 / 1.08 : 1.08;
    expect(est.rate).toBeCloseTo(expectedRate, 10);
    expect(est.receiveAmount).toBeCloseTo(1000 * expectedRate, 6);
    expect(pc.readContract).toHaveBeenCalledOnce();
  });

  it('surfaces oracle freshness and a stale flag for old feed readings', async () => {
    const feed = (CHAINLINK_ORACLE_FEEDS as Record<string, { decimals: number; invert: boolean }>)[
      'EUR'
    ]!;
    const answer = BigInt(Math.round(1.08 * 10 ** feed.decimals));
    const now = Math.floor(Date.now() / 1000);

    const fresh = await readEstimate(mockPublicClient(answer, BigInt(now - 60)), {
      amount: 1_000_000_000n,
      currency: 'EUR',
    });
    expect(fresh.oracleUpdatedAt).toBe(now - 60);
    expect(fresh.stale).toBeUndefined();

    const old = await readEstimate(mockPublicClient(answer, BigInt(now - 90_000)), {
      amount: 1_000_000_000n,
      currency: 'EUR',
    });
    expect(old.stale).toBe(true);
  });

  it('rejects unsupported currencies with a typed error', async () => {
    const pc = mockPublicClient(0n);
    try {
      await readEstimate(pc, { amount: 1_000_000_000n, currency: 'XYZ' as never });
      expect.unreachable();
    } catch (err) {
      expect(isCashError(err)).toBe(true);
      if (isCashError(err)) {
        expect(err.code).toBe('ORACLE_UNSUPPORTED_CURRENCY');
        expect(err.retryable).toBe(false);
        expect(err.remediation).toContain('capabilities');
      }
    }
  });

  it('rejects dust amounts with AMOUNT_BELOW_MINIMUM', async () => {
    const pc = mockPublicClient(0n);
    await expect(readEstimate(pc, { amount: 9_999n, currency: 'USD' })).rejects.toMatchObject({
      code: 'AMOUNT_BELOW_MINIMUM',
    });
  });

  it('rejects a zero/negative oracle answer', async () => {
    const pc = mockPublicClient(0n);
    await expect(
      readEstimate(pc, { amount: 1_000_000_000n, currency: 'EUR' }),
    ).rejects.toMatchObject({ code: 'ORACLE_UNSUPPORTED_CURRENCY' });
  });
});
