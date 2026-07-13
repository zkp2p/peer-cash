import { describe, expect, it, vi } from 'vitest';
import type { RelayChain, RelayClient, Execute } from '@relayprotocol/relay-sdk';
import type { WalletClient } from 'viem';
import {
  executeRelayQuote,
  quoteRelayToBaseUsdc,
  readRelaySourceCapabilities,
  readRelayStatus,
} from '../src/client/relay';
import type { RelayQuote } from '../src/client/relay';

const USER = '0x2222222222222222222222222222222222222222';
const WALLET = {
  account: { address: USER },
  chain: { id: 10 },
  getChainId: vi.fn(async () => 10),
} as unknown as WalletClient;

describe('Relay SDK adapter', () => {
  it('normalizes dynamic Relay chain/token metadata without a static source allowlist', async () => {
    const chains: RelayChain[] = [
      {
        id: 1,
        name: 'ethereum',
        displayName: 'Ethereum',
        disabled: false,
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
    expect(caps.chains[0]?.disabled).toBe(false);
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

  it('exposes only healthy, deposit-enabled Relay source chains', async () => {
    const chain = (overrides: Partial<RelayChain> & { disabled?: boolean }): RelayChain =>
      ({
        id: 10,
        name: 'optimism',
        displayName: 'Optimism',
        disabled: false,
        depositEnabled: true,
        blockProductionLagging: false,
        vmType: 'evm',
        currency: {
          address: '0x0000000000000000000000000000000000000000',
          symbol: 'ETH',
          decimals: 18,
        },
        ...overrides,
      }) as RelayChain;

    const caps = await readRelaySourceCapabilities({
      chains: [
        chain({ id: 10 }),
        chain({ id: 1923, disabled: true }),
        chain({ id: 543210, depositEnabled: false }),
        chain({ id: 888888888, blockProductionLagging: true }),
      ],
    });

    expect(caps.chains.map((candidate) => candidate.id)).toEqual([10]);
  });

  it('quotes source-to-Base-USDC through Relay SDK actions.getQuote', async () => {
    const quote = {
      request: {
        url: 'https://api.relay.link/quote/v2',
        headers: { 'x-api-key': 'secret-relay-key', authorization: 'Bearer secret' },
      },
      details: {
        sender: USER,
        recipient: USER,
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
        user: USER,
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
        sender: USER,
        recipient: USER,
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
        user: USER,
        amount: 1_000_000n,
        source: { chainId: 10, currency: '0xsource' },
      },
      { client: relayClient },
    );

    expect(result.outputAmount).toBe(970_000n);
  });

  it('rejects a quote that does not return canonical Base USDC', async () => {
    const relayClient = {
      actions: {
        getQuote: vi.fn(
          async () =>
            ({
              details: {
                sender: USER,
                recipient: USER,
                currencyIn: {
                  amount: '1000000',
                  currency: { chainId: 10, address: '0xsource', symbol: 'USDC', decimals: 6 },
                },
                currencyOut: {
                  minimumAmount: '990000',
                  currency: {
                    chainId: 1,
                    address: '0xwrongdestination',
                    symbol: 'USDC',
                    decimals: 6,
                  },
                },
              },
              steps: [],
            }) as Execute,
        ),
      },
    } as unknown as RelayClient;

    await expect(
      quoteRelayToBaseUsdc(
        {
          user: USER,
          amount: 1_000_000n,
          source: { chainId: 10, currency: '0xsource' },
        },
        { client: relayClient },
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_QUOTE_FAILED', retryable: true });
  });

  it('rejects a quote whose source metadata does not match the requested asset', async () => {
    const relayClient = {
      actions: {
        getQuote: vi.fn(
          async () =>
            ({
              details: {
                sender: USER,
                recipient: USER,
                currencyIn: {
                  amount: '1000000',
                  currency: { chainId: 1, address: '0xother', symbol: 'USDC', decimals: 6 },
                },
                currencyOut: {
                  minimumAmount: '990000',
                  currency: {
                    chainId: 8453,
                    address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
                    symbol: 'USDC',
                    decimals: 6,
                  },
                },
              },
              steps: [],
            }) as Execute,
        ),
      },
    } as unknown as RelayClient;

    await expect(
      quoteRelayToBaseUsdc(
        {
          user: USER,
          amount: 1_000_000n,
          source: { chainId: 10, currency: '0xsource' },
        },
        { client: relayClient },
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_QUOTE_FAILED' });
  });

  it('rejects a canonical Base-USDC quote that routes to another recipient', async () => {
    const relayClient = {
      actions: {
        getQuote: vi.fn(
          async () =>
            ({
              details: {
                sender: USER,
                recipient: '0x9999999999999999999999999999999999999999',
                currencyIn: {
                  amount: '1000000',
                  currency: { chainId: 10, address: '0xsource', symbol: 'USDC', decimals: 6 },
                },
                currencyOut: {
                  minimumAmount: '990000',
                  currency: {
                    chainId: 8453,
                    address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
                    symbol: 'USDC',
                    decimals: 6,
                  },
                },
              },
              steps: [],
            }) as Execute,
        ),
      },
    } as unknown as RelayClient;

    await expect(
      quoteRelayToBaseUsdc(
        {
          user: USER,
          recipient: USER,
          amount: 1_000_000n,
          source: { chainId: 10, currency: '0xsource' },
        },
        { client: relayClient },
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_QUOTE_FAILED' });
  });

  it('executes a Relay quote through Relay SDK actions.execute', async () => {
    const executed = {
      details: {
        sender: USER,
        recipient: USER,
        currencyIn: {
          currency: { chainId: 10 },
        },
        currencyOut: {
          currency: {
            chainId: 8453,
            address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          },
        },
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
              status: 'complete',
              receipt: { gasUsed: 21_000n },
              internalTxHashes: [
                { txHash: '0xdestination-internal', chainId: 8453, isBatchTx: true },
              ],
              txHashes: [
                { txHash: '0xorigin', chainId: 10 },
                { txHash: '0xdestination', chainId: 8453 },
              ],
            },
          ],
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

    const result = await executeRelayQuote(executed, WALLET, {
      relay: { client: relayClient, chains },
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(relayClient.chains).toBe(chains);
    expect(result).toMatchObject({
      requestId: 'req-1',
      txHashes: ['0xorigin', '0xdestination-internal', '0xdestination'],
      transactions: {
        origin: [{ hash: '0xorigin', chainId: 10 }],
        destination: [
          { hash: '0xdestination-internal', chainId: 8453, isBatchTx: true },
          { hash: '0xdestination', chainId: 8453 },
        ],
      },
    });
    expect(
      (result.quote.steps[0]?.items[0]?.receipt as { gasUsed?: bigint } | undefined)?.gasUsed,
    ).toBe(21_000n);
  });

  it('does not let a progress observer interrupt Relay execution', async () => {
    const executed = {
      details: {
        sender: USER,
        recipient: USER,
        currencyIn: { currency: { chainId: 10 } },
        currencyOut: {
          currency: {
            chainId: 8453,
            address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          },
        },
      },
      steps: [],
    } as Execute;
    const execute = vi.fn(async ({ onProgress }: { onProgress?: (data: never) => void }) => {
      onProgress?.({} as never);
      return { data: executed, abortController: new AbortController() };
    });
    const relayClient = {
      chains: [{ id: 10 }],
      actions: { execute },
    } as unknown as RelayClient;

    await expect(
      executeRelayQuote(executed, WALLET, {
        relay: { client: relayClient },
        onProgress: () => {
          throw new Error('render failed');
        },
      }),
    ).resolves.toMatchObject({ txHashes: [] });
  });

  it('preserves request and transaction evidence when Relay fails after broadcast', async () => {
    const rawQuote = {
      details: {
        sender: USER,
        recipient: USER,
        currencyIn: { currency: { chainId: 10 } },
        currencyOut: {
          currency: {
            chainId: 8453,
            address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          },
        },
      },
      steps: [
        {
          action: 'bridge',
          description: 'Bridge',
          kind: 'transaction',
          id: 'deposit',
          requestId: 'req-broadcast',
          items: [],
        },
      ],
    } as Execute;
    const progress = {
      ...rawQuote,
      steps: [
        {
          ...rawQuote.steps[0]!,
          items: [
            {
              status: 'incomplete',
              txHashes: [{ txHash: '0xorigin', chainId: 10 }],
            },
          ],
        },
      ],
    } as unknown as Execute;
    const execute = vi.fn(
      async ({ onProgress }: { onProgress?: (data: { steps: Execute['steps'] }) => void }) => {
        onProgress?.({ steps: progress.steps });
        throw new Error('status websocket disconnected');
      },
    );
    const relayClient = {
      chains: [{ id: 10 }],
      actions: { execute },
    } as unknown as RelayClient;

    const err = await executeRelayQuote(rawQuote, WALLET, {
      relay: { client: relayClient },
    }).catch((error) => error);

    expect(err).toMatchObject({
      code: 'SOURCE_EXECUTION_FAILED',
      retryable: false,
      recovery: {
        kind: 'inspect-relay-route',
        requestId: 'req-broadcast',
        txHashes: ['0xorigin'],
        transactions: { origin: [{ hash: '0xorigin', chainId: 10 }], destination: [] },
      },
    });
  });

  it('composes quoteSource output directly into executeSourceQuote', async () => {
    const executed = {
      details: {
        sender: USER,
        recipient: USER,
        currencyIn: { currency: { chainId: 10 } },
        currencyOut: {
          currency: {
            chainId: 8453,
            address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          },
        },
      },
      steps: [],
    } as Execute;
    const execute = vi.fn(async () => ({ data: executed, abortController: new AbortController() }));
    const relayClient = {
      chains: [{ id: 10 }],
      actions: { execute },
    } as unknown as RelayClient;
    const publicQuote = { raw: executed } as RelayQuote;

    await executeRelayQuote(publicQuote, WALLET, { relay: { client: relayClient } });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ quote: executed }));
  });

  it('will not execute a raw quote that routes somewhere other than Base USDC', async () => {
    const execute = vi.fn();
    const relayClient = {
      chains: [{ id: 10 }],
      actions: { execute },
    } as unknown as RelayClient;
    const rawQuote = {
      details: {
        currencyIn: { currency: { chainId: 10 } },
        currencyOut: { currency: { chainId: 1, address: '0xother' } },
      },
      steps: [],
    } as Execute;

    await expect(
      executeRelayQuote(rawQuote, WALLET, { relay: { client: relayClient } }),
    ).rejects.toMatchObject({ code: 'SOURCE_EXECUTION_FAILED' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['raw Execute', 'tampered RelayQuote'] as const)(
    'will not execute a %s whose Base recipient differs from the signer',
    async (shape) => {
      const execute = vi.fn();
      const relayClient = {
        chains: [{ id: 10 }],
        actions: { execute },
      } as unknown as RelayClient;
      const rawQuote = {
        details: {
          sender: USER,
          recipient: '0x9999999999999999999999999999999999999999',
          currencyIn: { currency: { chainId: 10 } },
          currencyOut: {
            currency: {
              chainId: 8453,
              address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            },
          },
        },
        steps: [],
      } as Execute;
      const quote = shape === 'raw Execute' ? rawQuote : ({ raw: rawQuote } as RelayQuote);

      await expect(
        executeRelayQuote(quote, WALLET, { relay: { client: relayClient } }),
      ).rejects.toMatchObject({ code: 'SOURCE_EXECUTION_FAILED' });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('will not execute a quote with a wallet pinned to the wrong source chain', async () => {
    const execute = vi.fn();
    const relayClient = {
      chains: [{ id: 10 }],
      actions: { execute },
    } as unknown as RelayClient;
    const wrongChainWallet = {
      account: { address: USER },
      chain: { id: 42161 },
      getChainId: vi.fn(async () => 42161),
    } as unknown as WalletClient;
    const rawQuote = {
      details: {
        sender: USER,
        recipient: USER,
        currencyIn: { currency: { chainId: 10 } },
        currencyOut: {
          currency: {
            chainId: 8453,
            address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          },
        },
      },
      steps: [],
    } as Execute;

    await expect(
      executeRelayQuote(rawQuote, wrongChainWallet, { relay: { client: relayClient } }),
    ).rejects.toMatchObject({ code: 'SIGNER_CHAIN_MISMATCH' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('checks the live chain id for a chainless Relay wallet before execution', async () => {
    const execute = vi.fn();
    const relayClient = {
      chains: [{ id: 10 }],
      actions: { execute },
    } as unknown as RelayClient;
    const chainlessWrongWallet = {
      account: { address: USER },
      chain: undefined,
      getChainId: vi.fn(async () => 42161),
    } as unknown as WalletClient;
    const rawQuote = {
      details: {
        sender: USER,
        recipient: USER,
        currencyIn: { currency: { chainId: 10 } },
        currencyOut: {
          currency: {
            chainId: 8453,
            address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          },
        },
      },
      steps: [],
    } as Execute;

    await expect(
      executeRelayQuote(rawQuote, chainlessWrongWallet, { relay: { client: relayClient } }),
    ).rejects.toMatchObject({ code: 'SIGNER_CHAIN_MISMATCH' });
    expect(chainlessWrongWallet.getChainId).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  describe('multi-transaction nonce management', () => {
    const baseDetails = {
      sender: USER,
      recipient: USER,
      currencyIn: { currency: { chainId: 10 } },
      currencyOut: {
        currency: {
          chainId: 8453,
          address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        },
      },
    };
    const multiTxQuote = {
      details: baseDetails,
      steps: [
        {
          action: 'approve',
          description: 'Approve',
          kind: 'transaction',
          id: 'approve',
          items: [{ status: 'incomplete', data: { to: '0xtoken', data: '0x095ea7b3' } }],
        },
        {
          action: 'deposit',
          description: 'Deposit',
          kind: 'transaction',
          id: 'deposit',
          items: [{ status: 'incomplete', data: { to: '0xrouter', data: '0xdeadbeef' } }],
        },
      ],
    } as unknown as Execute;
    const singleTxQuote = {
      details: baseDetails,
      steps: [multiTxQuote.steps[1]!],
    } as Execute;
    const walletWithAccount = (account: Record<string, unknown>) =>
      ({
        account: { address: USER, ...account },
        chain: { id: 10 },
        getChainId: vi.fn(async () => 10),
      }) as unknown as WalletClient;
    const workingRelayClient = () => {
      const execute = vi.fn(async () => ({
        data: { details: baseDetails, steps: [] } as unknown as Execute,
        abortController: new AbortController(),
      }));
      return {
        execute,
        client: { chains: [{ id: 10 }], actions: { execute } } as unknown as RelayClient,
      };
    };

    it('refuses a multi-transaction route for a local account without a nonce manager', async () => {
      const { execute, client } = workingRelayClient();

      await expect(
        executeRelayQuote(multiTxQuote, walletWithAccount({ type: 'local' }), {
          relay: { client },
        }),
      ).rejects.toMatchObject({
        code: 'SOURCE_NONCE_MANAGER_REQUIRED',
        retryable: false,
        remediation: expect.stringContaining('nonceManager'),
      });
      expect(execute).not.toHaveBeenCalled();
    });

    it('executes a multi-transaction route for a nonce-managed local account', async () => {
      const { execute, client } = workingRelayClient();

      await expect(
        executeRelayQuote(
          multiTxQuote,
          walletWithAccount({ type: 'local', nonceManager: { consume: vi.fn() } }),
          { relay: { client } },
        ),
      ).resolves.toMatchObject({ txHashes: [] });
      expect(execute).toHaveBeenCalledOnce();
    });

    it('executes a single-transaction route without requiring a nonce manager', async () => {
      const { execute, client } = workingRelayClient();

      await expect(
        executeRelayQuote(singleTxQuote, walletWithAccount({ type: 'local' }), {
          relay: { client },
        }),
      ).resolves.toMatchObject({ txHashes: [] });
      expect(execute).toHaveBeenCalledOnce();
    });

    it('leaves json-rpc accounts alone - the node allocates their nonces', async () => {
      const { execute, client } = workingRelayClient();

      await expect(
        executeRelayQuote(multiTxQuote, walletWithAccount({ type: 'json-rpc' }), {
          relay: { client },
        }),
      ).resolves.toMatchObject({ txHashes: [] });
      expect(execute).toHaveBeenCalledOnce();
    });
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
