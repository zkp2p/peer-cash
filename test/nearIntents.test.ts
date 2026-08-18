import { describe, expect, it, vi } from 'vitest';
import {
  NEAR_INTENTS_BASE_USDC_ASSET_ID,
  createNearIntentsClient,
} from '../src/client/nearIntents';
import { isCashError } from '../src/client/errors';
import { createCashClient } from '../src/client/createCashClient';

const ZEC_ASSET_ID = 'nep141:zec.omft.near';
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const REFUND_TO = 't1abcdefghijklmnopqrstuvwxyz1234567';
const DEPOSIT_ADDRESS = 't1zyxwvutsrqponmlkjihgfedcba1234567';
const TX_HASH = 'ab'.repeat(32);
const DEADLINE = '2026-08-18T12:30:00.000Z';

const quoteRequest = {
  dry: false,
  swapType: 'EXACT_OUTPUT' as const,
  slippageTolerance: 100,
  originAsset: ZEC_ASSET_ID,
  depositType: 'ORIGIN_CHAIN' as const,
  destinationAsset: NEAR_INTENTS_BASE_USDC_ASSET_ID,
  amount: '1000000',
  refundTo: REFUND_TO,
  refundType: 'ORIGIN_CHAIN' as const,
  recipient: RECIPIENT,
  recipientType: 'DESTINATION_CHAIN' as const,
  deadline: DEADLINE,
  depositMode: 'SIMPLE' as const,
};

const quoteResponse = {
  correlationId: 'near-route-1',
  timestamp: '2026-08-18T12:00:00.000Z',
  signature: 'signed-quote',
  quoteRequest,
  quote: {
    amountIn: '200000',
    minAmountIn: '200000',
    amountOut: '1000000',
    minAmountOut: '1000000',
    amountInFormatted: '0.002',
    amountInUsd: '1.10',
    amountOutFormatted: '1',
    amountOutUsd: '1',
    timeEstimate: 120,
    depositAddress: DEPOSIT_ADDRESS,
    depositMemo: 'memo-1',
    deadline: DEADLINE,
  },
};

const statusResponse = {
  correlationId: 'near-route-1',
  quoteResponse: {
    timestamp: quoteResponse.timestamp,
    signature: quoteResponse.signature,
    quoteRequest,
    quote: quoteResponse.quote,
  },
  status: 'SUCCESS' as const,
  updatedAt: '2026-08-18T12:04:00.000Z',
  swapDetails: {
    intentHashes: ['intent-1'],
    nearTxHashes: ['near-1'],
    originChainTxHashes: [{ hash: TX_HASH, explorerUrl: `https://cipherscan.app/tx/${TX_HASH}` }],
    destinationChainTxHashes: [
      { hash: `0x${'cd'.repeat(32)}`, explorerUrl: `https://basescan.org/tx/0x${'cd'.repeat(32)}` },
    ],
    amountIn: '200000',
    amountOut: '1000000',
    refundedAmount: null,
    refundReason: null,
  },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('Expected JSON request body');
  return JSON.parse(init.body) as unknown;
}

