/**
 * zod schemas for every wire type. The wire format encodes bigints as decimal
 * strings so orders, estimates, and prepared txs cross tool-call and process
 * boundaries losslessly.
 */
import { z } from 'zod';
import type { CashErrorCode } from '../client/errors';

export const bigintString = z.string().regex(/^-?\d+$/, 'expected a decimal bigint string');
export const nonNegativeBigintString = z
  .string()
  .regex(/^\d+$/, 'expected a non-negative decimal bigint string');

export const relayTransactionJsonSchema = z.object({
  hash: z.string(),
  chainId: z.number(),
  isBatchTx: z.boolean().optional(),
});

export const relayTransactionsJsonSchema = z
  .object({
    origin: z.array(relayTransactionJsonSchema),
    destination: z.array(relayTransactionJsonSchema),
  })
  .strict();

export const cashAssetJsonSchema = z.object({
  chainId: z.number(),
  address: z.string(),
  symbol: z.string(),
  decimals: z.number(),
  name: z.string().optional(),
  isNative: z.boolean().optional(),
});

export const cashChainJsonSchema = z.object({
  id: z.number(),
  name: z.string(),
  displayName: z.string(),
  disabled: z.boolean(),
  depositEnabled: z.boolean(),
  blockProductionLagging: z.boolean(),
  vmType: z.string().optional(),
  tokens: z.array(cashAssetJsonSchema),
});

export const cashSourceCapabilitiesJsonSchema = z.object({
  destination: cashAssetJsonSchema,
  chains: z.array(cashChainJsonSchema),
  source: z.literal('relay-sdk'),
  asOf: z.number(),
});

export const cashOrderStateSchema = z.enum([
  'awaiting-buyer',
  'matched',
  'delivering',
  'delivered',
  'returned',
]);

export const cashNextActionSchema = z.enum(['wait', 'withdraw']);

export const intentStatusSchema = z.enum(['SIGNALED', 'FULFILLED', 'PRUNED', 'MANUALLY_RELEASED']);

export const cashFillJsonSchema = z.object({
  intentHash: z.string(),
  status: intentStatusSchema,
  amount: nonNegativeBigintString,
  buyer: z.string(),
  currency: z.string().optional(),
  currencyHash: z.string().optional(),
  rate: z.number().optional(),
  conversionRate: nonNegativeBigintString.optional(),
  fiatOwed: z.number().optional(),
  fiatPaid: z.number().optional(),
  paidCurrency: z.string().optional(),
  paymentId: z.string().optional(),
  paidAt: z.number().optional(),
  releasedAmount: nonNegativeBigintString.optional(),
  fillLatencySeconds: z.number().optional(),
  isExpired: z.boolean().optional(),
  signaledAt: z.number().optional(),
  expiresAt: z.number().optional(),
  fulfilledAt: z.number().optional(),
  prunedAt: z.number().optional(),
});

export const cashPayoutPricingJsonSchema = z.object({
  spreadBps: z.number().optional(),
  kind: z.string().optional(),
  rateSource: z.string().optional(),
  oracleRate: z.number().optional(),
  lastOracleUpdatedAt: z.number().optional(),
  marketRate: z.boolean(),
});

export const cashPayoutInfoJsonSchema = z.object({
  platform: z.string(),
  platformHash: z.string(),
  currency: z.string().optional(),
  currencyHash: z.string().optional(),
  payeeHash: z.string(),
  active: z.boolean(),
  pricing: cashPayoutPricingJsonSchema,
});

export const cashBuyerProfileJsonSchema = z.object({
  address: z.string(),
  totalIntents: z.number(),
  fulfilled: z.number(),
  pruned: z.number(),
  signaled: z.number(),
  successRateBps: z.number().optional(),
  firstSeenAt: z.number().optional(),
  lastSeenAt: z.number().optional(),
});

