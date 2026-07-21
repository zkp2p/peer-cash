/**
 * Typed errors - every failure carries a `code`, whether it is `retryable`,
 * and a `remediation` sentence so agents can self-drive recovery.
 */
export type CashErrorCode =
  | 'ORACLE_UNSUPPORTED_CURRENCY'
  | 'ORACLE_READ_FAILED'
  | 'UNSUPPORTED_PLATFORM'
  | 'UNSUPPORTED_PLATFORM_CURRENCY'
  | 'AMOUNT_BELOW_MINIMUM'
  | 'INVALID_INTENT_AMOUNT_RANGE'
  | 'ACTIVE_INTENT_BLOCKS_WITHDRAWAL'
  | 'NOTHING_TO_WITHDRAW'
  | 'INSUFFICIENT_AVAILABLE_FUNDS'
  | 'INSUFFICIENT_TOKEN_BALANCE'
  | 'ORDER_NOT_ACTIVE'
  | 'INVALID_DEPOSIT_ID'
  | 'ESCROW_PAUSED'
  | 'INDEXER_LAG'
  | 'INDEXER_UNAVAILABLE'
  | 'ORDER_NOT_FOUND'
  | 'PAYEE_REGISTRATION_FAILED'
  | 'PAYEE_VERIFICATION_REQUIRED'
  | 'SOURCE_ROUTE_UNSUPPORTED_IN_PREPARE'
  | 'SOURCE_RECIPIENT_MISMATCH'
  | 'SOURCE_CAPABILITIES_FAILED'
  | 'SOURCE_QUOTE_FAILED'
  | 'SOURCE_NONCE_MANAGER_REQUIRED'
  | 'SOURCE_EXECUTION_FAILED'
  | 'SOURCE_STATUS_FAILED'
  | 'SOURCE_ROUTE_COMPLETED_CASHOUT_FAILED'
  | 'SOURCE_CASHOUT_SUBMISSION_UNKNOWN'
  | 'SOURCE_CASHOUT_STATUS_UNKNOWN'
  | 'DEPOSIT_RESOLUTION_FAILED'
  | 'ALLOWANCE_NOT_VISIBLE'
  | 'SIGNER_REQUIRED'
  | 'SIGNER_CHAIN_MISMATCH'
  | 'SIGNER_CHAIN_UNAVAILABLE'
  | 'WATCH_TIMEOUT'
  | 'TRANSACTION_REJECTED'
  | 'TRANSACTION_FAILED'
  | 'TRANSACTION_SUBMISSION_UNKNOWN'
  | 'TRANSACTION_STATUS_UNKNOWN';

export interface CashErrorShape {
  code: CashErrorCode;
  message: string;
  retryable: boolean;
  remediation: string;
  recovery?: CashErrorRecovery;
}

interface CashSourceRecoveryBase {
  /** Guaranteed Base USDC output available for the retry, as a decimal bigint string. */
  amount: string;
  requestId?: string;
  txHashes: string[];
  transactions?: {
    origin: Array<{ hash: string; chainId: number; isBatchTx?: boolean | undefined }>;
    destination: Array<{ hash: string; chainId: number; isBatchTx?: boolean | undefined }>;
  };
}

export type CashErrorRecovery =
  | (CashSourceRecoveryBase & {
      kind: 'retry-base-usdc-cashout';
    })
  | (CashSourceRecoveryBase & {
      kind: 'inspect-base-cashout-transaction';
      depositTxHash: string;
    })
  | (CashSourceRecoveryBase & {
      kind: 'inspect-base-cashout-submission';
      depositor: string;
    })
  | {
      kind: 'inspect-relay-route';
      requestId?: string;
      txHashes: string[];
      transactions?: CashSourceRecoveryBase['transactions'];
    }
  | {
      kind: 'inspect-base-operation-submission';
      operation: string;
    }
  | {
      kind: 'inspect-base-transaction';
      transactionHash: string;
      operation: string;
    };

export class CashError extends Error implements CashErrorShape {
  readonly code: CashErrorCode;
  readonly retryable: boolean;
  readonly remediation: string;
  readonly recovery?: CashErrorRecovery;

