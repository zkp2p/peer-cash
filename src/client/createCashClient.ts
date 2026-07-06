/**
 * `createCashClient` — the six-verb facade over a read-only `Zkp2pClient`.
 *
 * The facade keeps the outward surface tiny (capabilities / estimate / cashout
 * / prepare / order / orders / watch / withdraw) while reusing the published
 * SDK's battle-tested internals. A React app, a Node service, and an AI agent
 * are equal consumers: every mutating verb has an unsigned `prepare` path and
 * every wire type is serializable.
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
import { Zkp2pClient, getPaymentMethodsCatalog } from '@zkp2p/sdk';
import type {
  CurrencyType,
  CuratorPayeeDataInput,
  PreparedTransaction,
  RuntimeEnv,
} from '../sdk-types';
import { BASE_CHAIN_ID, CASH_ORDER_STATUSES } from '../engine/constants';
import { isMarketRateSupported, prepareCashDepositParams } from '../engine/marketRate';
import { deriveCashOrder } from '../engine/orderState';
import { parseCompositeDepositId, resolveCashDepositId } from '../engine/resolveDeposit';
import type { CashDepositInput, CashOrder } from '../engine/types';
import { buildCapabilities, MIN_CASHOUT_AMOUNT, type CashCapabilities } from './capabilities';
import { readEstimate, type CashEstimate, type EstimateInput } from './estimate';
import { CashError, errors, isCashError } from './errors';

const DEFAULT_RPC_URL = 'https://mainnet.base.org';
const ERC20_APPROVE_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
]);

export interface CashClientOptions {
  /** `'production' | 'preproduction' | 'staging'` — selects contracts, curator, and indexer. */
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
  /** Amount to cash out, USDC base units. Use `usdc()` to build it. */
  amount: bigint;
  /** Where the fiat should arrive. Multi-payout is a deliberate v1 cut. */
  receive: CashLeg;
  /** Per-order min/max override (USDC base units). */
  intentAmountRange?: { min: bigint; max: bigint };
}

export interface SignerOptions {
  /** A viem WalletClient with an account, on Base. */
  signer: WalletClient;
}

export interface CashoutResult {
  /** Composite deposit id (`escrow_onchainId`) — the resume key. Bind it to your user. */
  depositId: string;
  txHash: Hash;
  escrowAddress: string;
  onchainDepositId: bigint;
  /** Optimistic snapshot (`awaiting-buyer`); poll `order(depositId)` for live state. */
  order: CashOrder;
}

export interface PrepareResult {
  /**
   * Unsigned transactions in submission order: `[approve, createDeposit]`.
   * Submit with any signer — agent wallet, AA bundler, server key. Drop the
   * approve when the escrow already has sufficient allowance.
   */
  txs: PreparedTransaction[];
  /** Curator payee registration output — the payee hashes now live on the deposit params. */
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
  /** 0 — Discovery: sync, static. */
  capabilities(): CashCapabilities;
  /** 1 — Estimate: currency + amount only. No payee, no side effects, no expiry. */
  estimate(input: EstimateInput): Promise<CashEstimate>;
  /** 2 — Cash out: payee registration + deposit params + submission happen here. */
  cashout(input: CashoutInput, opts: SignerOptions): Promise<CashoutResult>;
  /** 2b — Unsigned path: `txs[]` for agent wallets, AA, server keys, policy layers. */
  prepare(input: CashoutInput): Promise<PrepareResult>;
  /** 3 — Observe: resumable from `depositId` alone; no session state anywhere. */
  order(depositId: string): Promise<CashOrder>;
  /** 4 — List: indexer-native. A cash order IS a deposit; the chain is the database. */
  orders(owner: string, opts?: OrdersOptions): Promise<CashOrder[]>;
  /** 5 — Watch: yields on change; ends at a terminal state, abort, or timeout. */
  watch(depositId: string, opts?: WatchOptions): AsyncGenerator<CashOrder, void, void>;
  /** 6 — Withdraw: ONE unwind verb; prunes expired intents first when needed. */
  withdraw(depositId: string, opts: SignerOptions): Promise<WithdrawResult>;
  /**
   * 6b — Unsigned path for the unwind verb (agent surface): the same state
   * checks as `withdraw()`, returning `txs[]` (`[prune?, withdraw]`) for
   * host-side signing.
   */
  prepareWithdraw(depositId: string): Promise<{ txs: PreparedTransaction[] }>;
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

function toBigIntOrUndefined(value: unknown): bigint | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  try {
    return BigInt(typeof value === 'number' ? Math.trunc(value) : String(value));
  } catch {
    return undefined;
  }
}

