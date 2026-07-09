import { describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import { CHAINLINK_ORACLE_FEEDS } from '@zkp2p/sdk';
import { readEstimate } from '../src/client/estimate';
import { isCashError } from '../src/client/errors';
import type { RelayClient } from '@relayprotocol/relay-sdk';

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

  it('adds rolling first-fill and full-fill ETA from deposit creation timestamps', async () => {
    const now = Math.floor(Date.now() / 1000);
    const indexerClient = {
      indexer: {
        getDepositsWithRelations: vi.fn(async () => [
          {
            createdAt: String(now - 1_000),
            remainingDeposits: '0',
            outstandingIntentAmount: '0',
            totalAmountTaken: '1000000',
            totalWithdrawn: '0',
            intents: [
              { status: 'FULFILLED', amount: '500000', fulfillTimestamp: String(now - 900) },
              { status: 'FULFILLED', amount: '500000', fulfillTimestamp: String(now - 600) },
            ],
          },
          {
            createdAt: String(now - 2_000),
            remainingDeposits: '0',
            outstandingIntentAmount: '0',
            totalAmountTaken: '1000000',
            totalWithdrawn: '0',
            intents: [
              { status: 'FULFILLED', amount: '250000', fulfillTimestamp: String(now - 1_800) },
              { status: 'FULFILLED', amount: '750000', fulfillTimestamp: String(now - 1_400) },
            ],
          },
        ]),
      },
    };

    const est = await readEstimate(
      mockPublicClient(0n),
      { amount: 1_000_000n, currency: 'USD', platform: 'venmo' },
      { indexerClient: indexerClient as never, environment: 'staging' },
    );

    expect(est.eta).toMatchObject({
      seconds: 150,
      label: 'Usually starts in about 3 min',
    });
  });

  it('keeps the oracle estimate when ETA history is unavailable', async () => {
    const indexerClient = {
      indexer: {
        getDepositsWithRelations: vi.fn(async () => {
          throw new Error('indexer unavailable');
        }),
      },
    };

    const est = await readEstimate(
      mockPublicClient(0n),
      { amount: 1_000_000n, currency: 'USD', platform: 'venmo' },
      { indexerClient: indexerClient as never, environment: 'staging' },
    );

    expect(est.rate).toBe(1);
    expect(est.receiveAmount).toBe(1);
    expect(est.eta).toBeUndefined();
  });

  it('quotes a Relay source through the Relay SDK before pricing Base USDC cashout', async () => {
    const getQuote = vi.fn(async () => ({
      details: {
        currencyIn: {
          amount: '1230000000000000000',
          currency: {
            chainId: 1,
            address: '0x0000000000000000000000000000000000000000',
            symbol: 'ETH',
            decimals: 18,
          },
        },
        currencyOut: {
          amount: '2000000',
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
          description: 'Bridge to Base',
          kind: 'transaction',
          id: 'deposit',
          requestId: 'relay-request',
          items: [
            {
              status: 'incomplete',
              data: { to: '0x1111111111111111111111111111111111111111', data: '0x', value: '1' },
            },
          ],
        },
      ],
    }));
    const relayClient = { actions: { getQuote } } as unknown as RelayClient;

    const est = await readEstimate(
      mockPublicClient(0n),
      {
        amount: 1_230_000_000_000_000_000n,
        currency: 'USD',
        source: {
          chainId: 1,
          currency: '0x0000000000000000000000000000000000000000',
          user: '0x2222222222222222222222222222222222222222',
        },
      },
      { relay: { client: relayClient } },
    );

    expect(getQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 1,
        toChainId: 8453,
        toCurrency: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        amount: '1230000000000000000',
        tradeType: 'EXACT_INPUT',
      }),
      false,
    );
    expect(est.amount).toBe(2_000_000n);
    expect(est.receiveAmount).toBe(2);
    expect(est.source?.kind).toBe('relay');
    expect(est.source?.relayQuote.requestId).toBe('relay-request');
    expect(est.source?.relayQuote.txs[0]).toMatchObject({ chainId: 1, value: 1n });
  });
});
