import type { z } from 'zod';
import { BASE_CHAIN_ID, BASE_USDC_ADDRESS, USDC_DECIMALS } from '../engine/constants';
import {
  nearIntentsQuoteResponseSchema,
  nearIntentsStatusResponseSchema,
  nearIntentsTokensResponseSchema,
} from '../codecs/schemas';
import { errors, isCashError } from './errors';

export const NEAR_INTENTS_API_URL = 'https://1click.chaindefuser.com';
export const NEAR_INTENTS_BASE_USDC_ASSET_ID =
  'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
export const NEAR_INTENTS_DEFAULT_SLIPPAGE_BPS = 100;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface NearIntentsToken {
  [key: string]: unknown;
  assetId: string;
  symbol: string;
  decimals: number;
  blockchain: string;
  price?: string | number | null | undefined;
  priceUpdatedAt?: string | undefined;
  contractAddress?: string | null | undefined;
}

export interface NearIntentsSourceCapabilities {
  destination: {
    assetId: typeof NEAR_INTENTS_BASE_USDC_ASSET_ID;
    chainId: typeof BASE_CHAIN_ID;
    address: typeof BASE_USDC_ADDRESS;
    symbol: 'USDC';
    decimals: typeof USDC_DECIMALS;
  };
  assets: NearIntentsToken[];
  source: 'near-intents';
  asOf: number;
}

export interface NearIntentsOptions {
  /** 1Click origin. Defaults to the official API, or to the app proxy root in proxy mode. */
  apiUrl?: string;
  /** Server-side 1Click JWT. Never expose this option in browser code. */
  token?: string;
  fetch?: typeof globalThis.fetch;
  /** Direct uses official `/v0/*` endpoints; proxy uses `/tokens|quote|submit|status`. */
  transport?: 'direct' | 'proxy';
  timeoutMs?: number;
}

export type NearIntentsTradeType = 'EXACT_INPUT' | 'EXACT_OUTPUT';

export interface NearIntentsQuoteInput {
  /** NEAR Intents asset id from `nearIntentsCapabilities()`. */
  sourceAsset: string;
  /** Source units for EXACT_INPUT; Base USDC units for EXACT_OUTPUT. */
  amount: bigint;
  /** Base address that will receive canonical USDC. */
  recipient: string;
  /** Refund address on the source chain. */
  refundTo: string;
  tradeType: NearIntentsTradeType;
  deadline: string;
  slippageTolerance?: number;
  dry?: boolean;
}

export interface NearIntentsQuoteRequest {
  dry: boolean;
  swapType: NearIntentsTradeType;
  slippageTolerance: number;
  originAsset: string;
  depositType: 'ORIGIN_CHAIN';
  destinationAsset: typeof NEAR_INTENTS_BASE_USDC_ASSET_ID;
  amount: string;
  refundTo: string;
  refundType: 'ORIGIN_CHAIN';
  recipient: string;
  recipientType: 'DESTINATION_CHAIN';
  deadline: string;
  depositMode: 'SIMPLE';
}

export interface NearIntentsQuote {
  provider: 'near-intents';
  correlationId?: string;
  sourceAsset: string;
  destinationAsset: typeof NEAR_INTENTS_BASE_USDC_ASSET_ID;
  inputAmount: bigint;
  minInputAmount: bigint;
  outputAmount: bigint;
  minOutputAmount: bigint;
  timeEstimateSeconds?: number;
  depositAddress?: string;
  depositMemo?: string;
  deadline?: string;
  signature: string;
  request: NearIntentsQuoteRequest;
  raw: unknown;
}

export interface NearIntentsDepositInput {
  depositAddress: string;
  txHash: string;
  depositMemo?: string;
}

export interface NearIntentsStatusInput {
  depositAddress: string;
  depositMemo?: string;
  /** Persisted signed quote used to reject status for a different route identity. */
  expectedQuote?: NearIntentsQuote;
}

