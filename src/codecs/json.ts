/**
 * JSON codecs - lossless (de)serialization for every wire type. bigints encode
 * as decimal strings; `parse*` validates with the zod schema and re-attaches
 * derived behavior (`order.explain()`).
 */
import type { CurrencyType, PreparedTransaction } from '../sdk-types';
import type { CashBuyerProfile, CashFill, CashOrder } from '../engine/types';
import { withExplain, type CashOrderData } from '../engine/orderState';
import type { CashEstimate } from '../client/estimate';
import type { CashCapabilities } from '../client/capabilities';
import type {
  CashPreparedStep,
  CashoutResult,
  PrepareResult,
  TopUpResult,
  WithdrawResult,
} from '../client/createCashClient';
import {
  cashCapabilitiesJsonSchema,
  cashEstimateJsonSchema,
  cashOrderJsonSchema,
  cashoutResultJsonSchema,
  cashPreparedStepJsonSchema,
  prepareResultJsonSchema,
  preparedTransactionJsonSchema,
  withdrawResultJsonSchema,
  topUpResultJsonSchema,
  cashBuyerProfileJsonSchema,
  type CashBuyerProfileJson,
  type CashCapabilitiesJson,
  type CashEstimateJson,
  type CashFillJson,
  type CashOrderJson,
  type CashPreparedStepJson,
  type CashoutResultJson,
  type PrepareResultJson,
  type PreparedTransactionJson,
  type WithdrawResultJson,
  type TopUpResultJson,
} from './schemas';

function omitUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

// --- CashFill ---

export function fillToJson(fill: CashFill): CashFillJson {
  return omitUndefined({
    intentHash: fill.intentHash,
    status: fill.status,
    amount: fill.amount.toString(),
    buyer: fill.buyer,
    currency: fill.currency,
    currencyHash: fill.currencyHash,
    rate: fill.rate,
    conversionRate: fill.conversionRate?.toString(),
    fiatOwed: fill.fiatOwed,
    fiatPaid: fill.fiatPaid,
    paidCurrency: fill.paidCurrency,
    paymentId: fill.paymentId,
    paidAt: fill.paidAt,
    releasedAmount: fill.releasedAmount?.toString(),
    fillLatencySeconds: fill.fillLatencySeconds,
    isExpired: fill.isExpired,
    signaledAt: fill.signaledAt,
    expiresAt: fill.expiresAt,
    fulfilledAt: fill.fulfilledAt,
    prunedAt: fill.prunedAt,
  }) as CashFillJson;
}

export function fillFromJson(json: CashFillJson): CashFill {
  return omitUndefined({
    ...json,
    amount: BigInt(json.amount),
    conversionRate: json.conversionRate !== undefined ? BigInt(json.conversionRate) : undefined,
    releasedAmount: json.releasedAmount !== undefined ? BigInt(json.releasedAmount) : undefined,
  }) as unknown as CashFill;
}

// --- CashOrder ---

export function orderToJson(order: CashOrder): CashOrderJson {
  return omitUndefined({
    depositId: order.depositId,
    state: order.state,
    fills: order.fills.map(fillToJson),
    totalAmount: order.totalAmount.toString(),
    filledAmount: order.filledAmount.toString(),
    pendingAmount: order.pendingAmount.toString(),
    returnedAmount: order.returnedAmount.toString(),
    nextActions: order.nextActions,
    primaryIntentHash: order.primaryIntentHash,
    matchedAt: order.matchedAt,
    deliveredAt: order.deliveredAt,
    updatedAt: order.updatedAt,
    intentCount: order.intentCount,
    payouts: order.payouts?.map((p) =>
      omitUndefined({ ...p, pricing: omitUndefined({ ...p.pricing }) }),
    ),
    successRateBps: order.successRateBps,
    isInFlight: order.isInFlight,
    withdrawn: order.withdrawn,
  }) as CashOrderJson;
}

export function orderFromJson(json: unknown): CashOrder {
  const parsed = cashOrderJsonSchema.parse(json);
  const data = omitUndefined({
    ...parsed,
    fills: parsed.fills.map(fillFromJson),
    totalAmount: BigInt(parsed.totalAmount),
    filledAmount: BigInt(parsed.filledAmount),
    pendingAmount: BigInt(parsed.pendingAmount),
    returnedAmount: BigInt(parsed.returnedAmount),
  }) as unknown as CashOrderData;
  return withExplain(data);
}

// --- CashEstimate ---

export function estimateToJson(estimate: CashEstimate): CashEstimateJson {
  return omitUndefined({
    ...estimate,
    amount: estimate.amount.toString(),
    source: estimate.source
      ? {
          ...estimate.source,
          inputAmount: estimate.source.inputAmount.toString(),
          relayQuote: {
            ...estimate.source.relayQuote,
            inputAmount: estimate.source.relayQuote.inputAmount.toString(),
            outputAmount: estimate.source.relayQuote.outputAmount.toString(),
            txs: estimate.source.relayQuote.txs.map(preparedTxToJson),
          },
        }
      : undefined,
  }) as CashEstimateJson;
}

