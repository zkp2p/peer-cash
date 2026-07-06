/**
 * zod schemas for every wire type. The wire format encodes bigints as decimal
 * strings so orders, estimates, and prepared txs cross tool-call and process
 * boundaries losslessly.
 */
import { z } from 'zod';

export const bigintString = z.string().regex(/^-?\d+$/, 'expected a decimal bigint string');

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
  amount: bigintString,
  buyer: z.string(),
  fiatCurrency: z.string().optional(),
  signaledAt: z.number().optional(),
  expiresAt: z.number().optional(),
  fulfilledAt: z.number().optional(),
  prunedAt: z.number().optional(),
});

export const cashOrderJsonSchema = z.object({
  depositId: z.string(),
  state: cashOrderStateSchema,
  fills: z.array(cashFillJsonSchema),
  totalAmount: bigintString,
  filledAmount: bigintString,
  pendingAmount: bigintString,
  returnedAmount: bigintString,
  nextActions: z.array(cashNextActionSchema),
  primaryIntentHash: z.string().optional(),
  matchedAt: z.number().optional(),
  deliveredAt: z.number().optional(),
  updatedAt: z.number().optional(),
  intentCount: z.number().optional(),
  isInFlight: z.boolean(),
  withdrawn: z.boolean().optional(),
});

export const cashEstimateJsonSchema = z.object({
  kind: z.literal('oracle-estimate'),
  currency: z.string(),
  amount: bigintString,
  rate: z.number(),
  receiveAmount: z.number(),
  asOf: z.number(),
});

export const preparedTransactionJsonSchema = z.object({
  to: z.string(),
  data: z.string(),
  value: bigintString,
  chainId: z.number(),
});

export const cashoutResultJsonSchema = z.object({
  depositId: z.string(),
  txHash: z.string(),
  escrowAddress: z.string(),
  onchainDepositId: bigintString,
  order: cashOrderJsonSchema,
});

export const prepareResultJsonSchema = z.object({
  txs: z.array(preparedTransactionJsonSchema),
  register: z.object({ hashedOnchainIds: z.array(z.string()) }),
});

export const withdrawResultJsonSchema = z.object({
  depositId: z.string(),
  pruneTxHash: z.string().optional(),
  withdrawTxHash: z.string(),
});

export const cashCapabilitiesJsonSchema = z.object({
  chainId: z.number(),
  token: z.object({ address: z.string(), symbol: z.literal('USDC'), decimals: z.number() }),
  environment: z.enum(['production', 'preproduction', 'staging']),
  platforms: z.array(
    z.object({
      platform: z.string(),
      currencies: z.array(z.string()),
      payeeHint: z.string(),
    }),
  ),
  currencies: z.array(z.string()),
  amount: z.object({ min: bigintString, recommendedMin: bigintString, max: z.null() }),
  pricing: z.object({ kind: z.literal('oracle-market-rate'), spreadBps: z.literal(0) }),
});

export const cashErrorJsonSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  remediation: z.string(),
});

export type CashOrderJson = z.infer<typeof cashOrderJsonSchema>;
export type CashFillJson = z.infer<typeof cashFillJsonSchema>;
export type CashEstimateJson = z.infer<typeof cashEstimateJsonSchema>;
export type PreparedTransactionJson = z.infer<typeof preparedTransactionJsonSchema>;
export type CashoutResultJson = z.infer<typeof cashoutResultJsonSchema>;
export type PrepareResultJson = z.infer<typeof prepareResultJsonSchema>;
export type WithdrawResultJson = z.infer<typeof withdrawResultJsonSchema>;
export type CashCapabilitiesJson = z.infer<typeof cashCapabilitiesJsonSchema>;
