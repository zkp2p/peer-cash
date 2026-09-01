/**
 * `createCashClient` - the cash lifecycle facade over a read-only `Zkp2pClient`.
 *
 * The facade keeps the outward surface tiny (capabilities / estimate / cashout
 * / order / orders / watch / withdraw / topUp) while reusing the published
 * SDK's battle-tested internals. A React app, a Node service, and an AI agent
 * are equal consumers: Base-USDC mutations have unsigned `prepare` paths,
 * Relay execution is explicitly signer-backed, every wire type is serializable,
 * and every protocol transaction carries ERC-8021 attribution
 * ({@link CASH_ATTRIBUTION_CODE}).
 */
import {
  createWalletClient,
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type Transport,
  type WalletClient,
} from 'viem';
import { base, mainnet } from 'viem/chains';
import {
  Zkp2pClient,
  getPaymentMethodsCatalog,
  resolvePaymentMethodHashFromCatalog,
  appendAttributionToCalldata,
  createCompositeDepositId,
} from '@zkp2p/sdk';
import type { CurrencyType, PreparedTransaction, RuntimeEnv, TxOverrides } from '../sdk-types';
import {
  BASE_CHAIN_ID,
  BASE_USDC_ADDRESS,
  CASH_ACCESS_GROUP_IDS,
  CASH_ORDER_STATUSES,
  CASH_RESTRICTED_PLATFORMS,
} from '../engine/constants';
import { isCashCorridorSupported, prepareCashDepositParams } from '../engine/marketRate';
import { deriveCashOrder, isFillLive, type DeriveCashOrderOptions } from '../engine/orderState';
import { derivePayouts } from '../engine/payouts';
import { deriveBuyerProfile } from '../engine/buyerProfile';
import { toBigIntOrUndefined } from '../internal/convert';
import { parseCompositeDepositId, resolveCashDepositId } from '../engine/resolveDeposit';
import type { CashBuyerProfile, CashDepositInput, CashOrder } from '../engine/types';
import {
  buildCapabilities,
  platformRequiresIdentityAttestation,
  MIN_CASHOUT_AMOUNT,
  type CashCapabilities,
} from './capabilities';
import {
  readEstimate,
  type CashEstimate,
  type EstimateInput,
  type EstimateOptions,
} from './estimate';
import {
  fillEtaFromSample,
  readFillStatsSample,
  type CashFillStats,
  type FillStatsSample,
} from './fillEta';
import { CashError, errors, isCashError, mapChainError } from './errors';
import { normalizeCashPayee, type CashPayeeInput } from './payee';
import {
  readRelaySourceCapabilities,
  readRelayStatus,
  quoteRelayToBaseUsdc,
  executeRelayQuote,
  assertWalletChainId,
  type CashSourceCapabilities,
  type RelayOptions,
  type RelayExecutionResult,
  type RelayQuote,
  type RelayQuoteInput,
  type RelaySourceInput,
  type RelayStatus,
  type RelayTransaction,
} from './relay';
import type { Execute, ProgressData } from '@relayprotocol/relay-sdk';
import {
  createNearIntentsClient,
  readNearIntentsSourceCapabilities,
  type NearIntentsDepositInput,
  type NearIntentsOptions,
  type NearIntentsQuote,
  type NearIntentsQuoteInput,
  type NearIntentsSourceCapabilities,
  type NearIntentsStatus,
  type NearIntentsStatusInput,
} from './nearIntents';
import { isCreationRateCorridor, readAlipayCnyCreationRate } from './creationRate';
import { createCashAttributionReader } from './attribution';
import { isCashPayoutSet } from './classify';

const DEFAULT_RPC_URL = 'https://mainnet.base.org';
const DEFAULT_ETHEREUM_RPC_URL = 'https://ethereum-rpc.publicnode.com';
const FILL_STATS_CACHE_MS = 15 * 60 * 1000;

/**
 * ERC-8021 attribution code stamped on every transaction this package
 * produces (signed and prepare paths, including approves). The optional
 * namespaced `CashClientOptions.referralCode` marker and analytics-only
 * `referrer` codes follow it; the SDK appends the Base builder code last.
 */
export const CASH_ATTRIBUTION_CODE = 'peer-cash';
export const CASH_REFERRAL_ATTRIBUTION_PREFIX = 'peer-ref-';

const PEER_REFERRAL_CODE_RE = /^[A-Z0-9]{6}$/;

/** Convert a Peer referral code into its financially meaningful ERC-8021 marker. */
export function toCashReferralAttributionCode(rawCode: string): string {
  const code = rawCode.trim().toUpperCase();
  if (!PEER_REFERRAL_CODE_RE.test(code)) throw errors.invalidReferralCode();
  return `${CASH_REFERRAL_ATTRIBUTION_PREFIX}${code}`;
}

/**
 * The SDK selects the indexer from `runtimeEnv` but defaults the curator to
 * production; staging has its own curator deployment (same convention as the
 * first-party clients).
 */
const DEFAULT_CURATOR_URLS: Partial<Record<RuntimeEnv, string>> = {
  preproduction: 'https://api-preprod.zkp2p.xyz',
  staging: 'https://api-staging.zkp2p.xyz',
};
const ERC20_APPROVE_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const ERC20_ALLOWANCE_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
]);

export interface CashClientOptions {
  /** `'production' | 'preproduction' | 'staging'` - selects contracts, curator, and indexer. */
  environment: RuntimeEnv;
  /** viem transport for RPC reads; defaults to the public Base RPC. */
  transport?: Transport;
  /** Convenience alternative to `transport`. */
  rpcUrl?: string;
  /** Indexer URL override. */
  indexerUrl?: string;
  /** Optional indexer API key. */
  indexerApiKey?: string;
  /** Curator (ZKP2P API) URL override. */
  curatorUrl?: string;
  /** Optional ZKP2P API key. */
  apiKey?: string;
  /** Ethereum transport used only to snapshot Alipay/CNY's creation-time rate. */
  creationRateTransport?: Transport;
  /** Convenience alternative to `creationRateTransport`. */
  creationRateRpcUrl?: string;
  /** Relay API configuration for source assets outside Base USDC. */
  relay?: RelayOptions;
  /** NEAR Intents 1Click configuration for externally funded source routes. */
  nearIntents?: NearIntentsOptions;
  /**
   * Your six-character referral code from the Peer mobile or web app. The SDK
   * emits `peer-ref-XXXXXX`; when this deposit fills, Curator routes the
   * integration share to the Privy wallet that owns the code.
   */
  referralCode?: string;
  /**
   * Analytics-only ERC-8021 attribution code(s), appended after the Peer Cash
   * and optional integration-referral markers (e.g. `'acme-app'`).
   */
  referrer?: string | string[];
}

/** One payout leg: platform + currency + payee handle. */
export interface CashLeg {
  /** Platform id from `capabilities()`, e.g. `'venmo'`. */
  platform: string;
  /** Fiat currency to receive. */
  currency: CurrencyType;
  /** Raw handle or prepared curator data (needed for identity attestations). */
  payee: CashPayeeInput;
  currencies?: never;
}

export interface CashMultiCurrencyLeg {
  /** Platform id from `capabilities()`, e.g. `'revolut'`. */
  platform: string;
  /** Fiat currencies a buyer may use to fill this cash-out. */
  currencies: readonly [CurrencyType, ...CurrencyType[]];
  /** Raw handle or prepared curator data shared by every offered currency. */
  payee: CashPayeeInput;
  currency?: never;
}

/** One payout leg of a cash-out - single-currency or multi-currency. */
export type CashReceiveLeg = CashLeg | CashMultiCurrencyLeg;

export interface CashoutInput {
  /**
   * Amount to cash out. Without `source`, this is Base USDC base units. With
   * `source`, Relay interprets it according to `tradeType`; the default
   * `EXACT_INPUT` treats it as source-token base units.
   */
  amount: bigint;
  /** Optional Relay source asset. Omit for the Base USDC default path. */
  source?: RelaySourceInput & {
    /** Base recipient for bridged USDC; defaults to the signer address. */
    recipient?: string;
    /** Relay amount mode. Omit for the recommended exact source-input flow. */
    tradeType?: 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'EXPECTED_OUTPUT';
  };
  /**
   * Where the fiat should arrive. One leg, or an array of legs to offer the
   * buyer several payout platforms (each platform at most once). One method
   * may offer multiple currencies. Inspect `capabilities().platforms[].pricing`
   * for whether a corridor binds at intent signal or deposit preparation.
   */
  receive: CashReceiveLeg | readonly [CashReceiveLeg, ...CashReceiveLeg[]];
  /** Per-order min/max override (USDC base units). */
  intentAmountRange?: { min: bigint; max: bigint };
}

