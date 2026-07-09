/**
 * `createCashClient` - the eight-verb facade over a read-only `Zkp2pClient`.
 *
 * The facade keeps the outward surface tiny (capabilities / estimate / cashout
 * / order / orders / watch / withdraw / topUp) while reusing the published
 * SDK's battle-tested internals. A React app, a Node service, and an AI agent
 * are equal consumers: every mutating verb has an unsigned `prepare` path,
 * every wire type is serializable, and every transaction carries ERC-8021
 * attribution ({@link CASH_ATTRIBUTION_CODE}).
 */
import {
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Hash,
  type Transport,
  type WalletClient,
} from 'viem';
import { base } from 'viem/chains';
import { Zkp2pClient, getPaymentMethodsCatalog, appendAttributionToCalldata } from '@zkp2p/sdk';
import type {
  CurrencyType,
  CuratorPayeeDataInput,
  PreparedTransaction,
  RuntimeEnv,
  TxOverrides,
} from '../sdk-types';
import { BASE_CHAIN_ID, BASE_USDC_ADDRESS, CASH_ORDER_STATUSES } from '../engine/constants';
import { isMarketRateSupported, prepareCashDepositParams } from '../engine/marketRate';
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
import { readEstimate, type CashEstimate, type EstimateInput } from './estimate';
import { CashError, errors, isCashError, mapChainError } from './errors';
import {
  readRelaySourceCapabilities,
  readRelayStatus,
  quoteRelayToBaseUsdc,
  executeRelayQuote,
  type CashSourceCapabilities,
  type RelayOptions,
  type RelayExecutionResult,
  type RelayQuote,
  type RelayQuoteInput,
  type RelaySourceInput,
  type RelayStatus,
} from './relay';
import type { Execute, ProgressData } from '@relayprotocol/relay-sdk';

const DEFAULT_RPC_URL = 'https://mainnet.base.org';

/**
 * ERC-8021 attribution code stamped on every transaction this package
 * produces (signed and prepare paths, including approves). Integrator codes
 * from `CashClientOptions.referrer` are appended after it; the SDK always
 * appends the Base builder code last.
 */
export const CASH_ATTRIBUTION_CODE = 'peer-cash';

/**
 * The SDK selects the indexer from `runtimeEnv` but defaults the curator to
 * production; staging has its own curator deployment (same convention as the
 * first-party clients).
 */
const DEFAULT_CURATOR_URLS: Partial<Record<RuntimeEnv, string>> = {
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
  /** Curator (ZKP2P API) URL override. */
  curatorUrl?: string;
  /** Optional ZKP2P API key. */
  apiKey?: string;
  /** Relay API configuration for source assets outside Base USDC. */
  relay?: RelayOptions;
  /**
   * Your own ERC-8021 attribution code(s), appended after
   * {@link CASH_ATTRIBUTION_CODE} on every transaction (e.g. `'acme-app'`).
   */
  referrer?: string | string[];
}

/** One payout leg: platform + currency + payee handle. */
export interface CashLeg {
  /** Platform id from `capabilities()`, e.g. `'venmo'`. */
  platform: string;
  /** Fiat currency to receive. */
  currency: CurrencyType;
  /** Payee details, e.g. `{ offchainId: '@andrew' }`. */
  payee: CuratorPayeeDataInput;
}

export interface CashoutInput {
  /**
   * Amount to cash out. Defaults to Base USDC base units. When `source` is set,
   * this is source-token base units and Relay routes it into Base USDC first.
   */
  amount: bigint;
  /** Optional Relay source asset. Omit for the Base USDC default path. */
  source?: RelaySourceInput & {
    /** Base recipient for bridged USDC; defaults to the signer address. */
    recipient?: string;
    tradeType?: 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'EXPECTED_OUTPUT';
  };
  /** Where the fiat should arrive. Multi-payout is a deliberate v1 cut. */
  receive: CashLeg;
  /** Per-order min/max override (USDC base units). */
  intentAmountRange?: { min: bigint; max: bigint };
}