export const cashOrderJsonSchema = z.object({
  depositId: z.string(),
  state: cashOrderStateSchema,
  fills: z.array(cashFillJsonSchema),
  totalAmount: nonNegativeBigintString,
  filledAmount: nonNegativeBigintString,
  pendingAmount: nonNegativeBigintString,
  returnedAmount: nonNegativeBigintString,
  nextActions: z.array(cashNextActionSchema),
  primaryIntentHash: z.string().optional(),
  matchedAt: z.number().optional(),
  deliveredAt: z.number().optional(),
  updatedAt: z.number().optional(),
  intentCount: z.number().optional(),
  payouts: z.array(cashPayoutInfoJsonSchema).optional(),
  successRateBps: z.number().optional(),
  isInFlight: z.boolean(),
  withdrawn: z.boolean().optional(),
});

export const cashEstimateJsonSchema = z.object({
  kind: z.literal('oracle-estimate'),
  currency: z.string(),
  amount: nonNegativeBigintString,
  rate: z.number(),
  receiveAmount: z.number(),
  asOf: z.number(),
  oracleUpdatedAt: z.number().optional(),
  stale: z.boolean().optional(),
  source: z
    .object({
      kind: z.literal('relay'),
      asset: z.object({
        chainId: z.number(),
        address: z.string(),
        symbol: z.string(),
        decimals: z.number(),
        name: z.string().optional(),
        isNative: z.boolean().optional(),
      }),
      inputAmount: nonNegativeBigintString,
      relayQuote: z.object({
        requestId: z.string().optional(),
        source: z.object({
          chainId: z.number(),
          address: z.string(),
          symbol: z.string(),
          decimals: z.number(),
          name: z.string().optional(),
          isNative: z.boolean().optional(),
        }),
        destination: z.object({
          chainId: z.number(),
          address: z.string(),
          symbol: z.string(),
          decimals: z.number(),
          name: z.string().optional(),
          isNative: z.boolean().optional(),
        }),
        inputAmount: nonNegativeBigintString,
        outputAmount: nonNegativeBigintString,
        rate: z.number().optional(),
        timeEstimateSeconds: z.number().optional(),
        fees: z.unknown().optional(),
        txs: z.array(
          z.object({
            to: z.string(),
            data: z.string(),
            value: nonNegativeBigintString,
            chainId: z.number(),
          }),
        ),
        raw: z.unknown(),
      }),
    })
    .optional(),
  eta: z
    .object({
      seconds: z.number().optional(),
      label: z.string(),
    })
    .optional(),
});

export const cashPairFillStatsJsonSchema = z
  .object({
    fills: z.number().int().nonnegative(),
    medianFillSeconds: z.number().int().nonnegative().optional(),
  })
  .strict();

export const cashFillStatsJsonSchema = z.record(z.string(), cashPairFillStatsJsonSchema);

export const preparedTransactionJsonSchema = z.object({
  to: z.string(),
  data: z.string(),
  value: nonNegativeBigintString,
  chainId: z.number(),
});

export const relayQuoteJsonSchema = z.object({
  requestId: z.string().optional(),
  source: cashAssetJsonSchema,
  destination: cashAssetJsonSchema,
  inputAmount: nonNegativeBigintString,
  outputAmount: nonNegativeBigintString,
  rate: z.number().optional(),
  timeEstimateSeconds: z.number().optional(),
  fees: z.unknown().optional(),
  txs: z.array(preparedTransactionJsonSchema),
  raw: z.unknown(),
});

export const relayStatusJsonSchema = z.object({
  requestId: z.string(),
  status: z.enum(['refund', 'waiting', 'depositing', 'failure', 'pending', 'submitted', 'success']),
  details: z.string().optional(),
  inTxHashes: z.array(z.string()),
  txHashes: z.array(z.string()),
  updatedAt: z.number().optional(),
  originChainId: z.number().optional(),
  destinationChainId: z.number().optional(),
  quoteCreatedAt: z.number().optional(),
  raw: z.unknown(),
});

export const relayExecutionResultJsonSchema = z.object({
  requestId: z.string().optional(),
  txHashes: z.array(z.string()),
  transactions: relayTransactionsJsonSchema.optional(),
  quote: z.unknown(),
});

export const cashPreparedStepJsonSchema = z.object({
  kind: z.enum([
    'approve',
    'createDeposit',
    'pruneExpiredIntents',
    'withdrawDeposit',
    'removeFunds',
    'addFunds',
  ]),
  description: z.string(),
});