export function createCashClient(options: CashClientOptions): CashClient {
  const { environment } = options;
  const transport = options.transport ?? http(options.rpcUrl ?? DEFAULT_RPC_URL);

  function buildSdkClient(walletClient: WalletClient): Zkp2pClient {
    return new Zkp2pClient({
      walletClient,
      chainId: BASE_CHAIN_ID,
      runtimeEnv: environment,
      rpcTransport: transport,
      ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
      ...(options.indexerUrl ? { indexerUrl: options.indexerUrl } : {}),
      ...(options.curatorUrl ? { baseApiUrl: options.curatorUrl } : {}),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    });
  }

  // Read-only client — indexer, curator registration, oracle reads.
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
      // Deposit not yet indexed (lag right after creation) — read intents directly.
      const intents = await readClient.indexer.getIntentsForDeposits(
        [depositId],
        CASH_ORDER_STATUSES,
      );
      if (intents.length === 0) throw errors.orderNotFound(depositId);
      return deriveCashOrder(depositId, intents);
    }

    const remaining = toBigIntOrUndefined(deposit.remainingDeposits);
    const outstanding = toBigIntOrUndefined(deposit.outstandingIntentAmount);
    const taken = toBigIntOrUndefined(deposit.totalAmountTaken);
    const withdrawn = toBigIntOrUndefined(deposit.totalWithdrawn);
    const updatedAt = deposit.updatedAt != null ? Number(deposit.updatedAt) : undefined;

    return deriveCashOrder(depositId, deposit.intents ?? [], {
      ...(remaining !== undefined ? { remainingAmount: remaining } : {}),
      ...(outstanding !== undefined ? { outstandingAmount: outstanding } : {}),
      ...(taken !== undefined ? { takenAmount: taken } : {}),
      ...(withdrawn !== undefined ? { withdrawnAmount: withdrawn } : {}),
      ...(deposit.status != null ? { status: deposit.status } : {}),
      ...(deposit.totalIntents != null ? { intentCount: deposit.totalIntents } : {}),
      ...(updatedAt !== undefined && Number.isFinite(updatedAt) ? { updatedAt } : {}),
    });
  }

  /**
   * Shared state gate for both withdraw paths. Returns whether an expired
   * intent must be pruned before withdrawal can succeed.
   */
  async function assertWithdrawable(depositId: string): Promise<{ expiredIntent: boolean }> {
    const order = await fetchOrder(depositId);

    const remaining =
      order.totalAmount - order.filledAmount - order.pendingAmount - order.returnedAmount;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const signaled = order.fills.filter((f) => f.status === 'SIGNALED');
    const liveIntent = signaled.some((f) => f.expiresAt === undefined || f.expiresAt > nowSeconds);
    const expiredIntent = signaled.length > 0 && !liveIntent;

    if (order.pendingAmount > 0n && liveIntent) {
      throw errors.activeIntentBlocksWithdrawal(depositId);
    }
    if (remaining <= 0n && order.pendingAmount === 0n) {
      throw errors.nothingToWithdraw(depositId);
    }
    return { expiredIntent };
  }

  return {
    capabilities(): CashCapabilities {
      return buildCapabilities(environment);
    },

    async estimate(input: EstimateInput): Promise<CashEstimate> {
      return readEstimate(readClient.publicClient, input);
    },

    async cashout(input: CashoutInput, opts: SignerOptions): Promise<CashoutResult> {
      const depositInput = validateInput(input);
      const client = signingClient('cashout', opts);

      const params = await buildDepositParams(client, depositInput);

      await client.ensureAllowance({
        token: params.token,
        amount: depositInput.amount,
      });

      const { hash } = await client.createDeposit(params);
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
      };
    },

    async prepare(input: CashoutInput): Promise<PrepareResult> {
      const depositInput = validateInput(input);
      const params = await buildDepositParams(readClient, depositInput);

      const { prepared } = await readClient.prepareCreateDeposit(params);

      const approve: PreparedTransaction = {
        to: params.token,
        data: encodeFunctionData({
          abi: ERC20_APPROVE_ABI,
          functionName: 'approve',
          args: [prepared.to as Address, depositInput.amount],
        }),
        value: 0n,
        chainId: BASE_CHAIN_ID,
      };

      const hashedOnchainIds = (params.paymentMethodDataOverride ?? []).map(
        (d) => d.payeeDetails,
      );

      return { txs: [approve, prepared], register: { hashedOnchainIds } };
    },

    async order(depositId: string): Promise<CashOrder> {
      return fetchOrder(depositId);
    },

    async orders(owner: string, opts: OrdersOptions = {}): Promise<CashOrder[]> {
      const { inFlight = false, limit = 100 } = opts;
      const deposits = await readClient.indexer.getDeposits({ depositor: owner }, { limit });

      const derived = deposits
        .map((d) => {
          const remaining = toBigIntOrUndefined(d.remainingDeposits) ?? 0n;
          const outstanding = toBigIntOrUndefined(d.outstandingIntentAmount) ?? 0n;
          const taken = toBigIntOrUndefined(d.totalAmountTaken) ?? 0n;
          const withdrawn = toBigIntOrUndefined(d.totalWithdrawn) ?? 0n;
          const updatedAt = d.updatedAt != null ? Number(d.updatedAt) : undefined;
          return deriveCashOrder(d.id, [], {
            totalAmount: remaining + outstanding + taken + withdrawn,
            remainingAmount: remaining,
            outstandingAmount: outstanding,
            takenAmount: taken,
            withdrawnAmount: withdrawn,
            ...(d.status != null ? { status: d.status } : {}),
            intentCount: d.totalIntents ?? 0,
            ...(updatedAt !== undefined && Number.isFinite(updatedAt) ? { updatedAt } : {}),
          });
        })
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
          // Right after cashout the indexer may not have the deposit yet — keep polling.
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

    async withdraw(depositId: string, opts: SignerOptions): Promise<WithdrawResult> {
      const client = signingClient('withdraw', opts);
      const { expiredIntent } = await assertWithdrawable(depositId);

      const { escrowAddress, onchainDepositId } = parseCompositeDepositId(depositId);
      const escrowArg = escrowAddress ? { escrowAddress: escrowAddress as Address } : {};

      let pruneTxHash: Hash | undefined;
      if (expiredIntent) {
        // Free the expired intent's locked amount back to the deposit first —
        // withdrawDeposit reverts while any intent is still recorded as active.
        pruneTxHash = (await client.pruneExpiredIntents({
          depositId: onchainDepositId,
          ...escrowArg,
        })) as Hash;
        await client.publicClient.waitForTransactionReceipt({ hash: pruneTxHash });
      }

      const withdrawTxHash = (await client.withdrawDeposit({
        depositId: onchainDepositId,
        ...escrowArg,
      })) as Hash;
      await client.publicClient.waitForTransactionReceipt({ hash: withdrawTxHash });

      return {
        depositId,
        ...(pruneTxHash !== undefined ? { pruneTxHash } : {}),
        withdrawTxHash,
      };
    },

    async prepareWithdraw(depositId: string): Promise<{ txs: PreparedTransaction[] }> {
      const { expiredIntent } = await assertWithdrawable(depositId);

      const { escrowAddress, onchainDepositId } = parseCompositeDepositId(depositId);
      const escrowArg = escrowAddress ? { escrowAddress: escrowAddress as Address } : {};

      const txs: PreparedTransaction[] = [];
      if (expiredIntent) {
        txs.push(
          await readClient.pruneExpiredIntents.prepare({
            depositId: onchainDepositId,
            ...escrowArg,
          }),
        );
      }
      txs.push(
        await readClient.withdrawDeposit.prepare({ depositId: onchainDepositId, ...escrowArg }),
      );
      return { txs };
    },
  };
}

export { CashError, isCashError, errors };
