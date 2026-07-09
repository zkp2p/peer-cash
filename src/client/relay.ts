import {
  createClient as createRelaySdkClient,
  MAINNET_RELAY_API,
  type Execute,
  type ProgressData,
  type RelayChain,
  type RelayClient,
} from '@relayprotocol/relay-sdk';
import { configureDynamicChains, fetchChainConfigs } from '@relayprotocol/relay-sdk/chain-utils';
import type { WalletClient } from 'viem';
import { BASE_CHAIN_ID, BASE_USDC_ADDRESS, USDC_DECIMALS } from '../engine/constants';
import type { PreparedTransaction } from '../sdk-types';

export const RELAY_API_URL = MAINNET_RELAY_API;

const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface CashAsset {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
  name?: string;
  isNative?: boolean;
}

export interface CashChain {
  id: number;
  name: string;
  displayName: string;
  disabled: boolean;
  depositEnabled: boolean;
  blockProductionLagging: boolean;
  vmType?: string;
  tokens: CashAsset[];
}

export interface CashSourceCapabilities {
  destination: CashAsset;
  chains: CashChain[];
  source: 'relay-sdk';
  asOf: number;
}

export interface RelayOptions {
  apiUrl?: string;
  apiKey?: string;
  source?: string;
  client?: RelayClient;
  chains?: RelayChain[];
}

export interface RelaySourceInput {
  chainId: number;
  currency: string;
}

export interface RelayQuoteInput {
  user: string;
  amount: bigint;
  source: RelaySourceInput;
  recipient?: string;
  tradeType?: 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'EXPECTED_OUTPUT';
}

export interface RelayQuote {
  requestId?: string;
  source: CashAsset;
  destination: CashAsset;
  inputAmount: bigint;
  outputAmount: bigint;
  rate?: number;
  timeEstimateSeconds?: number;
  fees?: unknown;
  txs: PreparedTransaction[];
  raw: Execute;
}

export interface RelayExecutionResult {
  requestId?: string;
  txHashes: string[];
  quote: Execute;
}

export interface RelayStatus {
  requestId: string;
  status: 'refund' | 'waiting' | 'depositing' | 'failure' | 'pending' | 'submitted' | 'success';
  details?: string;
  inTxHashes: string[];
  txHashes: string[];
  updatedAt?: number;
  originChainId?: number;
  destinationChainId?: number;
  quoteCreatedAt?: number;
  raw: unknown;
}

export const BASE_USDC_ASSET: CashAsset = {
  chainId: BASE_CHAIN_ID,
  address: BASE_USDC_ADDRESS,
  symbol: 'USDC',
  decimals: USDC_DECIMALS,
  name: 'USD Coin',
};