export const NEAR_INTENTS_STATUSES = [
  'PENDING_DEPOSIT',
  'KNOWN_DEPOSIT_TX',
  'PROCESSING',
  'SUCCESS',
  'INCOMPLETE_DEPOSIT',
  'REFUNDED',
  'FAILED',
] as const;

export type NearIntentsStatusCode = (typeof NEAR_INTENTS_STATUSES)[number];

export interface NearIntentsTransaction {
  hash: string;
  explorerUrl?: string;
}

export interface NearIntentsStatus {
  provider: 'near-intents';
  correlationId?: string;
  depositAddress: string;
  depositMemo?: string;
  status: NearIntentsStatusCode;
  updatedAt?: string;
  inputAmount?: bigint;
  outputAmount?: bigint;
  refundedAmount?: bigint;
  refundReason?: string;
  intentHashes: string[];
  nearTransactionHashes: string[];
  originTransactions: NearIntentsTransaction[];
  destinationTransactions: NearIntentsTransaction[];
  raw: unknown;
}

export interface NearIntentsClient {
  capabilities(): Promise<NearIntentsSourceCapabilities>;
  quoteToBaseUsdc(input: NearIntentsQuoteInput): Promise<NearIntentsQuote>;
  submitDeposit(input: NearIntentsDepositInput): Promise<NearIntentsStatus>;
  status(input: NearIntentsStatusInput): Promise<NearIntentsStatus>;
}

interface RequestSpec {
  body?: unknown;
  method: 'GET' | 'POST';
  path: string;
}

function asErrorMessage(status: number): string {
  if (status === 401 || status === 403) return 'NEAR Intents authentication failed';
  if (status === 404) return 'NEAR Intents could not find this route';
  if (status === 429) return 'NEAR Intents is rate limited';
  if (status >= 500) return 'NEAR Intents is unavailable';
  return `NEAR Intents rejected the request (${status})`;
}

function normalizedBaseUrl(options: NearIntentsOptions): string {
  const value = options.apiUrl ?? NEAR_INTENTS_API_URL;
  return value.replace(/\/$/u, '');
}

function requestSpec(
  transport: 'direct' | 'proxy',
  operation: 'tokens' | 'quote' | 'submit' | 'status',
  value?: unknown,
): RequestSpec {
  if (transport === 'proxy') {
    const body =
      operation === 'submit'
        ? (() => {
            const input = value as NearIntentsDepositInput;
            return {
              depositAddress: input.depositAddress,
              txHash: input.txHash,
              ...(input.depositMemo ? { memo: input.depositMemo } : {}),
            };
          })()
        : operation === 'status'
          ? (() => {
              const input = value as NearIntentsStatusInput;
              return {
                depositAddress: input.depositAddress,
                ...(input.depositMemo ? { depositMemo: input.depositMemo } : {}),
              };
            })()
          : value;
    return {
      method: operation === 'tokens' ? 'GET' : 'POST',
      path: `/${operation}`,
      ...(operation === 'tokens' ? {} : { body }),
    };
  }
  switch (operation) {
    case 'tokens':
      return { method: 'GET', path: '/v0/tokens' };
    case 'quote':
      return { method: 'POST', path: '/v0/quote', body: value };
    case 'submit': {
      const input = value as NearIntentsDepositInput;
      return {
        method: 'POST',
        path: '/v0/deposit/submit',
        body: {
          depositAddress: input.depositAddress,
          txHash: input.txHash,
          ...(input.depositMemo ? { memo: input.depositMemo } : {}),
        },
      };
    }
    case 'status': {
      const input = value as NearIntentsStatusInput;
      const search = new URLSearchParams({ depositAddress: input.depositAddress });
      if (input.depositMemo) search.set('depositMemo', input.depositMemo);
      return { method: 'GET', path: `/v0/status?${search.toString()}` };
    }
  }
}