export interface SignerOptions {
  /** Any viem WalletClient with a Base account, including a local or external EOA. */
  signer: WalletClient;
}

export interface CashoutOptions extends SignerOptions {
  /** Source-chain signer for Relay. Required when `input.source.chainId` is not Base. */
  sourceSigner?: WalletClient;
  /** Relay execution progress callback when `input.source` is present. */
  onSourceProgress?: (data: ProgressData) => void;
  /** Forwarded to Relay SDK for wallets with broken EIP-5792 capability calls. */
  disableSourceCapabilitiesCheck?: boolean;
}

export interface WithdrawOptions extends SignerOptions {
  /**
   * Partial amount to withdraw (USDC base units). Only unlocked funds are
   * withdrawable partially - a live buyer intent does not block it. Omit to
   * close the order fully (prunes expired intents first when needed).
   */
  amount?: bigint;
}

export interface TopUpResult {
  depositId: string;
  txHash: Hash;
}

export type CashPreparedStepKind =
  | 'approve'
  | 'createDeposit'
  | 'pruneExpiredIntents'
  | 'withdrawDeposit'
  | 'removeFunds'
  | 'addFunds';

export interface CashPreparedStep {
  /** Stable action label for the transaction at the same index in `txs[]`. */
  kind: CashPreparedStepKind;
  /** Human-readable reason to show in approval UIs, logs, or policy reviews. */
  description: string;
}

export interface CashoutResult {
  /** Composite deposit id (`escrow_onchainId`) - the resume key. Bind it to your user. */
  depositId: string;
  txHash: Hash;
  escrowAddress: string;
  onchainDepositId: bigint;
  /** Optimistic snapshot (`awaiting-buyer`); poll `order(depositId)` for live state. */
  order: CashOrder;
  /** Last confirmed access-policy transaction. Retained for single-policy compatibility. */
  accessPolicyTxHash?: Hash;
  /** Confirmed method-scoped policy transactions for restricted payout legs. */
  accessPolicyTxHashes?: Hash[];
  /** Present when `cashout()` first routed a source asset through Relay. */
  source?: {
    /** Conservative Base USDC amount deposited (Relay's guaranteed minimum output). */
    amount: bigint;
    requestId?: string;
    txHashes: string[];
    /** Chain-aware evidence (emitted by 0.1.4+; optional for wire compatibility). */
    transactions?: { origin: RelayTransaction[]; destination: RelayTransaction[] };
  };
}

export interface PrepareResult {
  /**
   * Unsigned transactions in submission order: `[approve, createDeposit]`.
   * Submit with any signer - agent wallet, AA bundler, server key. Drop the
   * approve when the escrow already has sufficient allowance.
   */
  txs: PreparedTransaction[];
  /** One label per transaction in `txs[]`, same order. */
  steps: CashPreparedStep[];
  /** Curator payee registration output - the payee hashes now live on the deposit params. */
  register: { hashedOnchainIds: string[] };
  /** Whether the host must submit and confirm the policy after `createDeposit` confirms. */
  accessPolicyRequired: boolean;
  /** Method hashes that each require a post-deposit Peer Pay policy transaction. */
  accessPolicyPaymentMethods: Hex[];
}

/** Confirmed createDeposit receipt from an externally executed prepare() plan. */
export interface PreparedCashoutReceipt {
  transactionHash: Hash;
  status: 'success' | 'reverted';
  logs: readonly Log[];
}

export interface WithdrawResult {
  depositId: string;
  /** Present when expired intents had to be pruned before withdrawal. */
  pruneTxHash?: Hash;
  withdrawTxHash: Hash;
}

export interface WatchOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface OrdersOptions {
  /** Only orders still needing attention (`awaiting-buyer` / `matched` / `delivering`). */
  inFlight?: boolean;
  /** Max deposits to scan (default 100). */
  limit?: number;
}