function relayClient(options: RelayOptions = {}): RelayClient {
  if (options.client) return options.client;
  return createRelaySdkClient({
    baseApiUrl: options.apiUrl ?? RELAY_API_URL,
    source: options.source ?? 'peer-cash',
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.chains ? { chains: options.chains } : {}),
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeToken(chainId: number, token: unknown): CashAsset | null {
  const row = asRecord(token);
  const address = asString(row.address);
  const symbol = asString(row.symbol);
  const decimals = asNumber(row.decimals);
  const name = asString(row.name);
  if (!address || !symbol || decimals === undefined) return null;
  const metadata = asRecord(row.metadata);
  return {
    chainId,
    address,
    symbol,
    decimals,
    ...(name ? { name } : {}),
    ...(metadata.isNative === true || address.toLowerCase() === NATIVE_TOKEN_ADDRESS
      ? { isNative: true }
      : {}),
  };
}

function normalizeTx(data: unknown, chainId: number): PreparedTransaction | null {
  const row = asRecord(data);
  const to = asString(row.to);
  const calldata = asString(row.data) ?? '0x';
  if (!to) return null;
  return {
    to: to as PreparedTransaction['to'],
    data: calldata as PreparedTransaction['data'],
    value: BigInt(String(row.value ?? '0')),
    chainId: asNumber(row.chainId) ?? chainId,
  };
}

function normalizeChain(chain: RelayChain): CashChain {
  const row = asRecord(chain);
  const tokenRows = [
    chain.currency,
    ...(chain.featuredTokens ?? []),
    ...(chain.erc20Currencies ?? []),
    ...(chain.solverCurrencies ?? []),
  ];
  const tokens = new Map<string, CashAsset>();
  for (const token of tokenRows) {
    const normalizedToken = normalizeToken(chain.id, token);
    if (normalizedToken) tokens.set(normalizedToken.address.toLowerCase(), normalizedToken);
  }
  return {
    id: chain.id,
    name: chain.name,
    displayName: chain.displayName,
    disabled: row.disabled === true,
    depositEnabled: chain.depositEnabled ?? false,
    blockProductionLagging: chain.blockProductionLagging ?? false,
    ...(chain.vmType ? { vmType: chain.vmType } : {}),
    tokens: [...tokens.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)),
  };
}

function isSupportedEvmChain(chain: CashChain): boolean {
  // RelayChain.vmType is optional in the SDK type and older/custom EVM chain
  // configs may omit it. Exclude chains only when Relay explicitly marks a
  // non-EVM VM that a viem WalletClient cannot execute.
  return chain.vmType === undefined || chain.vmType === 'evm';
}

function quoteRequestId(quote: Execute): string | undefined {
  return quote.steps.map((step) => step.requestId).find((id): id is string => id !== undefined);
}

function quoteSourceChainId(quote: Execute): number | undefined {
  const details = asRecord(quote.details);
  const currencyIn = asRecord(details.currencyIn);
  const sourceCurrency = asRecord(currencyIn.currency);
  return asNumber(sourceCurrency.chainId);
}

export function sanitizeRelayQuoteRaw(quote: Execute): Execute {
  if (!quote.request) return quote;
  const request = { ...quote.request };
  delete request.headers;
  return { ...quote, request };
}

async function resolveRelayChains(
  options: RelayOptions,
  client: RelayClient,
  config: { preferInjectedClientChains?: boolean } = {},
): Promise<RelayChain[]> {
  const preferInjectedClientChains = config.preferInjectedClientChains ?? true;
  const chains =
    options.chains ??
    (preferInjectedClientChains && options.client?.chains?.length
      ? options.client.chains
      : undefined) ??
    (options.client
      ? await fetchChainConfigs(client.baseApiUrl, client.source, client.apiKey)
      : await configureDynamicChains());
  client.chains = chains;
  return chains;
}

function relayQuoteFromExecute(input: RelayQuoteInput, quote: Execute): RelayQuote {
  const details = asRecord(quote.details);
  const currencyIn = asRecord(details.currencyIn);
  const currencyOut = asRecord(details.currencyOut);
  const sourceCurrency = asRecord(currencyIn.currency);
  const destinationCurrency = asRecord(currencyOut.currency);
  const source = normalizeToken(input.source.chainId, sourceCurrency) ?? {
    chainId: input.source.chainId,
    address: input.source.currency,
    symbol: 'TOKEN',
    decimals: 0,
  };
  const destination = normalizeToken(BASE_CHAIN_ID, destinationCurrency) ?? BASE_USDC_ASSET;
  const txs = quote.steps.flatMap((step) =>
    step.items
      .map((item) => normalizeTx(item.data, input.source.chainId))
      .filter((tx): tx is PreparedTransaction => tx !== null),
  );
  const outputAmount = BigInt(
    String(currencyOut.minimumAmount ?? currencyOut.amount ?? input.amount.toString()),
  );
  const requestId = quoteRequestId(quote);
  const rate = asNumber(details.rate);
  const timeEstimateSeconds = asNumber(details.timeEstimate);
  return {
    ...(requestId ? { requestId } : {}),
    source,
    destination,
    inputAmount: BigInt(String(currencyIn.amount ?? input.amount.toString())),
    outputAmount,
    ...(rate !== undefined ? { rate } : {}),
    ...(timeEstimateSeconds !== undefined ? { timeEstimateSeconds } : {}),
    ...(quote.fees !== undefined ? { fees: quote.fees } : {}),
    txs,
    raw: sanitizeRelayQuoteRaw(quote),
  };
}

export async function readRelaySourceCapabilities(
  options: RelayOptions = {},
): Promise<CashSourceCapabilities> {
  const client = relayClient(options);
  const chains = await resolveRelayChains(options, client);
  return {
    destination: BASE_USDC_ASSET,
    chains: chains
      .map(normalizeChain)
      .filter((chain) => chain.tokens.length > 0 && isSupportedEvmChain(chain))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    source: 'relay-sdk',
    asOf: Math.floor(Date.now() / 1000),
  };
}

export async function quoteRelayToBaseUsdc(
  input: RelayQuoteInput,
  options: RelayOptions = {},
): Promise<RelayQuote> {
  const client = relayClient(options);
  const quote = await client.actions.getQuote(
    {
      chainId: input.source.chainId,
      currency: input.source.currency,
      toChainId: BASE_CHAIN_ID,
      toCurrency: BASE_USDC_ADDRESS,
      user: input.user,
      recipient: input.recipient ?? input.user,
      amount: input.amount.toString(),
      tradeType: input.tradeType ?? 'EXACT_INPUT',
    },
    false,
  );
  return relayQuoteFromExecute(input, quote);
}

export async function executeRelayQuote(
  quote: Execute,
  wallet: WalletClient,
  options: {
    relay?: RelayOptions;
    onProgress?: (data: ProgressData) => void;
    disableCapabilitiesCheck?: boolean;
  } = {},
): Promise<RelayExecutionResult> {
  const client = relayClient(options.relay);
  const sourceChainId = quoteSourceChainId(quote);
  if (
    sourceChainId !== undefined &&
    !(client.chains ?? []).some((chain) => chain.id === sourceChainId)
  ) {
    await resolveRelayChains(options.relay ?? {}, client, { preferInjectedClientChains: false });
  }
  const { data } = await client.actions.execute({
    quote,
    wallet,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.disableCapabilitiesCheck !== undefined
      ? { disableCapabilitiesCheck: options.disableCapabilitiesCheck }
      : {}),
  });
  const requestId = quoteRequestId(data);
  return {
    ...(requestId ? { requestId } : {}),
    txHashes: data.steps.flatMap((step) =>
      step.items.flatMap((item) => (item.txHashes ?? []).map((tx) => tx.txHash)),
    ),
    quote: data,
  };
}