function assertString(value: string, label: string, maxLength = 512): void {
  if (value.length === 0 || value.length > maxLength) throw new Error(`${label} is invalid`);
}

function buildQuoteRequest(input: NearIntentsQuoteInput): NearIntentsQuoteRequest {
  if (input.amount <= 0n) throw new Error('NEAR Intents quote amount must be positive');
  if (!EVM_ADDRESS.test(input.recipient)) {
    throw new Error('NEAR Intents recipient must be a Base address');
  }
  assertString(input.sourceAsset, 'NEAR Intents source asset');
  assertString(input.refundTo, 'NEAR Intents refund address');
  const deadline = new Date(input.deadline);
  if (Number.isNaN(deadline.getTime())) {
    throw new Error('NEAR Intents deadline must be an ISO timestamp');
  }
  const slippageTolerance = input.slippageTolerance ?? NEAR_INTENTS_DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(slippageTolerance) || slippageTolerance < 0 || slippageTolerance > 10_000) {
    throw new Error('NEAR Intents slippageTolerance must be integer basis points');
  }
  return {
    dry: input.dry ?? false,
    swapType: input.tradeType,
    slippageTolerance,
    originAsset: input.sourceAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: NEAR_INTENTS_BASE_USDC_ASSET_ID,
    amount: input.amount.toString(),
    refundTo: input.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: input.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: input.deadline,
    depositMode: 'SIMPLE',
  };
}

const QUOTE_ECHO_FIELDS = [
  'dry',
  'swapType',
  'slippageTolerance',
  'originAsset',
  'destinationAsset',
  'amount',
  'refundTo',
  'recipient',
  'deadline',
] as const;

function normalizeQuote(
  request: NearIntentsQuoteRequest,
  value: z.infer<typeof nearIntentsQuoteResponseSchema>,
): NearIntentsQuote {
  for (const field of QUOTE_ECHO_FIELDS) {
    if (value.quoteRequest[field] !== request[field]) {
      throw new Error(`NEAR Intents quote does not match requested ${field}`);
    }
  }
  if (!request.dry && !value.quote.depositAddress) {
    throw new Error('NEAR Intents live quote is missing a deposit address');
  }
  const outputAmount = BigInt(value.quote.amountOut);
  const minOutputAmount = BigInt(value.quote.minAmountOut);
  if (outputAmount <= 0n || minOutputAmount <= 0n) {
    throw new Error('NEAR Intents quote output must be positive');
  }
  return {
    provider: 'near-intents',
    ...(value.correlationId ? { correlationId: value.correlationId } : {}),
    sourceAsset: request.originAsset,
    destinationAsset: NEAR_INTENTS_BASE_USDC_ASSET_ID,
    inputAmount: BigInt(value.quote.amountIn),
    minInputAmount: BigInt(value.quote.minAmountIn),
    outputAmount,
    minOutputAmount,
    ...(value.quote.timeEstimate !== undefined
      ? { timeEstimateSeconds: value.quote.timeEstimate }
      : {}),
    ...(value.quote.depositAddress ? { depositAddress: value.quote.depositAddress } : {}),
    ...(value.quote.depositMemo ? { depositMemo: value.quote.depositMemo } : {}),
    ...(value.quote.deadline ? { deadline: value.quote.deadline } : {}),
    signature: value.signature,
    request,
    raw: value,
  };
}

function transaction(value: unknown): NearIntentsTransaction | null {
  if (typeof value === 'string' && value.length > 0) return { hash: value };
  if (value === null || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.hash !== 'string' || row.hash.length === 0) return null;
  return {
    hash: row.hash,
    ...(typeof row.explorerUrl === 'string' && row.explorerUrl.length > 0
      ? { explorerUrl: row.explorerUrl }
      : {}),
  };
}