  constructor(shape: CashErrorShape, options?: { cause?: unknown }) {
    super(shape.message, options);
    this.name = 'CashError';
    this.code = shape.code;
    this.retryable = shape.retryable;
    this.remediation = shape.remediation;
    if (shape.recovery) this.recovery = shape.recovery;
  }

  /** Serializable view (for tool results and logs). */
  toJSON(): CashErrorShape {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      remediation: this.remediation,
      ...(this.recovery ? { recovery: this.recovery } : {}),
    };
  }
}

export function isCashError(value: unknown): value is CashError {
  return value instanceof CashError;
}

/** Factory helpers keep call sites one-liners and remediation copy consistent. */
export const errors = {
  oracleUnsupportedCurrency: (currency: string) =>
    new CashError({
      code: 'ORACLE_UNSUPPORTED_CURRENCY',
      message: `${currency} has no live Chainlink oracle feed; Peer Cash is market-rate only.`,
      retryable: false,
      remediation: `Pick a currency listed in capabilities() - each one is priced by a live oracle feed.`,
    }),
  oracleReadFailed: (currency: string, cause?: unknown) =>
    new CashError(
      {
        code: 'ORACLE_READ_FAILED',
        message: `The ${currency} market-rate oracle could not be read.`,
        retryable: true,
        remediation: `Retry the estimate shortly or use another healthy Base RPC. Do not present a cached value as a live market rate.`,
      },
      { cause },
    ),
  unsupportedPlatform: (platform: string) =>
    new CashError({
      code: 'UNSUPPORTED_PLATFORM',
      message: `'${platform}' is not a supported payout platform in this environment.`,
      retryable: false,
      remediation: `Pick a platform listed in capabilities().`,
    }),
  unsupportedPlatformCurrency: (platform: string, currency: string) =>
    new CashError({
      code: 'UNSUPPORTED_PLATFORM_CURRENCY',
      message: `${platform} cannot receive ${currency} in this environment.`,
      retryable: false,
      remediation: `Pick one of the currencies listed for ${platform} in capabilities().`,
    }),
  amountBelowMinimum: (amount: bigint, min: bigint) =>
    new CashError({
      code: 'AMOUNT_BELOW_MINIMUM',
      message: `Amount ${amount} is below the minimum cash-out of ${min} USDC base units.`,
      retryable: false,
      remediation: `Increase the amount to at least ${min} base units (${Number(min) / 1e6} USDC).`,
    }),
  invalidIntentAmountRange: (amount: bigint, min: bigint, max: bigint) =>
    new CashError({
      code: 'INVALID_INTENT_AMOUNT_RANGE',
      message: `Intent amount range ${min}-${max} is invalid for a ${amount} base-unit cash-out.`,
      retryable: false,
      remediation: `Use a positive minimum no greater than the maximum, and a maximum no greater than the cash-out amount.`,
    }),
  activeIntentBlocksWithdrawal: (depositId: string) =>
    new CashError({
      code: 'ACTIVE_INTENT_BLOCKS_WITHDRAWAL',
      message: `Order ${depositId} has a live buyer intent; escrow blocks withdrawal while a buyer may still deliver.`,
      retryable: true,
      remediation: `Wait for the buyer to complete or for their intent to expire, then call withdraw() again - it prunes expired intents automatically.`,
    }),
  insufficientAvailableFunds: (depositId: string, requested: bigint, available: bigint) =>
    new CashError({
      code: 'INSUFFICIENT_AVAILABLE_FUNDS',
      message: `Order ${depositId} has ${available} base units available; ${requested} requested.`,
      retryable: true,
      remediation: `Withdraw at most the available (unlocked) amount, or omit the amount to close the order fully once no buyer intent is live.`,
    }),
  insufficientTokenBalance: (requiredAmount?: bigint) =>
    new CashError({
      code: 'INSUFFICIENT_TOKEN_BALANCE',
      message:
        requiredAmount === undefined
          ? `The wallet does not hold enough of the source token for this transaction.`
          : `The wallet does not hold the ${requiredAmount} base units required for this transaction.`,
      retryable: false,
      remediation:
        requiredAmount === undefined
          ? `Fund the wallet with the required token amount, then retry.`
          : `Fund the wallet to at least ${requiredAmount} token base units, then retry.`,
    }),
  orderNotActive: (depositId: string) =>
    new CashError({
      code: 'ORDER_NOT_ACTIVE',
      message: `Order ${depositId} is closed (delivered or returned); it cannot be topped up.`,
      retryable: false,
      remediation: `Start a new cash-out with cashout() instead.`,
    }),
  invalidDepositId: (depositId: string, cause?: unknown) =>
    new CashError(
      {
        code: 'INVALID_DEPOSIT_ID',
        message: `'${depositId}' is not a valid Peer Cash deposit id.`,
        retryable: false,
        remediation: `Use the depositId returned by cashout() (escrowAddress_onchainDepositId) without modifying it.`,
      },
      { cause },
    ),
  nothingToWithdraw: (depositId: string) =>
    new CashError({
      code: 'NOTHING_TO_WITHDRAW',
      message: `Order ${depositId} holds no withdrawable funds (already delivered or returned).`,
      retryable: false,
      remediation: `Check order(depositId).state - this order is terminal.`,
    }),
  indexerLag: (depositId: string) =>
    new CashError({
      code: 'INDEXER_LAG',
      message: `Order ${depositId} is not indexed yet (the deposit may be seconds old).`,
      retryable: true,
      remediation: `Retry in a few seconds; on-chain state is ahead of the indexer right after a transaction.`,
    }),
  orderNotFound: (depositId: string) =>
    new CashError({
      code: 'ORDER_NOT_FOUND',
      message: `No deposit found for id ${depositId}.`,
      retryable: true,
      remediation: `Verify the composite depositId (escrow_onchainId). If the deposit was created seconds ago this is indexer lag - retry shortly.`,
    }),
  indexerUnavailable: (operation: string, cause?: unknown) =>
    new CashError(
      {
        code: 'INDEXER_UNAVAILABLE',
        message: `The protocol indexer could not complete the ${operation} query.`,
        retryable: true,
        remediation: `Retry shortly. Keep the composite depositId or owner address so the read can resume without repeating an on-chain transaction.`,
      },
      { cause },
    ),
  payeeRegistrationFailed: (cause: unknown) =>
    new CashError(
      {
        code: 'PAYEE_REGISTRATION_FAILED',
        message: `Registering payee details with the curator failed.`,
        retryable: true,
        remediation: `Check the payee handle format for the platform (see capabilities() hints) and retry.`,
      },
      { cause },
    ),
  payeeVerificationRequired: (platform: string, cause?: unknown) =>
    new CashError(
      {
        code: 'PAYEE_VERIFICATION_REQUIRED',
        message: `${platform} requires a verified maker identity attestation to register a payee; a bare handle is not accepted.`,
        retryable: false,
        remediation: `Register this ${platform} payee through the ZKP2P app / extension (which produces the signed identity attestation) before cashing out. capabilities() flags such platforms with requiresIdentityAttestation: true.`,
      },
      { cause },
    ),
  sourceRouteUnsupportedInPrepare: () =>
    new CashError({
      code: 'SOURCE_ROUTE_UNSUPPORTED_IN_PREPARE',
      message: `prepare() cannot execute a Relay source route before creating the Base USDC cash-out.`,
      retryable: false,
      remediation: `Use cashout(inputWithSource, { signer }) for the one-call bridge-then-cashout flow, or call quoteSource()/executeSourceQuote() first and then prepare() a Base USDC cash-out.`,
    }),
  sourceRecipientMismatch: (recipient: string, owner: string) =>
    new CashError({
      code: 'SOURCE_RECIPIENT_MISMATCH',
      message: `Source recipient ${recipient} does not match the cash-out depositor ${owner}.`,
      retryable: false,
      remediation: `For one-call source cashout, deliver Relay output to the depositor address. For a different recipient, bridge first and then cash out from that recipient's signer.`,
    }),
  sourceCapabilitiesFailed: (cause?: unknown) =>
    new CashError(
      {
        code: 'SOURCE_CAPABILITIES_FAILED',
        message: `Relay source-chain discovery failed.`,
        retryable: true,
        remediation: `Retry sourceCapabilities() shortly, or use the default Base USDC path.`,
      },
      { cause },
    ),
  sourceQuoteFailed: (cause?: unknown) =>
    new CashError(
      {
        code: 'SOURCE_QUOTE_FAILED',
        message: `Relay did not return a valid route to canonical Base USDC.`,
        retryable: true,
        remediation: `Refresh source capabilities and request a new quote. Do not submit transactions from this response.`,
      },
      { cause },
    ),
  sourceNonceManagerRequired: (transactionCount: number) =>
    new CashError({
      code: 'SOURCE_NONCE_MANAGER_REQUIRED',
      message: `This Relay route submits ${transactionCount} source-chain transactions, but the local signer has no nonce manager; the route transaction would reuse the approval nonce and revert.`,
      retryable: false,
      remediation: `Create the source signer with viem's nonce manager - privateKeyToAccount(pk, { nonceManager }) - then request a fresh quote and retry. No transaction was submitted.`,
    }),
  sourceExecutionFailed: (
    cause?: unknown,
    evidence?: {
      requestId?: string;
      txHashes: string[];
      transactions?: CashSourceRecoveryBase['transactions'];
    },
  ) =>
    new CashError(
      {
        code: 'SOURCE_EXECUTION_FAILED',
        message: `Relay source-route execution did not complete successfully.`,
        retryable: false,
        remediation: `Inspect the wallet transactions and Relay request status before retrying so the source transfer is never submitted twice.`,
        ...(evidence && (evidence.requestId !== undefined || evidence.txHashes.length > 0)
          ? {
              recovery: {
                kind: 'inspect-relay-route' as const,
                ...(evidence.requestId ? { requestId: evidence.requestId } : {}),
                txHashes: evidence.txHashes,
                ...(evidence.transactions ? { transactions: evidence.transactions } : {}),
              },
            }
          : {}),
      },
      { cause },
    ),
  sourceStatusFailed: (requestId: string, cause?: unknown) =>
    new CashError(
      {
        code: 'SOURCE_STATUS_FAILED',
        message: `Relay status is unavailable for request ${requestId}.`,
        retryable: true,
        remediation: `Retry relayStatus(requestId) shortly; keep the request id and transaction hashes for recovery.`,
      },
      { cause },
    ),
  sourceRouteCompletedCashoutFailed: (
    source: {
      amount: bigint;
      requestId?: string;
      txHashes: string[];
      transactions?: CashSourceRecoveryBase['transactions'];
    },
    cause?: unknown,
  ) =>
    new CashError(
      {
        code: 'SOURCE_ROUTE_COMPLETED_CASHOUT_FAILED',
        message: `Relay completed, but the Base USDC cash-out transaction was not created.`,
        retryable: false,
        remediation: `Do not repeat the Relay route. Retry cashout() without source using the recovery amount already delivered on Base.`,
        recovery: {
          kind: 'retry-base-usdc-cashout',
          amount: source.amount.toString(),
          ...(source.requestId ? { requestId: source.requestId } : {}),
          txHashes: source.txHashes,
          ...(source.transactions ? { transactions: source.transactions } : {}),
        },
      },
      { cause },
    ),
  sourceCashoutSubmissionUnknown: (
    source: {
      amount: bigint;
      requestId?: string;
      txHashes: string[];
      transactions?: CashSourceRecoveryBase['transactions'];
    },
    depositor: string,
    cause?: unknown,
  ) =>
    new CashError(
      {
        code: 'SOURCE_CASHOUT_SUBMISSION_UNKNOWN',
        message: `Relay completed, but the Base cash-out submission did not return a transaction hash.`,
        retryable: false,
        remediation: `Do not repeat Relay or submit another cash-out yet. Inspect recent Base transactions and orders(${depositor}) to prove no deposit was broadcast; only then retry Base-USDC-only with the recovery amount.`,
        recovery: {
          kind: 'inspect-base-cashout-submission',
          amount: source.amount.toString(),
          ...(source.requestId ? { requestId: source.requestId } : {}),
          txHashes: source.txHashes,
          ...(source.transactions ? { transactions: source.transactions } : {}),
          depositor,
        },
      },
      { cause },
    ),
  sourceCashoutStatusUnknown: (
    source: {
      amount: bigint;
      requestId?: string;
      txHashes: string[];
      transactions?: CashSourceRecoveryBase['transactions'];
    },
    depositTxHash: string,
    cause?: unknown,
  ) =>
    new CashError(
      {
        code: 'SOURCE_CASHOUT_STATUS_UNKNOWN',
        message: `Relay completed and Base cash-out transaction ${depositTxHash} was submitted, but its receipt could not be confirmed.`,
        retryable: false,
        remediation: `Do not repeat the Relay route or submit another cash-out. Inspect the Base transaction; if it succeeded, recover the depositId from its DepositReceived log, and if it reverted, retry a Base-USDC-only cashout with the recovery amount.`,
        recovery: {
          kind: 'inspect-base-cashout-transaction',
          amount: source.amount.toString(),
          ...(source.requestId ? { requestId: source.requestId } : {}),
          txHashes: source.txHashes,
          ...(source.transactions ? { transactions: source.transactions } : {}),
          depositTxHash,
        },
      },
      { cause },
    ),
  allowanceNotVisible: (amount: bigint, cause?: unknown) =>
    new CashError(
      {
        code: 'ALLOWANCE_NOT_VISIBLE',
        message: `USDC approval for ${amount} base units did not become visible on the read path in time.`,
        retryable: true,
        remediation: `The approve transaction mined but the RPC read path is stale or unavailable. Retry the same call in a few seconds.`,
      },
      { cause },
    ),
  depositResolutionFailed: (txHash: string) =>
    new CashError({
      code: 'DEPOSIT_RESOLUTION_FAILED',
      message: `Deposit transaction ${txHash} succeeded but no DepositReceived event was found in the receipt.`,
      retryable: false,
      remediation: `Inspect the transaction on Basescan; recover the depositId from the DepositReceived log manually, then resume with order(depositId).`,
    }),
  signerRequired: (verb: string) =>
    new CashError({
      code: 'SIGNER_REQUIRED',
      message: `${verb}() mutates on-chain state and needs a signer.`,
      retryable: false,
      remediation: `Pass { signer } (a viem WalletClient with an account), or use prepare() and submit the returned txs with your own signing infrastructure.`,
    }),
  signerChainMismatch: (verb: string, expectedChainId: number, actualChainId: number) =>
    new CashError({
      code: 'SIGNER_CHAIN_MISMATCH',
      message: `${verb} requires chain ${expectedChainId}, but the signer is connected to chain ${actualChainId}.`,
      retryable: false,
      remediation: `Switch the wallet to chain ${expectedChainId}, obtain a fresh quote if Relay is involved, and retry before submitting any transaction.`,
    }),
  signerChainUnavailable: (verb: string, expectedChainId: number, cause?: unknown) =>
    new CashError(
      {
        code: 'SIGNER_CHAIN_UNAVAILABLE',
        message: `${verb} could not verify that the signer is connected to chain ${expectedChainId}.`,
        retryable: true,
        remediation: `Reconnect the wallet, switch it to chain ${expectedChainId}, and retry before submitting any transaction.`,
      },
      { cause },
    ),
  watchTimeout: (depositId: string, timeoutMs: number) =>
    new CashError({
      code: 'WATCH_TIMEOUT',
      message: `watch(${depositId}) exceeded ${timeoutMs}ms without reaching a terminal state.`,
      retryable: true,
      remediation: `The order is still live - resume any time with watch(depositId) or order(depositId).`,
    }),
  transactionFailed: (txHash: string, cause?: unknown) =>
    new CashError(
      {
        code: 'TRANSACTION_FAILED',
        message: `Transaction ${txHash} reverted.`,
        retryable: false,
        remediation: `Inspect the transaction on Basescan; the deposit state is unchanged if the revert happened before escrow accepted funds.`,
      },
      { cause },
    ),
  transactionRejected: (verb: string, cause?: unknown) =>
    new CashError(
      {
        code: 'TRANSACTION_REJECTED',
        message: `The ${verb} wallet request was cancelled.`,
        retryable: true,
        remediation: `Retry the original Peer Cash action and approve the wallet request when you are ready.`,
      },
      { cause },
    ),
  transactionSubmissionUnknown: (
    operation: string,
    cause?: unknown,
    recovery?: CashErrorRecovery,
  ) =>
    new CashError(
      {
        code: 'TRANSACTION_SUBMISSION_UNKNOWN',
        message: `The Base ${operation} submission did not return a transaction hash.`,
        retryable: false,
        remediation: `Do not submit the operation again until you inspect recent Base wallet activity and protocol state; the first transaction may already exist.`,
        ...(recovery ? { recovery } : {}),
      },
      { cause },
    ),
  transactionStatusUnknown: (txHash: string, cause?: unknown, operation = 'transaction') =>
    new CashError(
      {
        code: 'TRANSACTION_STATUS_UNKNOWN',
        message: `Transaction ${txHash} was submitted, but its receipt could not be confirmed.`,
        retryable: false,
        remediation: `Do not resubmit the operation until you inspect ${txHash} on Base or successfully fetch its receipt; the transaction may already have succeeded.`,
        recovery: {
          kind: 'inspect-base-transaction',
          transactionHash: txHash,
          operation,
        },
      },
      { cause },
    ),
  escrowPaused: () =>
    new CashError({
      code: 'ESCROW_PAUSED',
      message: `The escrow contract is paused; deposits are temporarily disabled.`,
      retryable: true,
      remediation: `Wait for the protocol to unpause and retry. Existing funds remain withdrawable.`,
    }),
  /** Generic fallback for an on-chain call that failed for an unrecognized reason. */
  chainCallFailed: (verb: string, cause?: unknown) =>
    new CashError(
      {
        code: 'TRANSACTION_FAILED',
        message: `The on-chain ${verb} call failed.`,
        retryable: false,
        remediation: `Inspect the error cause and the wallet on Basescan. Deposit state is unchanged if the call reverted before escrow accepted funds.`,
      },
      { cause },
    ),
};

