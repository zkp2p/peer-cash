/**
 * Typed errors - every failure carries a `code`, whether it is `retryable`,
 * and a `remediation` sentence so agents can self-drive recovery.
 */
export type CashErrorCode =
  | 'ORACLE_UNSUPPORTED_CURRENCY'
  | 'UNSUPPORTED_PLATFORM'
  | 'AMOUNT_BELOW_MINIMUM'
  | 'ACTIVE_INTENT_BLOCKS_WITHDRAWAL'
  | 'NOTHING_TO_WITHDRAW'
  | 'INSUFFICIENT_AVAILABLE_FUNDS'
  | 'ORDER_NOT_ACTIVE'
  | 'ESCROW_PAUSED'
  | 'INDEXER_LAG'
  | 'ORDER_NOT_FOUND'
  | 'PAYEE_REGISTRATION_FAILED'
  | 'PAYEE_VERIFICATION_REQUIRED'
  | 'DEPOSIT_RESOLUTION_FAILED'
  | 'ALLOWANCE_NOT_VISIBLE'
  | 'SIGNER_REQUIRED'
  | 'WATCH_TIMEOUT'
  | 'TRANSACTION_FAILED';

export interface CashErrorShape {
  code: CashErrorCode;
  message: string;
  retryable: boolean;
  remediation: string;
}

export class CashError extends Error implements CashErrorShape {
  readonly code: CashErrorCode;
  readonly retryable: boolean;
  readonly remediation: string;

  constructor(shape: CashErrorShape, options?: { cause?: unknown }) {
    super(shape.message, options);
    this.name = 'CashError';
    this.code = shape.code;
    this.retryable = shape.retryable;
    this.remediation = shape.remediation;
  }

  /** Serializable view (for tool results and logs). */
  toJSON(): CashErrorShape {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      remediation: this.remediation,
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
  unsupportedPlatform: (platform: string) =>
    new CashError({
      code: 'UNSUPPORTED_PLATFORM',
      message: `'${platform}' is not a supported payout platform in this environment.`,
      retryable: false,
      remediation: `Pick a platform listed in capabilities().`,
    }),
  amountBelowMinimum: (amount: bigint, min: bigint) =>
    new CashError({
      code: 'AMOUNT_BELOW_MINIMUM',
      message: `Amount ${amount} is below the minimum cash-out of ${min} USDC base units.`,
      retryable: false,
      remediation: `Increase the amount to at least ${min} base units (${Number(min) / 1e6} USDC).`,
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
  orderNotActive: (depositId: string) =>
    new CashError({
      code: 'ORDER_NOT_ACTIVE',
      message: `Order ${depositId} is closed (delivered or returned); it cannot be topped up.`,
      retryable: false,
      remediation: `Start a new cash-out with cashout() instead.`,
    }),
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
  allowanceNotVisible: (amount: bigint) =>
    new CashError({
      code: 'ALLOWANCE_NOT_VISIBLE',
      message: `USDC approval for ${amount} base units did not become visible on the read path in time.`,
      retryable: true,
      remediation: `The approve transaction mined but a load-balanced RPC is serving stale state. Retry the same call in a few seconds.`,
    }),
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
export function mapChainError(verb: string, err: unknown): CashError {
  if (isCashError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/\bpaused\b/i.test(message)) return errors.escrowPaused();
  if (/exceeds allowance|insufficient allowance|transfer amount exceeds/i.test(message)) {
    return errors.allowanceNotVisible(0n);
  }
  return errors.chainCallFailed(verb, err);
}