export function estimateFromJson(json: unknown): CashEstimate {
  const parsed = cashEstimateJsonSchema.parse(json);
  return omitUndefined({
    ...parsed,
    currency: parsed.currency as CurrencyType,
    amount: BigInt(parsed.amount),
    source: parsed.source
      ? {
          ...parsed.source,
          inputAmount: BigInt(parsed.source.inputAmount),
          relayQuote: {
            ...parsed.source.relayQuote,
            inputAmount: BigInt(parsed.source.relayQuote.inputAmount),
            outputAmount: BigInt(parsed.source.relayQuote.outputAmount),
            txs: parsed.source.relayQuote.txs.map(preparedTxFromJson),
          },
        }
      : undefined,
  }) as unknown as CashEstimate;
}

// --- PreparedTransaction ---

export function preparedTxToJson(tx: PreparedTransaction): PreparedTransactionJson {
  return { to: tx.to, data: tx.data, value: tx.value.toString(), chainId: tx.chainId };
}

export function preparedTxFromJson(json: unknown): PreparedTransaction {
  const parsed = preparedTransactionJsonSchema.parse(json);
  return {
    to: parsed.to as PreparedTransaction['to'],
    data: parsed.data as PreparedTransaction['data'],
    value: BigInt(parsed.value),
    chainId: parsed.chainId,
  };
}

export function preparedStepToJson(step: CashPreparedStep): CashPreparedStepJson {
  return { kind: step.kind, description: step.description };
}

export function preparedStepFromJson(json: unknown): CashPreparedStep {
  return cashPreparedStepJsonSchema.parse(json);
}

// --- CashoutResult ---

export function cashoutResultToJson(result: CashoutResult): CashoutResultJson {
  return omitUndefined({
    depositId: result.depositId,
    txHash: result.txHash,
    escrowAddress: result.escrowAddress,
    onchainDepositId: result.onchainDepositId.toString(),
    order: orderToJson(result.order),
    source: result.source
      ? {
          ...result.source,
          amount: result.source.amount.toString(),
        }
      : undefined,
  }) as CashoutResultJson;
}

export function cashoutResultFromJson(json: unknown): CashoutResult {
  const parsed = cashoutResultJsonSchema.parse(json);
  return omitUndefined({
    depositId: parsed.depositId,
    txHash: parsed.txHash as CashoutResult['txHash'],
    escrowAddress: parsed.escrowAddress,
    onchainDepositId: BigInt(parsed.onchainDepositId),
    order: orderFromJson(parsed.order),
    source: parsed.source
      ? {
          ...parsed.source,
          amount: BigInt(parsed.source.amount),
        }
      : undefined,
  }) as unknown as CashoutResult;
}

// --- PrepareResult ---

export function prepareResultToJson(result: PrepareResult): PrepareResultJson {
  return {
    txs: result.txs.map(preparedTxToJson),
    steps: result.steps.map(preparedStepToJson),
    register: result.register,
  };
}

export function prepareResultFromJson(json: unknown): PrepareResult {
  const parsed = prepareResultJsonSchema.parse(json);
  return {
    txs: parsed.txs.map(preparedTxFromJson),
    steps: parsed.steps.map(preparedStepFromJson),
    register: parsed.register,
  };
}

// --- WithdrawResult ---

export function withdrawResultToJson(result: WithdrawResult): WithdrawResultJson {
  return omitUndefined({
    depositId: result.depositId,
    pruneTxHash: result.pruneTxHash,
    withdrawTxHash: result.withdrawTxHash,
  }) as WithdrawResultJson;
}

export function withdrawResultFromJson(json: unknown): WithdrawResult {
  const parsed = withdrawResultJsonSchema.parse(json);
  return omitUndefined({
    depositId: parsed.depositId,
    pruneTxHash: parsed.pruneTxHash,
    withdrawTxHash: parsed.withdrawTxHash,
  }) as unknown as WithdrawResult;
}

// --- CashBuyerProfile ---

export function buyerProfileToJson(profile: CashBuyerProfile): CashBuyerProfileJson {
  return omitUndefined({ ...profile }) as CashBuyerProfileJson;
}

export function buyerProfileFromJson(json: unknown): CashBuyerProfile {
  return omitUndefined(cashBuyerProfileJsonSchema.parse(json)) as unknown as CashBuyerProfile;
}

// --- TopUpResult ---

export function topUpResultToJson(result: TopUpResult): TopUpResultJson {
  return { depositId: result.depositId, txHash: result.txHash };
}

export function topUpResultFromJson(json: unknown): TopUpResult {
  const parsed = topUpResultJsonSchema.parse(json);
  return { depositId: parsed.depositId, txHash: parsed.txHash as TopUpResult['txHash'] };
}

// --- CashCapabilities ---

export function capabilitiesToJson(caps: CashCapabilities): CashCapabilitiesJson {
  return {
    ...caps,
    amount: {
      min: caps.amount.min.toString(),
      recommendedMin: caps.amount.recommendedMin.toString(),
      max: null,
    },
  };
}

export function capabilitiesFromJson(json: unknown): CashCapabilities {
  const parsed = cashCapabilitiesJsonSchema.parse(json);
  return {
    ...parsed,
    source: {
      default: parsed.source.default,
      ...(parsed.source.relay ? { relay: parsed.source.relay } : {}),
    },
    platforms: parsed.platforms.map((p) => ({
      ...p,
      currencies: p.currencies as CurrencyType[],
    })),
    currencies: parsed.currencies as CurrencyType[],
    amount: {
      min: BigInt(parsed.amount.min),
      recommendedMin: BigInt(parsed.amount.recommendedMin),
      max: null,
    },
  } as unknown as CashCapabilities;
}