export const cashoutResultJsonSchema = z.object({
  depositId: z.string(),
  txHash: z.string(),
  escrowAddress: z.string(),
  onchainDepositId: nonNegativeBigintString,
  order: cashOrderJsonSchema,
  source: z
    .object({
      amount: nonNegativeBigintString,
      requestId: z.string().optional(),
      txHashes: z.array(z.string()),
      transactions: relayTransactionsJsonSchema.optional(),
    })
    .optional(),
});

export const prepareResultJsonSchema = z.object({
  txs: z.array(preparedTransactionJsonSchema),
  steps: z.array(cashPreparedStepJsonSchema),
  register: z.object({ hashedOnchainIds: z.array(z.string()) }),
});

export const withdrawResultJsonSchema = z.object({
  depositId: z.string(),
  pruneTxHash: z.string().optional(),
  withdrawTxHash: z.string(),
});

export const topUpResultJsonSchema = z.object({
  depositId: z.string(),
  txHash: z.string(),
});

export const cashCapabilitiesJsonSchema = z.object({
  chainId: z.number(),
  token: z.object({ address: z.string(), symbol: z.literal('USDC'), decimals: z.number() }),
  environment: z.enum(['production', 'preproduction', 'staging']),
  destination: z.object({
    chainId: z.number(),
    token: z.object({ address: z.string(), symbol: z.literal('USDC'), decimals: z.number() }),
  }),
  source: z.object({
    default: z.object({
      chainId: z.number(),
      token: z.object({ address: z.string(), symbol: z.literal('USDC'), decimals: z.number() }),
    }),
    relay: cashSourceCapabilitiesJsonSchema.optional(),
  }),
  platforms: z.array(
    z.object({
      platform: z.string(),
      currencies: z.array(z.string()),
      payeeHint: z.string(),
      requiresIdentityAttestation: z.boolean(),
    }),
  ),
  currencies: z.array(z.string()),
  amount: z.object({
    min: nonNegativeBigintString,
    recommendedMin: nonNegativeBigintString,
    max: z.null(),
  }),
  pricing: z.object({ kind: z.literal('oracle-market-rate'), spreadBps: z.literal(0) }),
});

function defineCashErrorCodes<const Codes extends readonly [CashErrorCode, ...CashErrorCode[]]>(
  codes: Codes & ([CashErrorCode] extends [Codes[number]] ? unknown : never),
): Codes {
  return codes;
}

const CASH_ERROR_CODES = defineCashErrorCodes([
  'ORACLE_UNSUPPORTED_CURRENCY',
  'ORACLE_READ_FAILED',
  'UNSUPPORTED_PLATFORM',
  'UNSUPPORTED_PLATFORM_CURRENCY',
  'AMOUNT_BELOW_MINIMUM',
  'INVALID_INTENT_AMOUNT_RANGE',
  'ACTIVE_INTENT_BLOCKS_WITHDRAWAL',
  'NOTHING_TO_WITHDRAW',
  'INSUFFICIENT_AVAILABLE_FUNDS',
  'INSUFFICIENT_TOKEN_BALANCE',
  'ORDER_NOT_ACTIVE',
  'INVALID_DEPOSIT_ID',
  'ESCROW_PAUSED',
  'INDEXER_LAG',
  'INDEXER_UNAVAILABLE',
  'ORDER_NOT_FOUND',
  'PAYEE_REGISTRATION_FAILED',
  'PAYEE_VERIFICATION_REQUIRED',
  'SOURCE_ROUTE_UNSUPPORTED_IN_PREPARE',
  'SOURCE_RECIPIENT_MISMATCH',
  'SOURCE_CAPABILITIES_FAILED',
  'SOURCE_QUOTE_FAILED',
  'SOURCE_NONCE_MANAGER_REQUIRED',
  'SOURCE_EXECUTION_FAILED',
  'SOURCE_STATUS_FAILED',
  'SOURCE_ROUTE_COMPLETED_CASHOUT_FAILED',
  'SOURCE_CASHOUT_SUBMISSION_UNKNOWN',
  'SOURCE_CASHOUT_STATUS_UNKNOWN',
  'DEPOSIT_RESOLUTION_FAILED',
  'ALLOWANCE_NOT_VISIBLE',
  'SIGNER_REQUIRED',
  'SIGNER_CHAIN_MISMATCH',
  'SIGNER_CHAIN_UNAVAILABLE',
  'WATCH_TIMEOUT',
  'TRANSACTION_REJECTED',
  'TRANSACTION_FAILED',
  'TRANSACTION_SUBMISSION_UNKNOWN',
  'TRANSACTION_STATUS_UNKNOWN',
]);

