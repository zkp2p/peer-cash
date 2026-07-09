import { describe, expect, it, vi } from 'vitest';
import type { RelayChain, RelayClient, Execute } from '@relayprotocol/relay-sdk';
import type { WalletClient } from 'viem';
import {
  executeRelayQuote,
  quoteRelayToBaseUsdc,
  readRelaySourceCapabilities,
  readRelayStatus,
} from '../src/client/relay';

describe('Relay SDK adapter', () => {
  it('normalizes dynamic Relay chain/token metadata without a static source allowlist', async () => {
    const chains: RelayChain[] = [
      {
        id: 1,
        name: 'ethereum',
        displayName: 'Ethereum',
        disabled: true,
        depositEnabled: true,
        blockProductionLagging: false,
        vmType: 'evm',
        currency: {
          address: '0x0000000000000000000000000000000000000000',
          symbol: 'ETH',
          decimals: 18,
          name: 'Ether',
        },
        erc20Currencies: [
          {
            address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            symbol: 'USDC',
            decimals: 6,
            name: 'USD Coin',
          },
        ],
      } as unknown as RelayChain,
      {
        id: 792703809,
        name: 'solana',
        displayName: 'Solana',
        depositEnabled: true,
        blockProductionLagging: false,
        vmType: 'svm',
        currency: {
          address: '0x0000000000000000000000000000000000000000',
          symbol: 'SOL',
          decimals: 9,
        },
      },
    ];

    const caps = await readRelaySourceCapabilities({ chains });

    expect(caps.source).toBe('relay-sdk');
    expect(caps.destination).toMatchObject({ chainId: 8453, symbol: 'USDC' });
    expect(caps.chains).toHaveLength(1);
    expect(caps.chains[0]?.disabled).toBe(true);
    expect(caps.chains[0]?.tokens.map((token) => token.symbol)).toEqual(['ETH', 'USDC']);
  });

  it('uses an injected Relay client when fetching dynamic source metadata', async () => {
    const chains: RelayChain[] = [
      {
        id: 10,
        name: 'optimism',
        displayName: 'Optimism',
        depositEnabled: true,
        blockProductionLagging: false,
        vmType: 'evm',
        currency: {
          address: '0x0000000000000000000000000000000000000000',
          symbol: 'ETH',
          decimals: 18,
        },
      },
    ];
    const relayClient = {
      baseApiUrl: 'https://relay.example',
      source: 'custom-host',
      apiKey: 'test-key',
      chains,
      actions: {},
    } as unknown as RelayClient;

    const caps = await readRelaySourceCapabilities({ client: relayClient });

    expect(relayClient.chains).toBe(chains);
    expect(caps.chains[0]?.displayName).toBe('Optimism');
  });

  it('keeps custom EVM Relay chains whose optional vmType is absent', async () => {
    const caps = await readRelaySourceCapabilities({
      chains: [
        {
          id: 10,
          name: 'optimism',
          displayName: 'Optimism',
          depositEnabled: true,
          blockProductionLagging: false,
          currency: {
            address: '0x0000000000000000000000000000000000000000',
            symbol: 'ETH',
            decimals: 18,
          },
        } as RelayChain,
        {
          id: 792703809,
          name: 'solana',
          displayName: 'Solana',
          depositEnabled: true,
          blockProductionLagging: false,
          vmType: 'svm',
          currency: {
            address: '0x0000000000000000000000000000000000000000',
            symbol: 'SOL',
            decimals: 9,
          },
        } as RelayChain,
      ],
    });

    expect(caps.chains.map((chain) => chain.id)).toEqual([10]);
  });

  it('quotes source-to-Base-USDC through Relay SDK actions.getQuote', async () => {
    const quote = {
      request: {
        url: 'https://api.relay.link/quote/v2',
        headers: { 'x-api-key': 'secret-relay-key', authorization: 'Bearer secret' },
      },
      details: {
        currencyIn: {
          amount: '1000000',
          currency: { chainId: 10, address: '0xsource', symbol: 'USDC', decimals: 6 },
        },
        currencyOut: {
          amount: '990000',
          currency: {
            chainId: 8453,
            address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            symbol: 'USDC',
            decimals: 6,
          },
        },
        timeEstimate: 30,
      },
      steps: [
        {
          action: 'bridge',
          description: 'Bridge',
          kind: 'transaction',
          id: 'deposit',
          requestId: 'req-1',
          items: [
            {
              status: 'incomplete',
              data: { to: '0x1111111111111111111111111111111111111111', value: '0', data: '0x' },
            },
          ],
        },
      ],
    } as Execute;
    const getQuote = vi.fn(async () => quote);
    const relayClient = { actions: { getQuote } } as unknown as RelayClient;

    const result = await quoteRelayToBaseUsdc(
      {
        user: '0x2222222222222222222222222222222222222222',
        amount: 1_000_000n,
        source: { chainId: 10, currency: '0xsource' },
      },
      { client: relayClient },
    );

    expect(getQuote).toHaveBeenCalledOnce();
    expect(result.outputAmount).toBe(990_000n);
    expect(result.requestId).toBe('req-1');
    expect(result.txs[0]?.chainId).toBe(10);
    expect(result.raw.request?.headers).toBeUndefined();
  });

  it('uses Relay minimum output as the deposit amount when slippage can apply', async () => {
    const quote = {
      details: {
        currencyIn: {
          amount: '1000000',
          currency: { chainId: 10, address: '0xsource', symbol: 'USDC', decimals: 6 },
        },
        currencyOut: {
          amount: '990000',
          minimumAmount: '970000',
          currency: {
            chainId: 8453,
            address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            symbol: 'USDC',
            decimals: 6,
          },
        },
      },
      steps: [],
    } as Execute;
    const relayClient = {
      actions: { getQuote: vi.fn(async () => quote) },
    } as unknown as RelayClient;

    const result = await quoteRelayToBaseUsdc(
      {
        user: '0x2222222222222222222222222222222222222222',
        amount: 1_000_000n,
        source: { chainId: 10, currency: '0xsource' },
      },
      { client: relayClient },
    );

    expect(result.outputAmount).toBe(970_000n);
  });

  it('executes a Relay quote through Relay SDK actions.execute', async () => {
    const executed = {
      details: {
        currencyIn: {
          currency: { chainId: 10 },
        },
      },
      steps: [
        {
          action: 'bridge',
          description: 'Bridge',
          kind: 'transaction',
          id: 'deposit',
          requestId: 'req-1',
          items: [{ status: 'complete', txHashes: [{ txHash: '0xabc', chainId: 1 }] }],
        },
      ],
    } as Execute;
    const chains = [
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
    ] as RelayChain[];
    const execute = vi.fn(async () => ({ data: executed, abortController: new AbortController() }));
    const relayClient = { chains: [], actions: { execute } } as unknown as RelayClient;

    const result = await executeRelayQuote(executed, {} as WalletClient, {
      relay: { client: relayClient, chains },
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(relayClient.chains).toBe(chains);
    expect(result).toMatchObject({ requestId: 'req-1', txHashes: ['0xabc'] });
  });

  it('reads Relay status through the SDK request utility', async () => {
    const request = vi.fn(async () => ({
      data: { status: 'success', txHashes: ['0xout'], inTxHashes: ['0xin'], updatedAt: 1 },
    }));
    const relayClient = {
      baseApiUrl: 'https://api.relay.link',
      utils: { request },
    } as unknown as RelayClient;

    const status = await readRelayStatus('req-1', { client: relayClient });

    expect(request).toHaveBeenCalledWith({
      url: 'https://api.relay.link/intents/status/v3',
      method: 'get',
      params: { requestId: 'req-1' },
    });
    expect(status).toMatchObject({ requestId: 'req-1', status: 'success', txHashes: ['0xout'] });
  });
});