/**
 * Map a raw SDK/RPC/viem error from a mutating on-chain call to a typed
 * `CashError`, so the package's error contract holds even when the underlying
 * call reverts. Recognized reverts get specific codes; everything else falls
 * back to a wrapped `TRANSACTION_FAILED` (never a raw error to the consumer).
 */
export function mapChainError(
  verb: string,
  err: unknown,
  context: { requiredAmount?: bigint } = {},
): CashError {
  if (isCashError(err)) return err;
  if (isUserRejectedError(err)) return errors.transactionRejected(verb, err);
  const message = err instanceof Error ? err.message : String(err);
  if (/\bpaused\b/i.test(message)) return errors.escrowPaused();
  if (/exceeds balance|insufficient token balance/i.test(message)) {
    return errors.insufficientTokenBalance(context.requiredAmount);
  }
  if (/exceeds allowance|insufficient allowance/i.test(message)) {
    return errors.allowanceNotVisible(context.requiredAmount ?? 0n);
  }
  return errors.chainCallFailed(verb, err);
}

function hasUserRejectionText(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return (
    normalized.includes('userrejected') ||
    normalized.includes('userdenied') ||
    normalized.includes('requestrejected') ||
    normalized.includes('rejectedrequest') ||
    /(^|[^a-z0-9])action[_ -]?rejected(?:error)?($|[^a-z0-9])/i.test(value) ||
    normalized === 'actionrejected' ||
    normalized === 'actionrejectederror'
  );
}