export interface SignerOptions {
  /** A viem WalletClient with an account, on Base. */
  signer: WalletClient;
}

export interface CashoutOptions extends SignerOptions {
  /** Optional source-chain signer for Relay. Defaults to `signer`. */
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
  /** Present when `cashout()` first routed a source asset through Relay. */
  source?: { amount: bigint; requestId?: string; txHashes: string[] };
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
  /** 0b - Discovery with live Relay-supported source chains/tokens. */
  capabilities(options: { includeRelaySources: true }): Promise<CashCapabilities>;
  /** Relay-only source discovery helper. */
  sourceCapabilities(): Promise<CashSourceCapabilities>;
  /** Quote any Relay-supported source asset into Base USDC. */
  quoteSource(input: RelayQuoteInput): Promise<RelayQuote>;
  /** Execute a Relay SDK quote into Base USDC before starting the Peer Cash order. */
  executeSourceQuote(
    quote: Execute,
    opts: SignerOptions & {
      onProgress?: (data: ProgressData) => void;
      disableCapabilitiesCheck?: boolean;
    },
  ): Promise<RelayExecutionResult>;
  /** Track Relay execution status by quote/request id. */
  relayStatus(requestId: string): Promise<RelayStatus>;
  /** 1 - Estimate: currency + amount only. No payee, no side effects, no expiry. */
  estimate(input: EstimateInput): Promise<CashEstimate>;
  /** 2 - Cash out: payee registration + deposit params + submission happen here. */
  cashout(input: CashoutInput, opts: CashoutOptions): Promise<CashoutResult>;
  /** 2b - Unsigned path: `txs[]` for agent wallets, AA, server keys, policy layers. */
  prepare(input: CashoutInput): Promise<PrepareResult>;
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
    throw mapChainError(verb, err);
  }
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === 'reverted') throw errors.transactionFailed(hash);
  return hash;
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

  // ERC-8021: 'peer-cash' first, then integrator codes; the SDK appends the
  // Base builder code last. Applied to every mutating call on both paths.
  const referrerCodes = [
    CASH_ATTRIBUTION_CODE,
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
      ...((options.curatorUrl ?? DEFAULT_CURATOR_URLS[environment])
        ? { baseApiUrl: options.curatorUrl ?? DEFAULT_CURATOR_URLS[environment] }
        : {}),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    });
  }

  // Read-only client - indexer, curator registration, oracle reads.
  const readClient = buildSdkClient(createWalletClient({ chain: base, transport }));

  // Signing clients are built lazily and cached per WalletClient identity.
  const signingClients = new WeakMap<WalletClient, Zkp2pClient>();
  function signingClient(verb: string, opts?: SignerOptions): Zkp2pClient {
    const signer = opts?.signer;
    if (!signer?.account) throw errors.signerRequired(verb);
    let client = signingClients.get(signer);
    if (!client) {
      client = buildSdkClient(signer);
      signingClients.set(signer, client);
    }
    return client;
  }

  function validateInput(input: CashoutInput): CashDepositInput {
    const { amount, receive } = input;
    if (amount < MIN_CASHOUT_AMOUNT) throw errors.amountBelowMinimum(amount, MIN_CASHOUT_AMOUNT);
    const catalog = getPaymentMethodsCatalog(BASE_CHAIN_ID, environment);
    if (!catalog[receive.platform]) throw errors.unsupportedPlatform(receive.platform);
    if (!isMarketRateSupported(receive.currency)) {
      throw errors.oracleUnsupportedCurrency(receive.currency);
    }
    // Wise/PayPal require a signed maker identity attestation the SDK can't
    // mint. Reject early unless the caller supplied one on the payee.
    if (
      platformRequiresIdentityAttestation(receive.platform) &&
      !(receive.payee as { identityAttestation?: unknown }).identityAttestation
    ) {
      throw errors.payeeVerificationRequired(receive.platform);
    }
    return {
      amount,
      payouts: [
        {
          processorName: receive.platform,
          currency: receive.currency,
          payeeData: receive.payee,
        },
      ],
      ...(input.intentAmountRange ? { intentAmountRange: input.intentAmountRange } : {}),
    };
  }

  async function buildDepositParams(client: Zkp2pClient, depositInput: CashDepositInput) {
    try {
      return await prepareCashDepositParams(client, depositInput);
    } catch (err) {
      if (isCashError(err)) throw err;
      // The curator rejects Wise/PayPal payees that lack a signed attestation.
      const message = err instanceof Error ? err.message : String(err);
      if (/identityAttestation is required|identity attestation/i.test(message)) {
        const platform = depositInput.payouts[0]?.processorName ?? 'this platform';
        throw errors.payeeVerificationRequired(platform, err);
      }
      throw errors.payeeRegistrationFailed(err);
    }
  }

  async function fetchOrder(depositId: string): Promise<CashOrder> {
    const deposits = await readClient.indexer.getDepositsByIdsWithRelations([depositId], {
      includeIntents: true,
      intentStatuses: CASH_ORDER_STATUSES,
    });
    const deposit = deposits[0];

    if (!deposit) {
      // Deposit not yet indexed (lag right after creation) - read intents directly.
      const intents = await readClient.indexer.getIntentsForDeposits(
        [depositId],
        CASH_ORDER_STATUSES,
      );
      if (intents.length === 0) throw errors.orderNotFound(depositId);
      return deriveCashOrder(depositId, intents);
    }

    // Reconstruct the payout legs (platform, currency, payee hash, pricing
    // proof) from the relations the same query already returned.
    const payouts = derivePayouts(
      deposit.paymentMethods ?? [],
      deposit.currencies ?? [],
      getPaymentMethodsCatalog(BASE_CHAIN_ID, environment),
    );

    return deriveCashOrder(depositId, deposit.intents ?? [], {
      ...depositOrderOptions(deposit),
      ...(payouts.length > 0 ? { payouts } : {}),
    });
  }

  /** Parse the composite id into the on-chain id + optional escrow override. */
  function escrowContext(depositId: string): {
    onchainDepositId: bigint;
    escrowArg: { escrowAddress?: Address };
  } {
    const { escrowAddress, onchainDepositId } = parseCompositeDepositId(depositId);
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

    if (order.pendingAmount > 0n && liveIntent) {
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
  }): Promise<CashCapabilities>;
  function capabilities(capabilityOptions?: {
    includeRelaySources?: true;
  }): CashCapabilities | Promise<CashCapabilities> {
    const baseCapabilities = buildCapabilities(environment);
    if (!capabilityOptions?.includeRelaySources) return baseCapabilities;
    return readRelaySourceCapabilities(options.relay).then((relay) => ({
      ...baseCapabilities,
      source: { ...baseCapabilities.source, relay },
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
      throw mapChainError('approve', err);
    }
    if (allowance.hadAllowance || !allowance.hash) return;

    const receipt = await client.publicClient.waitForTransactionReceipt({ hash: allowance.hash });
    if (receipt.status === 'reverted') throw errors.transactionFailed(allowance.hash);

    for (let attempt = 0; attempt < 15; attempt++) {
      const visible = (await client.publicClient.readContract({
        address: token,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: 'allowance',
        args: [owner, escrow],
      })) as bigint;
      if (visible >= amount) return;
      await sleep(1_000);
    }
    // The approve mined but the allowance never surfaced on the read path -
    // surface it as retryable rather than blindly submitting a doomed deposit.
    throw errors.allowanceNotVisible(amount);
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
      quote: Execute,
      opts: SignerOptions & {
        onProgress?: (data: ProgressData) => void;
        disableCapabilitiesCheck?: boolean;
      },
    ): Promise<RelayExecutionResult> {
      return executeRelayQuote(quote, opts.signer, {
        ...(options.relay ? { relay: options.relay } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        ...(opts.disableCapabilitiesCheck !== undefined
          ? { disableCapabilitiesCheck: opts.disableCapabilitiesCheck }
          : {}),
      });
    },

    async relayStatus(requestId: string): Promise<RelayStatus> {
      return readRelayStatus(requestId, options.relay);
    },

    async estimate(input: EstimateInput): Promise<CashEstimate> {
      return readEstimate(readClient.publicClient, input, {
        indexerClient: readClient,
        environment,
        ...(options.relay ? { relay: options.relay } : {}),
      });
    },

    async cashout(input: CashoutInput, opts: CashoutOptions): Promise<CashoutResult> {
      const client = signingClient('cashout', opts);
      const owner = opts.signer.account!.address;

      let sourceResult: CashoutResult['source'];
      let cashoutAmount = input.amount;
      if (input.source) {
        const sourceSigner = opts.sourceSigner ?? opts.signer;
        if (!sourceSigner.account) throw errors.signerRequired('source cashout');
        const relayQuote = await quoteRelayToBaseUsdc(
          {
            user: sourceSigner.account.address,
            amount: input.amount,
            source: { chainId: input.source.chainId, currency: input.source.currency },
            recipient: input.source.recipient ?? owner,
            ...(input.source.tradeType ? { tradeType: input.source.tradeType } : {}),
          },
          options.relay,
        );
        const executed = await executeRelayQuote(relayQuote.raw, sourceSigner, {
          ...(options.relay ? { relay: options.relay } : {}),
          ...(opts.onSourceProgress ? { onProgress: opts.onSourceProgress } : {}),
          ...(opts.disableSourceCapabilitiesCheck !== undefined
            ? { disableCapabilitiesCheck: opts.disableSourceCapabilitiesCheck }
            : {}),
        });
        cashoutAmount = relayQuote.outputAmount;
        sourceResult = {
          amount: cashoutAmount,
          ...(executed.requestId ? { requestId: executed.requestId } : {}),
          txHashes: executed.txHashes,
        };
      }

      const depositInput = validateInput({ ...input, amount: cashoutAmount });

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
        throw mapChainError('createDeposit', err);
      }
      const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'reverted') throw errors.transactionFailed(hash);

      const abi = client.escrowV2Abi ?? client.escrowAbi;
      const resolved = resolveCashDepositId({ logs: receipt.logs, abi });
      if (!resolved) throw errors.depositResolutionFailed(hash);

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
        ...(sourceResult ? { source: sourceResult } : {}),
      };
    },

    async prepare(input: CashoutInput): Promise<PrepareResult> {
      if (input.source) throw errors.sourceRouteUnsupportedInPrepare();
      const depositInput = validateInput(input);
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
      };
    },

    async order(depositId: string): Promise<CashOrder> {
      return fetchOrder(depositId);
    },

    async buyer(address: string): Promise<CashBuyerProfile> {
      const intents = await readClient.indexer.getOwnerIntents(address, CASH_ORDER_STATUSES);
      return deriveBuyerProfile(address, intents);
    },

    async orders(owner: string, opts: OrdersOptions = {}): Promise<CashOrder[]> {
      const { inFlight = false, limit = 100 } = opts;
      const deposits = await readClient.indexer.getDeposits({ depositor: owner }, { limit });

      const derived = deposits
        // List rows carry no intent detail - flag it so `nextActions` treats a
        // live outstanding amount conservatively (no false "withdraw" offer).
        .map((d) => deriveCashOrder(d.id, [], { ...depositOrderOptions(d), fillsIncluded: false }))
        // Drop dust/empty deposits that never represented a real cash-out.
        .filter((o) => o.totalAmount > 10_000n)
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
      const client = signingClient('withdraw', opts);

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
      const client = signingClient('topUp', opts);
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