export async function readRelayStatus(
  requestId: string,
  options: RelayOptions = {},
): Promise<RelayStatus> {
  const client = relayClient(options);
  const response = await client.utils.request({
    url: `${client.baseApiUrl}/intents/status/v3`,
    method: 'get',
    params: { requestId },
  });
  const root = asRecord(response.data);
  const status = asString(root.status);
  if (
    status !== 'refund' &&
    status !== 'waiting' &&
    status !== 'depositing' &&
    status !== 'failure' &&
    status !== 'pending' &&
    status !== 'submitted' &&
    status !== 'success'
  ) {
    throw new Error(`Relay returned unknown status: ${String(root.status)}`);
  }
  const details = asString(root.details);
  const updatedAt = asNumber(root.updatedAt);
  const originChainId = asNumber(root.originChainId);
  const destinationChainId = asNumber(root.destinationChainId);
  const quoteCreatedAt = asNumber(root.quoteCreatedAt);
  return {
    requestId,
    status,
    ...(details ? { details } : {}),
    inTxHashes: Array.isArray(root.inTxHashes) ? root.inTxHashes.map(String) : [],
    txHashes: Array.isArray(root.txHashes) ? root.txHashes.map(String) : [],
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(originChainId !== undefined ? { originChainId } : {}),
    ...(destinationChainId !== undefined ? { destinationChainId } : {}),
    ...(quoteCreatedAt !== undefined ? { quoteCreatedAt } : {}),
    raw: response.data,
  };
}