/** Detect EIP-1193 and viem wallet cancellations, including nested provider causes. */
export function isUserRejectedError(value: unknown): boolean {
  const seen = new Set<unknown>();
  const text: string[] = [];
  let current: unknown = value;

  while (current !== null && !seen.has(current)) {
    seen.add(current);
    if (current === -32003 || current === '-32003') return false;
    if (current === 4001 || current === '4001' || current === 5000 || current === '5000') {
      return true;
    }
    if (typeof current === 'string') {
      text.push(current);
      break;
    }
    if (typeof current !== 'object' && typeof current !== 'function') break;

    const detail = current as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    if (
      detail.code === -32003 ||
      detail.code === '-32003' ||
      detail.name === 'TransactionRejectedRpcError'
    ) {
      return false;
    }
    if (
      detail.code === 4001 ||
      detail.code === '4001' ||
      detail.code === 5000 ||
      detail.code === '5000' ||
      detail.code === 'ACTION_REJECTED' ||
      detail.name === 'UserRejectedRequestError'
    ) {
      return true;
    }
    text.push(
      ...[detail.name, detail.message, detail.code].filter(
        (part): part is string => typeof part === 'string',
      ),
    );
    if (detail.cause === undefined) break;
    current = detail.cause;
  }

  return text.some(hasUserRejectionText);
}