function normalizeStatus(
  input: NearIntentsStatusInput,
  value: z.infer<typeof nearIntentsStatusResponseSchema>,
): NearIntentsStatus {
  if (value.quoteResponse.quoteRequest.destinationAsset !== NEAR_INTENTS_BASE_USDC_ASSET_ID) {
    throw new Error('NEAR Intents status does not settle to canonical Base USDC');
  }
  const quotedAddress = value.quoteResponse.quote.depositAddress;
  const quotedMemo = value.quoteResponse.quote.depositMemo;
  if (!quotedAddress || quotedAddress !== input.depositAddress) {
    throw new Error('NEAR Intents status does not match the requested deposit address');
  }
  if ((input.depositMemo ?? undefined) !== (quotedMemo ?? undefined)) {
    throw new Error('NEAR Intents status does not match the requested deposit memo');
  }
  if (input.expectedQuote) {
    const expected = input.expectedQuote;
    if (
      expected.depositAddress !== input.depositAddress ||
      (expected.depositMemo ?? undefined) !== (input.depositMemo ?? undefined)
    ) {
      throw new Error('NEAR Intents expected quote does not match the status route');
    }
    for (const field of QUOTE_ECHO_FIELDS) {
      if (value.quoteResponse.quoteRequest[field] !== expected.request[field]) {
        throw new Error(`NEAR Intents status does not match quoted ${field}`);
      }
    }
    if (
      value.quoteResponse.quote.amountIn !== expected.inputAmount.toString() ||
      value.quoteResponse.quote.amountOut !== expected.outputAmount.toString()
    ) {
      throw new Error('NEAR Intents status amounts do not match the signed quote');
    }
  }
  const details = value.swapDetails ?? {};
  const originTransactions = (details.originChainTxHashes ?? [])
    .map(transaction)
    .filter((entry): entry is NearIntentsTransaction => entry !== null);
  const destinationTransactions = (details.destinationChainTxHashes ?? [])
    .map(transaction)
    .filter((entry): entry is NearIntentsTransaction => entry !== null);
  return {
    provider: 'near-intents',
    ...(value.correlationId ? { correlationId: value.correlationId } : {}),
    depositAddress: input.depositAddress,
    ...(input.depositMemo ? { depositMemo: input.depositMemo } : {}),
    status: value.status,
    ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
    ...(details.amountIn != null ? { inputAmount: BigInt(details.amountIn) } : {}),
    ...(details.amountOut != null ? { outputAmount: BigInt(details.amountOut) } : {}),
    ...(details.refundedAmount != null ? { refundedAmount: BigInt(details.refundedAmount) } : {}),
    ...(details.refundReason ? { refundReason: details.refundReason } : {}),
    intentHashes: details.intentHashes ?? [],
    nearTransactionHashes: details.nearTxHashes ?? [],
    originTransactions,
    destinationTransactions,
    raw: value,
  };
}

