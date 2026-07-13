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
import { redactRelayQuoteRaw } from '../codecs/relayWire';
import { errors, isCashError } from './errors';
import { assertWalletChainId } from './wallet';

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
  /** Interpreted according to `tradeType`; defaults to exact source input. */
  amount: bigint;
  source: RelaySourceInput;
  recipient?: string;
  tradeType?: 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'EXPECTED_OUTPUT';
}

export interface RelayQuote {
  requestId?: string;
  source: CashAsset;
  destination: CashAsset;
  /** Source amount Relay expects the route to consume. */
  inputAmount: bigint;
  /** Conservative Base USDC output (Relay minimum output when supplied). */
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
  /** Chain-aware evidence (emitted by 0.1.4+; optional for wire compatibility). */
  transactions?: {
    origin: RelayTransaction[];
    destination: RelayTransaction[];
  };
  quote: Execute;
}

export interface RelayTransaction {
  hash: string;
  chainId: number;
  /** Relay batch-call identifiers are not transaction hashes. */
  isBatchTx?: boolean | undefined;
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

function isExecutableSourceChain(chain: CashChain): boolean {
  return (
    isSupportedEvmChain(chain) &&
    !chain.disabled &&
    chain.depositEnabled &&
    !chain.blockProductionLagging
  );
}

function quoteRequestId(quote: Execute): string | undefined {
  return quote.steps.map((step) => step.requestId).find((id): id is string => id !== undefined);
}

type RelayTransactions = NonNullable<RelayExecutionResult['transactions']>;

function collectRelayTransactions(
  steps: Execute['steps'],
  sourceChainId: number | undefined,
): RelayTransactions {
  const origin: RelayTransaction[] = [];
  const destination: RelayTransaction[] = [];
  const record = (tx: RelayTransaction) => {
    (tx.chainId === sourceChainId ? origin : destination).push(tx);
  };
  for (const step of steps) {
    for (const item of step.items) {
      for (const tx of item.internalTxHashes ?? []) {
        record({
          hash: tx.txHash,
          chainId: tx.chainId,
          ...(tx.isBatchTx ? { isBatchTx: true } : {}),
        });
      }
      for (const tx of item.txHashes ?? []) {
        record({
          hash: tx.txHash,
          chainId: tx.chainId,
          ...(tx.isBatchTx ? { isBatchTx: true } : {}),
        });
      }
    }
  }
  const dedupe = (txs: RelayTransaction[]) => [
    ...new Map(txs.map((tx) => [`${tx.chainId}:${tx.hash.toLowerCase()}`, tx])).values(),
  ];
  return { origin: dedupe(origin), destination: dedupe(destination) };
}

function relayTransactionHashes(transactions: RelayTransactions): string[] {
  return [
    ...new Set([...transactions.origin, ...transactions.destination].map(({ hash }) => hash)),
  ];
}

function quoteSourceChainId(quote: Execute): number | undefined {
  const details = asRecord(quote.details);
  const currencyIn = asRecord(details.currencyIn);
  const sourceCurrency = asRecord(currencyIn.currency);
  return asNumber(sourceCurrency.chainId);
}

function assertCanonicalRelayDestination(quote: Execute): void {
  const details = asRecord(quote.details);
  const currencyOut = asRecord(details.currencyOut);
  const destination = asRecord(currencyOut.currency);
  if (
    asNumber(destination.chainId) !== BASE_CHAIN_ID ||
    asString(destination.address)?.toLowerCase() !== BASE_USDC_ADDRESS.toLowerCase()
  ) {
    throw new Error('Relay quote destination is not canonical Base USDC');
  }
}

async function assertRelayExecutionIdentity(
  quote: Execute,
  wallet: WalletClient,
  expectedRecipient?: string,
): Promise<void> {
  const signer = wallet.account?.address;
  if (!signer) throw new Error('Relay execution requires a wallet account');
  const sourceChainId = quoteSourceChainId(quote);
  if (sourceChainId !== undefined) {
    await assertWalletChainId(wallet, sourceChainId, 'Relay execution');
  }
  const details = asRecord(quote.details);
  const sender = asString(details.sender);
  const recipient = asString(details.recipient);
  if (!sender || sender.toLowerCase() !== signer.toLowerCase()) {
    throw new Error('Relay quote sender does not match the execution signer');
  }
  const destinationOwner = expectedRecipient ?? signer;
  if (!recipient || recipient.toLowerCase() !== destinationOwner.toLowerCase()) {
    throw new Error('Relay quote recipient does not match the expected Base recipient');
  }
}

/**
 * Relay routes that submit more than one source-chain transaction (approve,
 * then route) are sent back-to-back by the Relay SDK, which reuses the
 * approval's nonce for the route transaction on plain local accounts and
 * reverts mid-route. A viem nonce manager allocates the nonces correctly, so
 * multi-transaction execution requires one up front - failing before any
 * transaction is submitted instead of after the approval has spent gas.
 */
function assertRelayNonceManagement(quote: Execute, wallet: WalletClient): void {
  const account = wallet.account;
  if (!account || account.type !== 'local' || account.nonceManager !== undefined) return;
  const transactionCount = quote.steps.flatMap((step) =>
    step.items.filter((item) => asString(asRecord(item.data).to) !== undefined),
  ).length;
  if (transactionCount > 1) throw errors.sourceNonceManagerRequired(transactionCount);
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
  const sourceChainId = asNumber(sourceCurrency.chainId);
  const sourceAddress = asString(sourceCurrency.address);
  const sender = asString(details.sender);
  const recipient = asString(details.recipient);
  const expectedRecipient = input.recipient ?? input.user;
  const destinationChainId = asNumber(destinationCurrency.chainId);
  const destinationAddress = asString(destinationCurrency.address);
  if (
    sourceChainId !== input.source.chainId ||
    sourceAddress?.toLowerCase() !== input.source.currency.toLowerCase()
  ) {
    throw new Error('Relay quote source does not match the requested asset');
  }
  if (!sender || sender.toLowerCase() !== input.user.toLowerCase()) {
    throw new Error('Relay quote sender does not match the requested wallet');
  }
  if (!recipient || recipient.toLowerCase() !== expectedRecipient.toLowerCase()) {
    throw new Error('Relay quote recipient does not match the requested Base recipient');
  }
  if (
    destinationChainId !== BASE_CHAIN_ID ||
    destinationAddress?.toLowerCase() !== BASE_USDC_ADDRESS.toLowerCase()
  ) {
    throw new Error('Relay quote destination is not canonical Base USDC');
  }
  const source = normalizeToken(input.source.chainId, sourceCurrency);
  if (!source) throw new Error('Relay quote source metadata is malformed');
  const destination = normalizeToken(destinationChainId, destinationCurrency);
  if (!destination) throw new Error('Relay quote destination metadata is malformed');
  const txs = quote.steps.flatMap((step) =>
    step.items
      .map((item) => normalizeTx(item.data, input.source.chainId))
      .filter((tx): tx is PreparedTransaction => tx !== null),
  );
  const rawOutputAmount = currencyOut.minimumAmount ?? currencyOut.amount;
  if (rawOutputAmount === undefined || rawOutputAmount === null) {
    throw new Error('Relay quote is missing an output amount');
  }
  const outputAmount = BigInt(String(rawOutputAmount));
  if (outputAmount <= 0n) throw new Error('Relay quote output amount must be positive');
  const requestId = quoteRequestId(quote);
  const rate = asNumber(details.rate);
  const timeEstimateSeconds = asNumber(details.timeEstimate);
  return {
    ...(requestId ? { requestId } : {}),
    source,
    destination,
    inputAmount: BigInt(String(currencyIn.amount)),
    outputAmount,
    ...(rate !== undefined ? { rate } : {}),
    ...(timeEstimateSeconds !== undefined ? { timeEstimateSeconds } : {}),
    ...(quote.fees !== undefined ? { fees: quote.fees } : {}),
    txs,
    raw: redactRelayQuoteRaw(quote),
  };
}

export async function readRelaySourceCapabilities(
  options: RelayOptions = {},
): Promise<CashSourceCapabilities> {
  try {
    const client = relayClient(options);
    const chains = await resolveRelayChains(options, client);
    return {
      destination: BASE_USDC_ASSET,
      chains: chains
        .map(normalizeChain)
        .filter((chain) => chain.tokens.length > 0 && isExecutableSourceChain(chain))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      source: 'relay-sdk',
      asOf: Math.floor(Date.now() / 1000),
    };
  } catch (err) {
    if (isCashError(err)) throw err;
    throw errors.sourceCapabilitiesFailed(err);
  }
}

export async function quoteRelayToBaseUsdc(
  input: RelayQuoteInput,
  options: RelayOptions = {},
): Promise<RelayQuote> {
  try {
    if (input.amount <= 0n) throw new Error('Relay quote amount must be positive');
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
  } catch (err) {
    if (isCashError(err)) throw err;
    throw errors.sourceQuoteFailed(err);
  }
}

export async function executeRelayQuote(
  quote: RelayQuote | Execute,
  wallet: WalletClient,
  options: {
    relay?: RelayOptions;
    /** Expected Base recipient. Defaults to the execution signer. */
    recipient?: string;
    onProgress?: (data: ProgressData) => void;
    disableCapabilitiesCheck?: boolean;
  } = {},
): Promise<RelayExecutionResult> {
  let observedRequestId: string | undefined;
  let observedTransactions: RelayTransactions = { origin: [], destination: [] };
  try {
    const rawQuote = 'raw' in quote ? quote.raw : quote;
    observedRequestId = quoteRequestId(rawQuote);
    assertCanonicalRelayDestination(rawQuote);
    await assertRelayExecutionIdentity(rawQuote, wallet, options.recipient);
    assertRelayNonceManagement(rawQuote, wallet);
    const client = relayClient(options.relay);
    const sourceChainId = quoteSourceChainId(rawQuote);
    if (
      sourceChainId !== undefined &&
      !(client.chains ?? []).some((chain) => chain.id === sourceChainId)
    ) {
      await resolveRelayChains(options.relay ?? {}, client, { preferInjectedClientChains: false });
    }
    const onProgress = (data: ProgressData) => {
      const progressSteps = Array.isArray(data.steps) ? data.steps : [];
      observedRequestId =
        progressSteps.map((step) => step.requestId).find((id): id is string => id !== undefined) ??
        observedRequestId;
      observedTransactions = collectRelayTransactions(progressSteps, sourceChainId);
      if (options.onProgress) {
        try {
          options.onProgress(data);
        } catch {
          // Observer failures must never interrupt a money-moving route.
        }
      }
    };
    const { data } = await client.actions.execute({
      quote: rawQuote,
      wallet,
      onProgress,
      ...(options.disableCapabilitiesCheck !== undefined
        ? { disableCapabilitiesCheck: options.disableCapabilitiesCheck }
        : {}),
    });
    const requestId = quoteRequestId(data) ?? observedRequestId;
    const transactions = collectRelayTransactions(data.steps, sourceChainId);
    return {
      ...(requestId ? { requestId } : {}),
      txHashes: relayTransactionHashes(transactions),
      transactions,
      quote: redactRelayQuoteRaw(data),
    };
  } catch (err) {
    if (isCashError(err)) throw err;
    const txHashes = relayTransactionHashes(observedTransactions);
    throw errors.sourceExecutionFailed(err, {
      ...(observedRequestId ? { requestId: observedRequestId } : {}),
      txHashes,
      ...(txHashes.length > 0 ? { transactions: observedTransactions } : {}),
    });
  }
}

export async function readRelayStatus(
  requestId: string,
  options: RelayOptions = {},
): Promise<RelayStatus> {
  try {
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
  } catch (err) {
    if (isCashError(err)) throw err;
    throw errors.sourceStatusFailed(requestId, err);
  }
}