describe('NEAR Intents 1Click adapter', () => {
  it('discovers live non-destination assets through the direct API without a static allowlist', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse([
        {
          assetId: ZEC_ASSET_ID,
          symbol: 'ZEC',
          decimals: 8,
          blockchain: 'zcash',
          price: '550',
          priceUpdatedAt: '2026-08-18T12:00:00.000Z',
        },
        {
          assetId: NEAR_INTENTS_BASE_USDC_ASSET_ID,
          symbol: 'USDC',
          decimals: 6,
          blockchain: 'base',
          price: 1,
          priceUpdatedAt: '2026-08-18T12:00:00.000Z',
        },
      ]),
    );
    const client = createNearIntentsClient({ fetch, token: 'server-jwt' });

    const capabilities = await client.capabilities();

    expect(capabilities.source).toBe('near-intents');
    expect(capabilities.destination.assetId).toBe(NEAR_INTENTS_BASE_USDC_ASSET_ID);
    expect(capabilities.assets.map((asset) => asset.symbol)).toEqual(['ZEC']);
    expect(fetch).toHaveBeenCalledWith(
      'https://1click.chaindefuser.com/v0/tokens',
      expect.objectContaining({
        credentials: 'omit',
        headers: expect.objectContaining({ Authorization: 'Bearer server-jwt' }),
      }),
    );
  });

  it('quotes exact Base USDC output and rejects a provider response that changes the request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(quoteResponse));
    const client = createNearIntentsClient({ fetch });

    const quote = await client.quoteToBaseUsdc({
      sourceAsset: ZEC_ASSET_ID,
      amount: 1_000_000n,
      recipient: RECIPIENT,
      refundTo: REFUND_TO,
      tradeType: 'EXACT_OUTPUT',
      deadline: DEADLINE,
    });

    expect(quote).toMatchObject({
      provider: 'near-intents',
      inputAmount: 200_000n,
      outputAmount: 1_000_000n,
      minOutputAmount: 1_000_000n,
      depositAddress: DEPOSIT_ADDRESS,
      depositMemo: 'memo-1',
    });
    expect(requestBody(fetch.mock.calls[0]?.[1])).toEqual(quoteRequest);

    fetch.mockResolvedValueOnce(
      jsonResponse({
        ...quoteResponse,
        quoteRequest: { ...quoteRequest, recipient: '0x2222222222222222222222222222222222222222' },
      }),
    );
    const error = await client
      .quoteToBaseUsdc({
        sourceAsset: ZEC_ASSET_ID,
        amount: 1_000_000n,
        recipient: RECIPIENT,
        refundTo: REFUND_TO,
        tradeType: 'EXACT_OUTPUT',
        deadline: DEADLINE,
      })
      .catch((cause: unknown) => cause);
    expect(isCashError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'SOURCE_QUOTE_FAILED', retryable: true });
  });

  it('submits the known origin transaction once and returns chain-aware status evidence', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(statusResponse));
    const client = createNearIntentsClient({ fetch, token: 'server-jwt' });

    const status = await client.submitDeposit({
      depositAddress: DEPOSIT_ADDRESS,
      depositMemo: 'memo-1',
      txHash: TX_HASH,
    });

    expect(status).toMatchObject({
      provider: 'near-intents',
      status: 'SUCCESS',
      inputAmount: 200_000n,
      outputAmount: 1_000_000n,
      originTransactions: [{ hash: TX_HASH }],
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://1click.chaindefuser.com/v0/deposit/submit');
    expect(requestBody(fetch.mock.calls[0]?.[1])).toEqual({
      depositAddress: DEPOSIT_ADDRESS,
      txHash: TX_HASH,
      memo: 'memo-1',
    });
  });

  it('rejects status whose stable route identity differs from the persisted signed quote', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(quoteResponse))
      .mockResolvedValueOnce(
        jsonResponse({
          ...statusResponse,
          quoteResponse: {
            ...statusResponse.quoteResponse,
            quoteRequest: {
              ...statusResponse.quoteResponse.quoteRequest,
              refundTo: 't1differentrefundaddress123456789',
            },
          },
        }),
      );
    const client = createNearIntentsClient({ fetch });
    const quote = await client.quoteToBaseUsdc({
      sourceAsset: ZEC_ASSET_ID,
      amount: 1_000_000n,
      recipient: RECIPIENT,
      refundTo: REFUND_TO,
      tradeType: 'EXACT_OUTPUT',
      deadline: DEADLINE,
    });

    const error = await client
      .status({
        depositAddress: DEPOSIT_ADDRESS,
        depositMemo: 'memo-1',
        expectedQuote: quote,
      })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: 'SOURCE_STATUS_FAILED', retryable: true });
  });

  it('rejects a status route that does not settle to canonical Base USDC', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        ...statusResponse,
        quoteResponse: {
          ...statusResponse.quoteResponse,
          quoteRequest: {
            ...statusResponse.quoteResponse.quoteRequest,
            destinationAsset: 'nep141:eth.omft.near',
          },
        },
      }),
    );
    const client = createNearIntentsClient({ fetch });

    const error = await client
      .status({ depositAddress: DEPOSIT_ADDRESS, depositMemo: 'memo-1' })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: 'SOURCE_STATUS_FAILED', retryable: true });
  });

  it('uses a same-origin proxy without leaking a JWT or route identifiers in the status URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(statusResponse));
    const client = createNearIntentsClient({
      apiUrl: '/api/v1/near/',
      fetch,
      transport: 'proxy',
    });

    await client.status({ depositAddress: DEPOSIT_ADDRESS, depositMemo: 'memo-1' });

    expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/near/status');
    expect(fetch.mock.calls[0]?.[0]).not.toContain(DEPOSIT_ADDRESS);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer',
    });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false);
    expect(requestBody(fetch.mock.calls[0]?.[1])).toEqual({
      depositAddress: DEPOSIT_ADDRESS,
      depositMemo: 'memo-1',
    });
    expect(() => createNearIntentsClient({ transport: 'proxy', token: 'must-not-leak' })).toThrow(
      /cannot be sent/u,
    );
  });

  it('is exposed as a first-class CashClient source capability and quote method', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            assetId: ZEC_ASSET_ID,
            symbol: 'ZEC',
            decimals: 8,
            blockchain: 'zcash',
            price: '550',
            priceUpdatedAt: '2026-08-18T12:00:00.000Z',
          },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse(quoteResponse));
    const cash = createCashClient({
      environment: 'staging',
      nearIntents: { apiUrl: '/api/v1/near', fetch, transport: 'proxy' },
    });

    const capabilities = await cash.capabilities({ includeNearIntentsSources: true });
    const quote = await cash.quoteNearIntentsSource({
      sourceAsset: ZEC_ASSET_ID,
      amount: 1_000_000n,
      recipient: RECIPIENT,
      refundTo: REFUND_TO,
      tradeType: 'EXACT_OUTPUT',
      deadline: DEADLINE,
    });

    expect(capabilities.source.nearIntents?.assets[0]?.symbol).toBe('ZEC');
    expect(quote.provider).toBe('near-intents');
  });

  it('never reflects an untrusted error body and makes deposit registration retry the notification only', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ secret: 'do-not-reflect' }, 503));
    const client = createNearIntentsClient({ fetch });

    const error = await client
      .submitDeposit({ depositAddress: DEPOSIT_ADDRESS, txHash: TX_HASH })
      .catch((cause: unknown) => cause);

    expect(isCashError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'SOURCE_DEPOSIT_SUBMISSION_FAILED',
      retryable: true,
    });
    expect(String(error)).not.toContain('do-not-reflect');
    if (!isCashError(error)) throw new Error('Expected CashError');
    expect(error.remediation).toMatch(/Never resend the source funds/u);
  });
});