export function createNearIntentsClient(options: NearIntentsOptions = {}): NearIntentsClient {
  const transport = options.transport ?? 'direct';
  if (transport === 'proxy' && options.token) {
    throw new Error('NEAR Intents token cannot be sent to a same-origin proxy');
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const apiUrl = normalizedBaseUrl(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('NEAR Intents timeoutMs must be between 1 and 60000');
  }

  async function request<T>(
    operation: 'tokens' | 'quote' | 'submit' | 'status',
    schema: z.ZodType<T>,
    value?: unknown,
  ): Promise<T> {
    const spec = requestSpec(transport, operation, value);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImplementation(`${apiUrl}${spec.path}`, {
        method: spec.method,
        ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
        cache: 'no-store',
        credentials: transport === 'proxy' ? 'same-origin' : 'omit',
        headers: {
          Accept: 'application/json',
          ...(spec.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
    } catch (cause) {
      throw new Error(
        cause instanceof Error && cause.name === 'AbortError'
          ? 'NEAR Intents request timed out'
          : 'NEAR Intents request failed',
        { cause },
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(asErrorMessage(response.status));
    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new Error('NEAR Intents returned invalid JSON', { cause });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new Error('NEAR Intents returned an invalid response');
    return parsed.data;
  }

  return {
    async capabilities(): Promise<NearIntentsSourceCapabilities> {
      try {
        const tokens = await request('tokens', nearIntentsTokensResponseSchema);
        return {
          destination: {
            assetId: NEAR_INTENTS_BASE_USDC_ASSET_ID,
            chainId: BASE_CHAIN_ID,
            address: BASE_USDC_ADDRESS,
            symbol: 'USDC',
            decimals: USDC_DECIMALS,
          },
          assets: tokens
            .filter((token) => token.assetId !== NEAR_INTENTS_BASE_USDC_ASSET_ID)
            .sort((a, b) =>
              `${a.blockchain}:${a.symbol}`.localeCompare(`${b.blockchain}:${b.symbol}`),
            ),
          source: 'near-intents',
          asOf: Math.floor(Date.now() / 1000),
        };
      } catch (cause) {
        if (isCashError(cause)) throw cause;
        throw errors.sourceCapabilitiesFailed(cause, 'NEAR Intents', 'nearIntentsCapabilities');
      }
    },

    async quoteToBaseUsdc(input: NearIntentsQuoteInput): Promise<NearIntentsQuote> {
      try {
        const quoteRequest = buildQuoteRequest(input);
        const response = await request('quote', nearIntentsQuoteResponseSchema, quoteRequest);
        return normalizeQuote(quoteRequest, response);
      } catch (cause) {
        if (isCashError(cause)) throw cause;
        throw errors.sourceQuoteFailed(cause, 'NEAR Intents', 'quoteNearIntentsSource');
      }
    },

    async submitDeposit(input: NearIntentsDepositInput): Promise<NearIntentsStatus> {
      try {
        assertString(input.depositAddress, 'NEAR Intents deposit address');
        assertString(input.txHash, 'NEAR Intents transaction hash', 256);
        if (input.depositMemo) assertString(input.depositMemo, 'NEAR Intents deposit memo', 128);
        const response = await request('submit', nearIntentsStatusResponseSchema, input);
        return normalizeStatus(input, response);
      } catch (cause) {
        if (isCashError(cause)) throw cause;
        throw errors.sourceDepositSubmissionFailed(input.depositAddress, cause);
      }
    },

    async status(input: NearIntentsStatusInput): Promise<NearIntentsStatus> {
      try {
        assertString(input.depositAddress, 'NEAR Intents deposit address');
        if (input.depositMemo) assertString(input.depositMemo, 'NEAR Intents deposit memo', 128);
        const response = await request('status', nearIntentsStatusResponseSchema, input);
        return normalizeStatus(input, response);
      } catch (cause) {
        if (isCashError(cause)) throw cause;
        throw errors.sourceStatusFailed(
          input.depositAddress,
          cause,
          'NEAR Intents',
          'nearIntentsStatus',
        );
      }
    },
  };
}

export function readNearIntentsSourceCapabilities(
  options: NearIntentsOptions = {},
): Promise<NearIntentsSourceCapabilities> {
  return createNearIntentsClient(options).capabilities();
}

export function quoteNearIntentsToBaseUsdc(
  input: NearIntentsQuoteInput,
  options: NearIntentsOptions = {},
): Promise<NearIntentsQuote> {
  return createNearIntentsClient(options).quoteToBaseUsdc(input);
}

export function submitNearIntentsDeposit(
  input: NearIntentsDepositInput,
  options: NearIntentsOptions = {},
): Promise<NearIntentsStatus> {
  return createNearIntentsClient(options).submitDeposit(input);
}

export function readNearIntentsStatus(
  input: NearIntentsStatusInput,
  options: NearIntentsOptions = {},
): Promise<NearIntentsStatus> {
  return createNearIntentsClient(options).status(input);
}