const cashSourceRecoveryJsonShape = {
  amount: nonNegativeBigintString,
  requestId: z.string().optional(),
  txHashes: z.array(z.string()),
  transactions: relayTransactionsJsonSchema.optional(),
} as const;

export const cashErrorRecoveryJsonSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...cashSourceRecoveryJsonShape,
      kind: z.literal('retry-base-usdc-cashout'),
    })
    .strict(),
  z
    .object({
      ...cashSourceRecoveryJsonShape,
      kind: z.literal('inspect-base-cashout-transaction'),
      depositTxHash: z.string(),
    })
    .strict(),
  z
    .object({
      ...cashSourceRecoveryJsonShape,
      kind: z.literal('inspect-base-cashout-submission'),
      depositor: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('inspect-relay-route'),
      requestId: z.string().optional(),
      txHashes: z.array(z.string()),
      transactions: relayTransactionsJsonSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('inspect-base-operation-submission'),
      operation: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('inspect-base-transaction'),
      transactionHash: z.string(),
      operation: z.string(),
    })
    .strict(),
]);

export const cashErrorJsonSchema = z
  .object({
    code: z.enum(CASH_ERROR_CODES),
    message: z.string(),
    retryable: z.boolean(),
    remediation: z.string(),
    recovery: cashErrorRecoveryJsonSchema.optional(),
  })
  .strict();

export type CashOrderJson = z.infer<typeof cashOrderJsonSchema>;
export type CashFillJson = z.infer<typeof cashFillJsonSchema>;
export type CashEstimateJson = z.infer<typeof cashEstimateJsonSchema>;
export type CashFillStatsJson = z.infer<typeof cashFillStatsJsonSchema>;
export type PreparedTransactionJson = z.infer<typeof preparedTransactionJsonSchema>;
export type CashoutResultJson = z.infer<typeof cashoutResultJsonSchema>;
export type PrepareResultJson = z.infer<typeof prepareResultJsonSchema>;
export type WithdrawResultJson = z.infer<typeof withdrawResultJsonSchema>;
export type TopUpResultJson = z.infer<typeof topUpResultJsonSchema>;
export type CashPreparedStepJson = z.infer<typeof cashPreparedStepJsonSchema>;
export type CashPayoutInfoJson = z.infer<typeof cashPayoutInfoJsonSchema>;
export type CashBuyerProfileJson = z.infer<typeof cashBuyerProfileJsonSchema>;
export type CashCapabilitiesJson = z.infer<typeof cashCapabilitiesJsonSchema>;
export type RelayTransactionJson = z.infer<typeof relayTransactionJsonSchema>;
export type RelayTransactionsJson = z.infer<typeof relayTransactionsJsonSchema>;
export type CashAssetJson = z.infer<typeof cashAssetJsonSchema>;
export type CashChainJson = z.infer<typeof cashChainJsonSchema>;
export type CashSourceCapabilitiesJson = z.infer<typeof cashSourceCapabilitiesJsonSchema>;
export type RelayQuoteJson = z.infer<typeof relayQuoteJsonSchema>;
export type RelayStatusJson = z.infer<typeof relayStatusJsonSchema>;
export type RelayExecutionResultJson = z.infer<typeof relayExecutionResultJsonSchema>;
export type CashErrorRecoveryJson = z.infer<typeof cashErrorRecoveryJsonSchema>;
export type CashErrorJson = z.infer<typeof cashErrorJsonSchema>;