export interface CashClient {
  /** 0 - Discovery: sync, static. */
  capabilities(): CashCapabilities;
  /** 0b - Discovery with live Relay-supported EVM source chains/tokens. */
  capabilities(options: {
    includeRelaySources: true;
    includeNearIntentsSources?: true;
  }): Promise<CashCapabilities>;
  /** 0c - Discovery with live NEAR Intents 1Click source assets. */
  capabilities(options: {
    includeRelaySources?: true;
    includeNearIntentsSources: true;
  }): Promise<CashCapabilities>;
  /**
   * 0d - Raw 30-day demand and first-fill speed evidence keyed by an exact
   * `platform:currency` pair or sorted multi-currency set. A recommended
   * consumer gate is `fills >= 10 && medianFillSeconds <= 48h`; fail open to
   * the full capability catalog when stats are unavailable or the gate would
   * remove every pair.
   */
  fillStats(): Promise<CashFillStats>;
  /** Relay-only source discovery helper. */
  sourceCapabilities(): Promise<CashSourceCapabilities>;
  /** Quote any Relay-supported EVM source asset into Base USDC. */
  quoteSource(input: RelayQuoteInput): Promise<RelayQuote>;
  /** Execute a Relay SDK quote into Base USDC before starting the Peer Cash order. */
  executeSourceQuote(
    quote: RelayQuote | Execute,
    opts: {
      /** Wallet signer on the quote's source chain. */
      signer: WalletClient;
      /** Expected Base recipient. Defaults to the source signer. */
      recipient?: string;
      onProgress?: (data: ProgressData) => void;
      disableCapabilitiesCheck?: boolean;
    },
  ): Promise<RelayExecutionResult>;
  /** Track Relay execution status by quote/request id. */
  relayStatus(requestId: string): Promise<RelayStatus>;
  /** Discover live NEAR Intents assets that can route into canonical Base USDC. */
  nearIntentsCapabilities(): Promise<NearIntentsSourceCapabilities>;
  /** Quote a NEAR Intents external-deposit route into canonical Base USDC. */
  quoteNearIntentsSource(input: NearIntentsQuoteInput): Promise<NearIntentsQuote>;
  /** Optionally register an already-broadcast origin transaction with 1Click. */
  submitNearIntentsDeposit(input: NearIntentsDepositInput): Promise<NearIntentsStatus>;
  /** Track a NEAR Intents route by its provider-issued deposit address and memo. */
  nearIntentsStatus(input: NearIntentsStatusInput): Promise<NearIntentsStatus>;
  /** 1 - Estimate: currency + amount only. No payee, no side effects, no expiry. */
  estimate(input: EstimateInput, options?: EstimateOptions): Promise<CashEstimate>;
  /** 2 - Cash out: payee registration + deposit params + submission happen here. */
  cashout(input: CashoutInput, opts: CashoutOptions): Promise<CashoutResult>;
  /** 2b - Unsigned path: `txs[]` for agent wallets, AA, server keys, policy layers. */
  prepare(input: CashoutInput): Promise<PrepareResult>;
  /** Resolve an externally executed createDeposit receipt into resumable cash-out state. */
  finalizePreparedCashout(receipt: PreparedCashoutReceipt): CashoutResult;
  /** Prepare one method-scoped Peer Pay follow-up for a restricted cash-out. */
  prepareAccessPolicy(depositId: string, paymentMethod: Hex): PreparedTransaction;
  /** 3 - Observe: resumable from `depositId` alone; no session state anywhere. */
  order(depositId: string): Promise<CashOrder>;
  /**
   * 3b - Observe helper: a buyer's protocol track record from their full
   * intent history. Answers "who just matched my order?" during `matched`.
   */
  buyer(address: string): Promise<CashBuyerProfile>;
  /** 4 - List: indexer-native. A cash order IS a deposit; the chain is the database. */
  orders(owner: string, opts?: OrdersOptions): Promise<CashOrder[]>;
  /** 5 - Watch: yields on change; ends at a terminal state, abort, or timeout. */
  watch(depositId: string, opts?: WatchOptions): AsyncGenerator<CashOrder, void, void>;
  /**
   * 6 - Withdraw: ONE unwind verb. With `amount`, withdraws that much of the
   * unlocked balance (partial; a live buyer intent does not block it).
   * Without, closes the order fully - pruning expired intents first when
   * needed.
   */
  withdraw(depositId: string, opts: WithdrawOptions): Promise<WithdrawResult>;
  /**
   * 6b - Unsigned path for the unwind verb (agent surface): the same state
   * checks as `withdraw()`, returning `txs[]` for host-side signing.
   */
  prepareWithdraw(
    depositId: string,
    opts?: { amount?: bigint },
  ): Promise<{ txs: PreparedTransaction[]; steps: CashPreparedStep[] }>;
  /** 7 - Top up: add USDC to a live order (same payee, same market rate). */
  topUp(depositId: string, amount: bigint, opts: SignerOptions): Promise<TopUpResult>;
  /** 7b - Unsigned path: `[approve, addFunds]` for host-side signing. */
  prepareTopUp(
    depositId: string,
    amount: bigint,
  ): Promise<{ txs: PreparedTransaction[]; steps: CashPreparedStep[] }>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function orderFingerprint(order: CashOrder): string {
  return [
    order.state,
    order.filledAmount,
    order.pendingAmount,
    order.returnedAmount,
    order.intentCount ?? 0,
    order.nextActions.join('+'),
  ].join('|');
}

/**
 * Send a mutating on-chain call, then wait for and verify its receipt.
 * Submission errors are mapped to typed `CashError`s; a reverted receipt
 * throws `TRANSACTION_FAILED` - a mutating verb never reports success for a
 * transaction that did not land, and never leaks a raw RPC error to the caller.
 */
async function submitAndConfirm(
  client: Zkp2pClient,
  verb: string,
  send: () => Promise<`0x${string}`>,
): Promise<Hash> {
  let hash: Hash;
  try {
    hash = (await send()) as Hash;
  } catch (err) {
    const mapped = mapChainError(verb, err);
    if (isKnownPreBroadcastFailure(mapped)) throw mapped;
    throw errors.transactionSubmissionUnknown(verb, err, {
      kind: 'inspect-base-operation-submission',
      operation: verb,
    });
  }
  let receipt;
  try {
    receipt = await client.publicClient.waitForTransactionReceipt({ hash });
  } catch (err) {
    throw errors.transactionStatusUnknown(hash, err, verb);
  }
  if (receipt.status === 'reverted') throw errors.transactionFailed(hash);
  return hash;
}

function isKnownPreBroadcastFailure(mapped: CashError): boolean {
  return (
    mapped.code === 'TRANSACTION_REJECTED' ||
    mapped.code === 'INSUFFICIENT_TOKEN_BALANCE' ||
    mapped.code === 'ALLOWANCE_NOT_VISIBLE' ||
    mapped.code === 'ESCROW_PAUSED'
  );
}

function cashoutAccessPolicyPaymentMethods(
  depositInput: CashDepositInput,
  environment: RuntimeEnv,
): Hex[] {
  const catalog = getPaymentMethodsCatalog(BASE_CHAIN_ID, environment);
  return [
    ...new Set(
      depositInput.payouts
        .filter((payout) => CASH_RESTRICTED_PLATFORMS.has(payout.processorName.toLowerCase()))
        .map((payout) => resolvePaymentMethodHashFromCatalog(payout.processorName, catalog)),
    ),
  ];
}

/** The indexer aggregate fields both deposit queries share. */
type DepositAggregates = {
  remainingDeposits?: string | number | null;
  outstandingIntentAmount?: string | number | null;
  totalAmountTaken?: string | number | null;
  totalWithdrawn?: string | number | null;
  status?: string | null;
  totalIntents?: number | null;
  updatedAt?: string | number | null;
};

/** The indexer aggregate fields both deposit queries share. */
type DepositAggregatesWithQuality = DepositAggregates & {
  successRateBps?: number | null;
};

/** Map raw indexer deposit aggregates to `deriveCashOrder` options. */
function depositOrderOptions(deposit: DepositAggregatesWithQuality): DeriveCashOrderOptions {
  const remaining = toBigIntOrUndefined(deposit.remainingDeposits);
  const outstanding = toBigIntOrUndefined(deposit.outstandingIntentAmount);
  const taken = toBigIntOrUndefined(deposit.totalAmountTaken);
  const withdrawn = toBigIntOrUndefined(deposit.totalWithdrawn);
  const updatedAt = deposit.updatedAt != null ? Number(deposit.updatedAt) : undefined;
  return {
    ...(remaining !== undefined ? { remainingAmount: remaining } : {}),
    ...(outstanding !== undefined ? { outstandingAmount: outstanding } : {}),
    ...(taken !== undefined ? { takenAmount: taken } : {}),
    ...(withdrawn !== undefined ? { withdrawnAmount: withdrawn } : {}),
    ...(deposit.status != null ? { status: deposit.status } : {}),
    ...(deposit.totalIntents != null ? { intentCount: deposit.totalIntents } : {}),
    ...(deposit.successRateBps != null ? { successRateBps: deposit.successRateBps } : {}),
    ...(updatedAt !== undefined && Number.isFinite(updatedAt) ? { updatedAt } : {}),
  };
}

export function createCashClient(options: CashClientOptions): CashClient {
  const { environment } = options;
  const transport = options.transport ?? http(options.rpcUrl ?? DEFAULT_RPC_URL);
  const creationRateTransport =
    options.creationRateTransport ?? http(options.creationRateRpcUrl ?? DEFAULT_ETHEREUM_RPC_URL);
  const creationRateClient = createPublicClient({
    chain: mainnet,
    transport: creationRateTransport,
  });
  const readCashAttribution = createCashAttributionReader({
    environment,
    ...(options.indexerUrl ? { indexerUrl: options.indexerUrl } : {}),
    ...(options.indexerApiKey ? { indexerApiKey: options.indexerApiKey } : {}),
  });

  // ERC-8021: 'peer-cash' first, then the one financially meaningful referral
  // marker, then analytics codes. The SDK appends the Base builder code last.
  const referrerCodes = [
    CASH_ATTRIBUTION_CODE,
    ...(options.referralCode === undefined
      ? []
      : [toCashReferralAttributionCode(options.referralCode)]),
    ...(options.referrer === undefined
      ? []
      : Array.isArray(options.referrer)
        ? options.referrer
        : [options.referrer]),
  ];
  const attribution: TxOverrides = { referrer: referrerCodes };

  function buildSdkClient(walletClient: WalletClient): Zkp2pClient {
    return new Zkp2pClient({
      walletClient,
      chainId: BASE_CHAIN_ID,
      runtimeEnv: environment,
      rpcTransport: transport,
      ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
      ...(options.indexerUrl ? { indexerUrl: options.indexerUrl } : {}),
      ...(options.indexerApiKey ? { indexerApiKey: options.indexerApiKey } : {}),
      ...((options.curatorUrl ?? DEFAULT_CURATOR_URLS[environment])
        ? { baseApiUrl: options.curatorUrl ?? DEFAULT_CURATOR_URLS[environment] }
        : {}),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    });
  }

  // Read-only client - indexer, curator registration, oracle reads.
  const readClient = buildSdkClient(createWalletClient({ chain: base, transport }));

  // Fill history is one environment-wide snapshot. Cache and de-duplicate the
  // expensive paginated read, then resolve each ETA from its exact
  // normalized platform:currency key.
  let fillStatsCache: { sample: FillStatsSample; expiresAt: number } | null = null;
  let fillStatsRequest: Promise<FillStatsSample> | null = null;
  async function getFillStatsSample(): Promise<FillStatsSample> {
    if (fillStatsCache && fillStatsCache.expiresAt > Date.now()) {
      return fillStatsCache.sample;
    }
    if (fillStatsRequest) return fillStatsRequest;

    fillStatsRequest = readFillStatsSample(readClient, environment);
    try {
      const sample = await fillStatsRequest;
      fillStatsCache = {
        sample,
        expiresAt: Date.now() + FILL_STATS_CACHE_MS,
      };
      return sample;
    } finally {
      fillStatsRequest = null;
    }
  }

  // Signing clients are built lazily and cached per WalletClient identity.
  const signingClients = new WeakMap<WalletClient, Zkp2pClient>();
  async function signingClient(verb: string, opts?: SignerOptions): Promise<Zkp2pClient> {
    const signer = opts?.signer;
    if (!signer?.account) throw errors.signerRequired(verb);
    await assertWalletChainId(signer, BASE_CHAIN_ID, verb);
    let client = signingClients.get(signer);
    if (!client) {
      client = buildSdkClient(signer);
      signingClients.set(signer, client);
    }
    return client;
  }

  function validatePayout(input: CashoutInput): Omit<CashDepositInput, 'amount'> {
    const legs: readonly CashReceiveLeg[] = Array.isArray(input.receive)
      ? input.receive
      : [input.receive as CashReceiveLeg];
    if (legs.length === 0) {
      throw errors.invalidPayoutPlatforms('at least one payout leg is required');
    }
    const capabilities = buildCapabilities(environment);
    const seenPlatforms = new Set<string>();
    const payouts = legs.map((leg): CashDepositInput['payouts'][number] => {
      const platform = capabilities.platforms.find(
        (capability) => capability.platform === leg.platform,
      );
      if (!platform) throw errors.unsupportedPlatform(leg.platform);
      if (seenPlatforms.has(leg.platform)) {
        throw errors.invalidPayoutPlatforms(
          `${leg.platform} appears more than once - each platform may carry one leg`,
        );
      }
      seenPlatforms.add(leg.platform);
      if ((leg.currency === undefined) === (leg.currencies === undefined)) {
        throw errors.invalidPayoutCurrencies(
          leg.platform,
          'pass exactly one of currency or currencies',
        );
      }
      const currencies = leg.currencies !== undefined ? [...leg.currencies] : [leg.currency];
      if (currencies.length === 0) {
        throw errors.invalidPayoutCurrencies(leg.platform, 'at least one currency is required');
      }
      if (new Set(currencies).size !== currencies.length) {
        throw errors.invalidPayoutCurrencies(leg.platform, 'currencies must be unique');
      }
      for (const currency of currencies) {
        if (!isCashCorridorSupported(leg.platform, currency)) {
          throw errors.oracleUnsupportedCurrency(currency);
        }
        if (!platform.currencies.includes(currency)) {
          throw errors.unsupportedPlatformCurrency(leg.platform, currency);
        }
      }
      return {
        processorName: leg.platform,
        ...(currencies.length === 1
          ? { currency: currencies[0]! }
          : { currencies: currencies as [CurrencyType, ...CurrencyType[]] }),
        payeeData: normalizeCashPayee(leg.platform, leg.payee),
      };
    });
    return { payouts };
  }

  function validateDepositInput(
    amount: bigint,
    input: CashoutInput,
    payoutInput: Omit<CashDepositInput, 'amount'> = validatePayout(input),
  ): CashDepositInput {
    if (amount < MIN_CASHOUT_AMOUNT) {
      throw errors.amountBelowMinimum(amount, MIN_CASHOUT_AMOUNT);
    }
    const range = input.intentAmountRange;
    if (range && (range.min <= 0n || range.max < range.min || range.max > amount)) {
      throw errors.invalidIntentAmountRange(amount, range.min, range.max);
    }
    return {
      amount,
      ...payoutInput,
      ...(range ? { intentAmountRange: range } : {}),
    };
  }

  function hasCreationRateCorridor(input: CashDepositInput): boolean {
    return input.payouts.some((payout) => {
      const currencies = payout.currencies ?? (payout.currency ? [payout.currency] : []);
      return currencies.some((currency) => isCreationRateCorridor(payout.processorName, currency));
    });
  }

  async function buildDepositParams(client: Zkp2pClient, depositInput: CashDepositInput) {
    try {
      return await prepareCashDepositParams(
        client,
        depositInput,
        undefined,
        async (platform, currency) => {
          if (!isCreationRateCorridor(platform, currency)) {
            throw new Error(`No creation-time rate reader for ${platform}/${currency}`);
          }
          try {
            return await readAlipayCnyCreationRate(creationRateClient);
          } catch (err) {
            throw errors.oracleReadFailed(currency, err);
          }
        },
      );
    } catch (err) {
      if (isCashError(err)) throw err;
      // The curator rejects Wise/PayPal/Alipay payees that lack a signed attestation.
      const message = err instanceof Error ? err.message : String(err);
      if (/identityAttestation is required|identity attestation/i.test(message)) {
        const platforms = depositInput.payouts.map((payout) => payout.processorName);
        const platform =
          platforms.find(platformRequiresIdentityAttestation) ?? platforms[0] ?? 'this platform';
        throw errors.payeeVerificationRequired(platform, err);
      }
      throw errors.payeeRegistrationFailed(err);
    }
  }

  function parseDepositId(depositId: string) {
    try {
      const parsed = parseCompositeDepositId(depositId);
      return {
        ...parsed,
        compositeId: createCompositeDepositId(parsed.escrowAddress, parsed.onchainDepositId),
      };
    } catch (err) {
      throw errors.invalidDepositId(depositId, err);
    }
  }

  async function fetchOrder(depositId: string): Promise<CashOrder> {
    const { compositeId } = parseDepositId(depositId);
    let deposits;
    try {
      deposits = await readClient.indexer.getDepositsByIdsWithRelations([compositeId], {
        includeIntents: true,
        intentStatuses: CASH_ORDER_STATUSES,
      });
    } catch (err) {
      throw errors.indexerUnavailable('order', err);
    }
    const deposit = deposits[0];

    if (!deposit) {
      // Deposit not yet indexed (lag right after creation) - read intents directly.
      let intents;
      try {
        intents = await readClient.indexer.getIntentsForDeposits(
          [compositeId],
          CASH_ORDER_STATUSES,
        );
      } catch (err) {
        throw errors.indexerUnavailable('order intents', err);
      }
      if (intents.length === 0) throw errors.orderNotFound(compositeId);
      return deriveCashOrder(compositeId, intents);
    }

    // Reconstruct the payout legs (platform, currency, payee hash, pricing
    // proof) from the relations the same query already returned.
    const payouts = derivePayouts(
      deposit.paymentMethods ?? [],
      deposit.currencies ?? [],
      getPaymentMethodsCatalog(BASE_CHAIN_ID, environment),
    );
    let attributedToCash = false;
    if (!isCashPayoutSet(payouts)) {
      try {
        attributedToCash = (await readCashAttribution([compositeId])).has(
          compositeId.toLowerCase(),
        );
      } catch (err) {
        throw errors.indexerUnavailable('cash attribution', err);
      }
    }
    if (!isCashPayoutSet(payouts, attributedToCash)) throw errors.orderNotFound(compositeId);

    return deriveCashOrder(compositeId, deposit.intents ?? [], {
      ...depositOrderOptions(deposit),
      payouts,
    });
  }

  /** Parse the composite id into the on-chain id + optional escrow override. */
  function escrowContext(depositId: string): {
    onchainDepositId: bigint;
    escrowArg: { escrowAddress?: Address };
  } {
    const { escrowAddress, onchainDepositId } = parseDepositId(depositId);
    return {
      onchainDepositId,
      escrowArg: escrowAddress ? { escrowAddress: escrowAddress as Address } : {},
    };
  }

  /** Available (unlocked, undelivered) balance of an order. */
  function availableAmount(order: CashOrder): bigint {
    return order.totalAmount - order.filledAmount - order.pendingAmount - order.returnedAmount;
  }

  /**
   * State gate for the full-close withdraw paths: throws when withdrawal is
   * blocked or pointless, and reports whether an expired intent must be
   * pruned first.
   */
  async function withdrawContext(depositId: string): Promise<{
    expiredIntent: boolean;
    onchainDepositId: bigint;
    escrowArg: { escrowAddress?: Address };
  }> {
    const order = await fetchOrder(depositId);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const signaled = order.fills.filter((f) => f.status === 'SIGNALED');
    const liveIntent = signaled.some((f) => isFillLive(f, nowSeconds));
    const expiredIntent = signaled.length > 0 && !liveIntent;

    if (liveIntent || (order.pendingAmount > 0n && signaled.length === 0)) {
      throw errors.activeIntentBlocksWithdrawal(depositId);
    }
    if (availableAmount(order) <= 0n && order.pendingAmount === 0n) {
      throw errors.nothingToWithdraw(depositId);
    }

    return { expiredIntent, ...escrowContext(depositId) };
  }

  /**
   * State gate for partial withdrawal: only the unlocked balance is
   * withdrawable, but a live buyer intent does not block it.
   */
  async function partialWithdrawContext(
    depositId: string,
    amount: bigint,
  ): Promise<{ onchainDepositId: bigint; escrowArg: { escrowAddress?: Address } }> {
    if (amount <= 0n) throw errors.amountBelowMinimum(amount, 1n);
    const order = await fetchOrder(depositId);
    const available = availableAmount(order);
    if (amount > available) {
      throw errors.insufficientAvailableFunds(depositId, amount, available);
    }
    return escrowContext(depositId);
  }

  /** State gate for top-ups: the order must still be live. */
  async function topUpContext(
    depositId: string,
    amount: bigint,
  ): Promise<{ onchainDepositId: bigint; escrowArg: { escrowAddress?: Address } }> {
    if (amount < MIN_CASHOUT_AMOUNT) throw errors.amountBelowMinimum(amount, MIN_CASHOUT_AMOUNT);
    const order = await fetchOrder(depositId);
    if (!order.isInFlight) throw errors.orderNotActive(depositId);
    return escrowContext(depositId);
  }

  function capabilities(): CashCapabilities;
  function capabilities(capabilityOptions: {
    includeRelaySources: true;
    includeNearIntentsSources?: true;
  }): Promise<CashCapabilities>;
  function capabilities(capabilityOptions: {
    includeRelaySources?: true;
    includeNearIntentsSources: true;
  }): Promise<CashCapabilities>;
  function capabilities(capabilityOptions?: {
    includeRelaySources?: true;
    includeNearIntentsSources?: true;
  }): CashCapabilities | Promise<CashCapabilities> {
    const baseCapabilities = buildCapabilities(environment);
    if (!capabilityOptions?.includeRelaySources && !capabilityOptions?.includeNearIntentsSources) {
      return baseCapabilities;
    }
    return Promise.all([
      capabilityOptions.includeRelaySources
        ? readRelaySourceCapabilities(options.relay)
        : Promise.resolve(undefined),
      capabilityOptions.includeNearIntentsSources
        ? readNearIntentsSourceCapabilities(options.nearIntents)
        : Promise.resolve(undefined),
    ]).then(([relay, nearIntents]) => ({
      ...baseCapabilities,
      source: {
        ...baseCapabilities.source,
        ...(relay ? { relay } : {}),
        ...(nearIntents ? { nearIntents } : {}),
      },
    }));
  }

  /**
   * Ensure the escrow can pull the deposit amount, and make the allowance
   * durable before returning: `ensureAllowance` sends the approve without
   * waiting for it to mine, and load-balanced RPC replicas can serve stale
   * `eth_call` state even after the receipt lands - so wait for the receipt,
   * then poll until the allowance is visible on the read path.
   */
  async function settleAllowance(
    client: Zkp2pClient,
    token: Address,
    owner: Address,
    escrow: Address,
    amount: bigint,
  ): Promise<void> {
    let allowance: { hadAllowance: boolean; hash?: Hash };
    try {
      allowance = await client.ensureAllowance({
        token,
        amount,
        spender: escrow,
        txOverrides: attribution,
      });
    } catch (err) {
      throw mapChainError('approve', err, { requiredAmount: amount });
    }
    if (allowance.hadAllowance || !allowance.hash) return;

    let receipt;
    try {
      receipt = await client.publicClient.waitForTransactionReceipt({ hash: allowance.hash });
    } catch (err) {
      throw errors.transactionStatusUnknown(allowance.hash, err, 'approve');
    }
    if (receipt.status === 'reverted') throw errors.transactionFailed(allowance.hash);

    let lastReadError: unknown;
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        const visible = (await client.publicClient.readContract({
          address: token,
          abi: ERC20_ALLOWANCE_ABI,
          functionName: 'allowance',
          args: [owner, escrow],
        })) as bigint;
        if (visible >= amount) return;
      } catch (err) {
        lastReadError = err;
      }
      await sleep(1_000);
    }
    // The approve mined but the allowance never surfaced on the read path -
    // surface it as retryable rather than blindly submitting a doomed deposit.
    throw errors.allowanceNotVisible(amount, lastReadError);
  }

  async function waitForBaseSignerAfterRelay(
    client: Zkp2pClient,
    cashoutSigner: WalletClient,
    sourceSigner: WalletClient,
    owner: Address,
    sourceChainId: number,
    executed: RelayExecutionResult,
  ): Promise<void> {
    if (sourceChainId !== BASE_CHAIN_ID) return;

    const baseTransactions = (executed.transactions?.origin ?? []).filter(
      (transaction) => transaction.chainId === BASE_CHAIN_ID,
    );
    const batchIds = baseTransactions
      .filter((transaction) => transaction.isBatchTx === true)
      .map((transaction) => transaction.hash);
    const batchExecutionFailed = (cause: unknown) =>
      errors.sourceExecutionFailed(cause, {
        ...(executed.requestId ? { requestId: executed.requestId } : {}),
        txHashes: executed.txHashes,
        ...(executed.transactions ? { transactions: executed.transactions } : {}),
      });
    let batchTransactionHashes: Hash[] = [];
    if (batchIds.length > 0) {
      let batchError: unknown;
      let batchesComplete = false;
      let batchesSucceededWithoutReceipts = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const statuses = await Promise.all(
            batchIds.map((id) => sourceSigner.getCallsStatus({ id })),
          );
          if (statuses.some((status) => status.status === 'failure')) {
            throw batchExecutionFailed(new Error('Relay wallet call bundle failed'));
          }
          if (statuses.every((status) => status.status === 'success')) {
            const receiptGroups = statuses.map((status) => status.receipts ?? []);
            if (receiptGroups.some((receipts) => receipts.length === 0)) {
              batchError = new Error(
                'Relay wallet call bundle did not include transaction receipts',
              );
              batchesSucceededWithoutReceipts = true;
              break;
            } else {
              batchTransactionHashes = receiptGroups.flatMap((receipts) =>
                receipts.map((receipt) => receipt.transactionHash),
              );
              batchesComplete = true;
              break;
            }
          }
        } catch (err) {
          if (isCashError(err)) throw err;
          batchError = err;
        }
        await sleep(250);
      }
      if (!batchesComplete) {
        if (batchesSucceededWithoutReceipts) throw batchError;
        throw batchExecutionFailed(
          batchError ?? new Error('Relay wallet call bundle did not complete'),
        );
      }
    }

    const hashes = [
      ...baseTransactions
        .filter((transaction) => transaction.isBatchTx !== true)
        .map((transaction) => transaction.hash as Hash),
      ...batchTransactionHashes,
    ];
    if (hashes.length === 0) return;

    let transactions: Awaited<ReturnType<typeof client.publicClient.getTransaction>>[] | undefined;
    let lastLookupError: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        transactions = await Promise.all(
          hashes.map((hash) => client.publicClient.getTransaction({ hash })),
        );
        break;
      } catch (err) {
        lastLookupError = err;
        await sleep(250);
      }
    }
    if (!transactions) throw lastLookupError;

    const ownerNonces = transactions
      .filter((transaction) => transaction.from.toLowerCase() === owner.toLowerCase())
      .map((transaction) => transaction.nonce);
    if (ownerNonces.length === 0) return;

    const afterRelay = Math.max(...ownerNonces) + 1;
    let lastNonceError: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const pendingHex = (await cashoutSigner.transport.request({
          method: 'eth_getTransactionCount',
          params: [owner, 'pending'],
        })) as Hex;
        if (Number(BigInt(pendingHex)) >= afterRelay) return;
      } catch (err) {
        lastNonceError = err;
      }
      await sleep(250);
    }
    if (lastNonceError) throw lastNonceError;
    throw new Error(`Signer provider did not observe Relay nonce ${afterRelay - 1}`);
  }

  function prepareCashoutAccess(
    depositId: string,
    paymentMethod: Hex,
    client: Zkp2pClient = readClient,
    source?: CashoutResult['source'],
  ): PreparedTransaction {
    const { compositeId, escrowAddress, onchainDepositId } = parseDepositId(depositId);
    const groupIds = CASH_ACCESS_GROUP_IDS[environment];
    try {
      const prepared = client.accessPolicy.prepareConfigureDeposit({
        escrow: escrowAddress as Address,
        depositId: onchainDepositId,
        paymentMethod,
        enabled: true,
        groupIds,
        takers: [],
        txOverrides: attribution,
      });
      return {
        to: prepared.to,
        data: prepared.data,
        value: prepared.value,
        chainId: prepared.chainId,
      };
    } catch (err) {
      throw errors.accessPolicyConfigurationFailed(compositeId, groupIds, {
        cause: err,
        paymentMethod,
        ...(source ? { source } : {}),
      });
    }
  }

  async function configureCashoutAccess(
    client: Zkp2pClient,
    signer: WalletClient,
    depositInput: CashDepositInput,
    depositId: string,
    source?: CashoutResult['source'],
  ): Promise<Hash[]> {
    const groupIds = CASH_ACCESS_GROUP_IDS[environment];
    const paymentMethods = cashoutAccessPolicyPaymentMethods(depositInput, environment);
    const hashes: Hash[] = [];

    for (const paymentMethod of paymentMethods) {
      const prepared = prepareCashoutAccess(depositId, paymentMethod, client, source);

      let hash: Hash;
      try {
        hash = await signer.sendTransaction({
          account: signer.account!,
          chain: signer.chain,
          to: prepared.to,
          data: prepared.data,
          value: prepared.value,
        });
      } catch (err) {
        throw errors.accessPolicyConfigurationFailed(depositId, groupIds, {
          cause: err,
          paymentMethod,
          ...(source ? { source } : {}),
        });
      }

      let receipt;
      try {
        receipt = await client.publicClient.waitForTransactionReceipt({ hash });
      } catch (err) {
        throw errors.accessPolicyConfigurationFailed(depositId, groupIds, {
          cause: err,
          paymentMethod,
          transactionHash: hash,
          ...(source ? { source } : {}),
        });
      }
      if (receipt.status === 'reverted') {
        throw errors.accessPolicyConfigurationFailed(depositId, groupIds, {
          cause: errors.transactionFailed(hash),
          paymentMethod,
          transactionHash: hash,
          ...(source ? { source } : {}),
        });
      }
      hashes.push(hash);
    }
    return hashes;
  }

  return {
    capabilities,

    async sourceCapabilities(): Promise<CashSourceCapabilities> {
      return readRelaySourceCapabilities(options.relay);
    },

    async quoteSource(input: RelayQuoteInput): Promise<RelayQuote> {
      return quoteRelayToBaseUsdc(input, options.relay);
    },

    async executeSourceQuote(
      quote: RelayQuote | Execute,
      opts: {
        signer: WalletClient;
        recipient?: string;
        onProgress?: (data: ProgressData) => void;
        disableCapabilitiesCheck?: boolean;
      },
    ): Promise<RelayExecutionResult> {
      if (!opts.signer.account) throw errors.signerRequired('executeSourceQuote');
      return executeRelayQuote(quote, opts.signer, {
        ...(options.relay ? { relay: options.relay } : {}),
        ...(opts.recipient ? { recipient: opts.recipient } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        ...(opts.disableCapabilitiesCheck !== undefined
          ? { disableCapabilitiesCheck: opts.disableCapabilitiesCheck }
          : {}),
      });
    },

    async relayStatus(requestId: string): Promise<RelayStatus> {
      return readRelayStatus(requestId, options.relay);
    },

    async nearIntentsCapabilities(): Promise<NearIntentsSourceCapabilities> {
      return readNearIntentsSourceCapabilities(options.nearIntents);
    },

    async quoteNearIntentsSource(input: NearIntentsQuoteInput): Promise<NearIntentsQuote> {
      return createNearIntentsClient(options.nearIntents).quoteToBaseUsdc(input);
    },

    async submitNearIntentsDeposit(input: NearIntentsDepositInput): Promise<NearIntentsStatus> {
      return createNearIntentsClient(options.nearIntents).submitDeposit(input);
    },

    async nearIntentsStatus(input: NearIntentsStatusInput): Promise<NearIntentsStatus> {
      return createNearIntentsClient(options.nearIntents).status(input);
    },

    async estimate(input: EstimateInput, estimateOptions?: EstimateOptions): Promise<CashEstimate> {
      return readEstimate(readClient.publicClient, input, {
        environment,
        ...(estimateOptions?.includeEta !== undefined
          ? { includeEta: estimateOptions.includeEta }
          : {}),
        etaReader: async (etaInput) => fillEtaFromSample(await getFillStatsSample(), etaInput),
        creationRateClient,
        ...(options.relay ? { relay: options.relay } : {}),
      });
    },

    async fillStats(): Promise<CashFillStats> {
      try {
        return (await getFillStatsSample()).stats;
      } catch (err) {
        throw errors.indexerUnavailable('fill stats', err);
      }
    },

    async cashout(input: CashoutInput, opts: CashoutOptions): Promise<CashoutResult> {
      const payoutInput = validatePayout(input);
      const client = await signingClient('cashout', opts);
      const owner = opts.signer.account!.address;

      if (input.source) {
        const sourceSigner =
          opts.sourceSigner ?? (input.source.chainId === BASE_CHAIN_ID ? opts.signer : undefined);
        if (!sourceSigner?.account) throw errors.signerRequired('source cashout');
        await assertWalletChainId(sourceSigner, input.source.chainId, 'source cashout');
        if (
          input.source.recipient !== undefined &&
          input.source.recipient.toLowerCase() !== owner.toLowerCase()
        ) {
          throw errors.sourceRecipientMismatch(input.source.recipient, owner);
        }
        const relayQuote = await quoteRelayToBaseUsdc(
          {
            user: sourceSigner.account.address,
            amount: input.amount,
            source: { chainId: input.source.chainId, currency: input.source.currency },
            recipient: owner,
            ...(input.source.tradeType ? { tradeType: input.source.tradeType } : {}),
          },
          options.relay,
        );
        if (relayQuote.outputAmount < MIN_CASHOUT_AMOUNT) {
          throw errors.amountBelowMinimum(relayQuote.outputAmount, MIN_CASHOUT_AMOUNT);
        }
        const cashoutAmount = relayQuote.outputAmount;
        const depositInput = validateDepositInput(cashoutAmount, input, payoutInput);
        let params = await buildDepositParams(client, depositInput);

        // Spender must be the escrow createDeposit will target - the default can
        // point at the legacy escrow while deposits go to EscrowV2.
        const escrow = client.escrowV2Address ?? client.escrowAddress;
        await settleAllowance(client, params.token, owner, escrow, depositInput.amount);

        const executed = await executeRelayQuote(relayQuote.raw, sourceSigner, {
          ...(options.relay ? { relay: options.relay } : {}),
          recipient: owner,
          ...(opts.onSourceProgress ? { onProgress: opts.onSourceProgress } : {}),
          ...(opts.disableSourceCapabilitiesCheck !== undefined
            ? { disableCapabilitiesCheck: opts.disableSourceCapabilitiesCheck }
            : {}),
        });
        const routedSource: NonNullable<CashoutResult['source']> = {
          amount: cashoutAmount,
          ...(executed.requestId ? { requestId: executed.requestId } : {}),
          txHashes: executed.txHashes,
          ...(executed.transactions ? { transactions: executed.transactions } : {}),
        };
        try {
          await waitForBaseSignerAfterRelay(
            client,
            opts.signer,
            sourceSigner,
            owner,
            input.source.chainId,
            executed,
          );
        } catch (err) {
          if (isCashError(err)) throw err;
          throw errors.sourceRouteCompletedCashoutFailed(
            routedSource,
            mapChainError('resolve same-chain Relay nonce', err),
          );
        }

        // Relay can take long enough that a preflight snapshot no longer
        // represents deposit creation. Refresh fixed-at-creation corridors
        // after Base funds arrive and preserve source-route recovery context.
        if (hasCreationRateCorridor(depositInput)) {
          try {
            params = await buildDepositParams(client, depositInput);
          } catch (err) {
            throw errors.sourceRouteCompletedCashoutFailed(routedSource, err);
          }
        }
        const attributedParams = { ...params, txOverrides: attribution };
        // Submit the deposit; one retry for the replica-lag case the allowance
        // visibility loop cannot fully rule out. All other failures map to typed
        // errors and a reverted receipt throws - no raw errors, no false success.
        const send = async (): Promise<`0x${string}`> => {
          try {
            return (await client.createDeposit(attributedParams)).hash;
          } catch (err) {
            if (err instanceof Error && /exceeds allowance/i.test(err.message)) {
              await sleep(2_000);
              return (await client.createDeposit(attributedParams)).hash;
            }
            throw err;
          }
        };

        let hash: Hash;
        try {
          hash = (await send()) as Hash;
        } catch (err) {
          const mapped = mapChainError('createDeposit', err, {
            requiredAmount: depositInput.amount,
          });
          if (isKnownPreBroadcastFailure(mapped)) {
            throw errors.sourceRouteCompletedCashoutFailed(routedSource, mapped);
          }
          throw errors.sourceCashoutSubmissionUnknown(routedSource, owner, mapped);
        }
        let receipt;
        try {
          receipt = await client.publicClient.waitForTransactionReceipt({ hash });
        } catch (err) {
          throw errors.sourceCashoutStatusUnknown(routedSource, hash, err);
        }
        if (receipt.status === 'reverted') {
          throw errors.sourceRouteCompletedCashoutFailed(
            routedSource,
            errors.transactionFailed(hash),
          );
        }

        const abi = client.escrowV2Abi ?? client.escrowAbi;
        const resolved = resolveCashDepositId({ logs: receipt.logs, abi });
        if (!resolved) throw errors.depositResolutionFailed(hash);
        const accessPolicyTxHashes = await configureCashoutAccess(
          client,
          opts.signer,
          depositInput,
          resolved.compositeId,
          routedSource,
        );
        const order = deriveCashOrder(resolved.compositeId, [], {
          remainingAmount: depositInput.amount,
          status: 'ACTIVE',
        });

        return {
          depositId: resolved.compositeId,
          txHash: hash,
          escrowAddress: resolved.escrowAddress,
          onchainDepositId: resolved.onchainDepositId,
          order,
          ...(accessPolicyTxHashes.length > 0
            ? {
                accessPolicyTxHash: accessPolicyTxHashes.at(-1)!,
                accessPolicyTxHashes,
              }
            : {}),
          source: routedSource,
        };
      }

      const depositInput = validateDepositInput(input.amount, input, payoutInput);
      const params = await buildDepositParams(client, depositInput);

      // Spender must be the escrow createDeposit will target - the default can
      // point at the legacy escrow while deposits go to EscrowV2.
      const escrow = client.escrowV2Address ?? client.escrowAddress;
      await settleAllowance(client, params.token, owner, escrow, depositInput.amount);

      const attributedParams = { ...params, txOverrides: attribution };
      // Submit the deposit; one retry for the replica-lag case the allowance
      // visibility loop cannot fully rule out. All other failures map to typed
      // errors and a reverted receipt throws - no raw errors, no false success.
      const send = async (): Promise<`0x${string}`> => {
        try {
          return (await client.createDeposit(attributedParams)).hash;
        } catch (err) {
          if (err instanceof Error && /exceeds allowance/i.test(err.message)) {
            await sleep(2_000);
            return (await client.createDeposit(attributedParams)).hash;
          }
          throw err;
        }
      };

      let hash: Hash;
      try {
        hash = (await send()) as Hash;
      } catch (err) {
        const mapped = mapChainError('createDeposit', err, {
          requiredAmount: depositInput.amount,
        });
        if (isKnownPreBroadcastFailure(mapped)) throw mapped;
        throw errors.transactionSubmissionUnknown('cashout', err, {
          kind: 'inspect-base-cashout-submission',
          amount: depositInput.amount.toString(),
          depositor: owner,
          txHashes: [],
        });
      }
      let receipt;
      try {
        receipt = await client.publicClient.waitForTransactionReceipt({ hash });
      } catch (err) {
        throw errors.transactionStatusUnknown(hash, err, 'cashout');
      }
      if (receipt.status === 'reverted') throw errors.transactionFailed(hash);

      const abi = client.escrowV2Abi ?? client.escrowAbi;
      const resolved = resolveCashDepositId({ logs: receipt.logs, abi });
      if (!resolved) throw errors.depositResolutionFailed(hash);
      const accessPolicyTxHashes = await configureCashoutAccess(
        client,
        opts.signer,
        depositInput,
        resolved.compositeId,
      );
      const order = deriveCashOrder(resolved.compositeId, [], {
        remainingAmount: depositInput.amount,
        status: 'ACTIVE',
      });

      return {
        depositId: resolved.compositeId,
        txHash: hash,
        escrowAddress: resolved.escrowAddress,
        onchainDepositId: resolved.onchainDepositId,
        order,
        ...(accessPolicyTxHashes.length > 0
          ? {
              accessPolicyTxHash: accessPolicyTxHashes.at(-1)!,
              accessPolicyTxHashes,
            }
          : {}),
      };
    },

    async prepare(input: CashoutInput): Promise<PrepareResult> {
      if (input.source) throw errors.sourceRouteUnsupportedInPrepare();
      const depositInput = validateDepositInput(input.amount, input);
      const params = await buildDepositParams(readClient, depositInput);

      const { prepared } = await readClient.prepareCreateDeposit({
        ...params,
        txOverrides: attribution,
      });

      const approve: PreparedTransaction = {
        to: params.token,
        data: appendAttributionToCalldata(
          encodeFunctionData({
            abi: ERC20_APPROVE_ABI,
            functionName: 'approve',
            args: [prepared.to as Address, depositInput.amount],
          }),
          referrerCodes,
        ),
        value: 0n,
        chainId: BASE_CHAIN_ID,
      };

      const hashedOnchainIds = (params.paymentMethodDataOverride ?? []).map((d) => d.payeeDetails);

      const accessPolicyPaymentMethods = cashoutAccessPolicyPaymentMethods(
        depositInput,
        environment,
      );

      return {
        txs: [approve, prepared],
        steps: [
          {
            kind: 'approve',
            description: 'Approve Base USDC for the Peer Cash escrow.',
          },
          {
            kind: 'createDeposit',
            description: 'Create the protocol-held cash-out order.',
          },
        ],
        register: { hashedOnchainIds },
        accessPolicyRequired: accessPolicyPaymentMethods.length > 0,
        accessPolicyPaymentMethods,
      };
    },

    finalizePreparedCashout(receipt: PreparedCashoutReceipt): CashoutResult {
      if (receipt.status === 'reverted') {
        throw errors.transactionFailed(receipt.transactionHash);
      }

      const abi = readClient.escrowV2Abi ?? readClient.escrowAbi;
      const expectedEscrowAddress = readClient.escrowV2Address ?? readClient.escrowAddress;
      const resolved = resolveCashDepositId({
        logs: receipt.logs,
        abi,
        expectedEscrowAddress,
        expectedToken: BASE_USDC_ADDRESS,
      });
      if (!resolved || resolved.amount === undefined) {
        throw errors.depositResolutionFailed(receipt.transactionHash);
      }

      return {
        depositId: resolved.compositeId,
        txHash: receipt.transactionHash,
        escrowAddress: resolved.escrowAddress,
        onchainDepositId: resolved.onchainDepositId,
        order: deriveCashOrder(resolved.compositeId, [], {
          remainingAmount: resolved.amount,
          status: 'ACTIVE',
        }),
      };
    },

    prepareAccessPolicy(depositId: string, paymentMethod: Hex) {
      return prepareCashoutAccess(depositId, paymentMethod);
    },

    async order(depositId: string): Promise<CashOrder> {
      return fetchOrder(depositId);
    },

    async buyer(address: string): Promise<CashBuyerProfile> {
      let intents;
      try {
        intents = await readClient.indexer.getOwnerIntents(address, CASH_ORDER_STATUSES);
      } catch (err) {
        throw errors.indexerUnavailable('buyer profile', err);
      }
      return deriveBuyerProfile(address, intents);
    },

    async orders(owner: string, opts: OrdersOptions = {}): Promise<CashOrder[]> {
      const { inFlight = false, limit = 100 } = opts;
      let deposits;
      try {
        deposits = await readClient.indexer.getDepositsWithRelations(
          { depositor: owner },
          { limit },
        );
      } catch (err) {
        throw errors.indexerUnavailable('orders', err);
      }
      const catalog = getPaymentMethodsCatalog(BASE_CHAIN_ID, environment);

      let attributedCashDeposits = new Set<string>();
      const fixedRateCandidates = deposits.filter((deposit) => {
        const payouts = derivePayouts(
          deposit.paymentMethods ?? [],
          deposit.currencies ?? [],
          catalog,
        );
        return (
          !isCashPayoutSet(payouts) && payouts.some((payout) => payout.pricing.fixedAtCreation)
        );
      });
      if (fixedRateCandidates.length > 0) {
        try {
          attributedCashDeposits = await readCashAttribution(
            fixedRateCandidates.map((deposit) => deposit.id),
          );
        } catch (err) {
          throw errors.indexerUnavailable('cash attribution', err);
        }
      }

      const derived = deposits
        .flatMap((deposit) => {
          if (deposit.token.toLowerCase() !== BASE_USDC_ADDRESS.toLowerCase()) return [];
          const payouts = derivePayouts(
            deposit.paymentMethods ?? [],
            deposit.currencies ?? [],
            catalog,
          );
          if (!isCashPayoutSet(payouts, attributedCashDeposits.has(deposit.id.toLowerCase()))) {
            return [];
          }
          return [
            deriveCashOrder(deposit.id, [], {
              ...depositOrderOptions(deposit),
              payouts,
              // List rows carry no intent detail - a positive outstanding
              // amount is treated conservatively as a live lock.
              fillsIncluded: false,
            }),
          ];
        })
        // Drop dust/empty deposits that never represented a real cash-out.
        .filter((o) => o.totalAmount >= MIN_CASHOUT_AMOUNT)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

      return inFlight ? derived.filter((o) => o.isInFlight) : derived;
    },

    async *watch(
      depositId: string,
      opts: WatchOptions = {},
    ): AsyncGenerator<CashOrder, void, void> {
      const { signal, pollIntervalMs = 5_000, timeoutMs } = opts;
      const startedAt = Date.now();
      let lastFingerprint: string | undefined;

      while (true) {
        if (signal?.aborted) return;
        if (timeoutMs !== undefined && Date.now() - startedAt >= timeoutMs) {
          throw errors.watchTimeout(depositId, timeoutMs);
        }

        let order: CashOrder | null = null;
        try {
          order = await fetchOrder(depositId);
        } catch (err) {
          // Right after cashout the indexer may not have the deposit yet - keep polling.
          if (!(isCashError(err) && err.code === 'ORDER_NOT_FOUND')) throw err;
        }

        if (order) {
          const fingerprint = orderFingerprint(order);
          if (fingerprint !== lastFingerprint) {
            lastFingerprint = fingerprint;
            yield order;
          }
          if (!order.isInFlight) return;
        }

        await sleep(pollIntervalMs, signal);
      }
    },

    async withdraw(depositId: string, opts: WithdrawOptions): Promise<WithdrawResult> {
      const client = await signingClient('withdraw', opts);

      if (opts.amount !== undefined) {
        const { onchainDepositId, escrowArg } = await partialWithdrawContext(
          depositId,
          opts.amount,
        );
        const withdrawTxHash = await submitAndConfirm(client, 'removeFunds', () =>
          client.removeFunds({
            depositId: onchainDepositId,
            amount: opts.amount!,
            ...escrowArg,
            txOverrides: attribution,
          }),
        );
        return { depositId, withdrawTxHash };
      }

      const { expiredIntent, onchainDepositId, escrowArg } = await withdrawContext(depositId);

      let pruneTxHash: Hash | undefined;
      if (expiredIntent) {
        // Free the expired intent's locked amount back to the deposit first -
        // withdrawDeposit reverts while any intent is still recorded as active.
        pruneTxHash = await submitAndConfirm(client, 'pruneExpiredIntents', () =>
          client.pruneExpiredIntents({
            depositId: onchainDepositId,
            ...escrowArg,
            txOverrides: attribution,
          }),
        );
      }

      const withdrawTxHash = await submitAndConfirm(client, 'withdrawDeposit', () =>
        client.withdrawDeposit({
          depositId: onchainDepositId,
          ...escrowArg,
          txOverrides: attribution,
        }),
      );

      return {
        depositId,
        ...(pruneTxHash !== undefined ? { pruneTxHash } : {}),
        withdrawTxHash,
      };
    },

    async prepareWithdraw(
      depositId: string,
      opts: { amount?: bigint } = {},
    ): Promise<{ txs: PreparedTransaction[]; steps: CashPreparedStep[] }> {
      if (opts.amount !== undefined) {
        const { onchainDepositId, escrowArg } = await partialWithdrawContext(
          depositId,
          opts.amount,
        );
        const tx = await readClient.removeFunds.prepare({
          depositId: onchainDepositId,
          amount: opts.amount,
          ...escrowArg,
          txOverrides: attribution,
        });
        return {
          txs: [tx],
          steps: [
            {
              kind: 'removeFunds',
              description: 'Withdraw the requested unlocked USDC amount.',
            },
          ],
        };
      }

      const { expiredIntent, onchainDepositId, escrowArg } = await withdrawContext(depositId);

      const txs: PreparedTransaction[] = [];
      const steps: CashPreparedStep[] = [];
      if (expiredIntent) {
        txs.push(
          await readClient.pruneExpiredIntents.prepare({
            depositId: onchainDepositId,
            ...escrowArg,
            txOverrides: attribution,
          }),
        );
        steps.push({
          kind: 'pruneExpiredIntents',
          description: 'Prune expired buyer intents so the locked amount becomes withdrawable.',
        });
      }
      txs.push(
        await readClient.withdrawDeposit.prepare({
          depositId: onchainDepositId,
          ...escrowArg,
          txOverrides: attribution,
        }),
      );
      steps.push({
        kind: 'withdrawDeposit',
        description: 'Close the order and withdraw all remaining USDC.',
      });
      return { txs, steps };
    },

    async topUp(depositId: string, amount: bigint, opts: SignerOptions): Promise<TopUpResult> {
      const client = await signingClient('topUp', opts);
      const { onchainDepositId, escrowArg } = await topUpContext(depositId, amount);

      // Cash deposits are always Base USDC (enforced at creation); the escrow
      // pulling the top-up is the one the composite id points at.
      const owner = opts.signer.account!.address;
      const escrow = (escrowArg.escrowAddress ??
        client.escrowV2Address ??
        client.escrowAddress) as Address;
      await settleAllowance(client, BASE_USDC_ADDRESS as Address, owner, escrow, amount);

      const txHash = await submitAndConfirm(client, 'addFunds', () =>
        client.addFunds({
          depositId: onchainDepositId,
          amount,
          ...escrowArg,
          txOverrides: attribution,
        }),
      );

      return { depositId, txHash };
    },

    async prepareTopUp(
      depositId: string,
      amount: bigint,
    ): Promise<{ txs: PreparedTransaction[]; steps: CashPreparedStep[] }> {
      const { onchainDepositId, escrowArg } = await topUpContext(depositId, amount);

      const prepared = await readClient.addFunds.prepare({
        depositId: onchainDepositId,
        amount,
        ...escrowArg,
        txOverrides: attribution,
      });

      const approve: PreparedTransaction = {
        to: BASE_USDC_ADDRESS as Address,
        data: appendAttributionToCalldata(
          encodeFunctionData({
            abi: ERC20_APPROVE_ABI,
            functionName: 'approve',
            args: [prepared.to as Address, amount],
          }),
          referrerCodes,
        ),
        value: 0n,
        chainId: BASE_CHAIN_ID,
      };

      return {
        txs: [approve, prepared],
        steps: [
          {
            kind: 'approve',
            description: 'Approve additional Base USDC for the Peer Cash escrow.',
          },
          {
            kind: 'addFunds',
            description: 'Add USDC to the live cash-out order.',
          },
        ],
      };
    },
  };
}

export { CashError, isCashError, errors };
