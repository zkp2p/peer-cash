/**
 * JSON codecs - lossless (de)serialization for every wire type. bigints encode
 * as decimal strings; `parse*` validates with the zod schema and re-attaches
 * derived behavior (`order.explain()`).
 */
import type { CurrencyType, PreparedTransaction } from '../sdk-types';
import type { CashBuyerProfile, CashFill, CashOrder } from '../engine/types';
import { withExplain, type CashOrderData } from '../engine/orderState';
import type { CashEstimate } from '../client/estimate';
import {
  restoreRelayQuoteRaw,
  restoreRelayValue,
  sanitizeRelayQuoteRaw,
  sanitizeRelayValue,
} from './relayWire';
import type {
  CashAsset,
  CashSourceCapabilities,
  RelayExecutionResult,
  RelayQuote,
  RelayStatus,
} from '../client/relay';
import type { CashCapabilities } from '../client/capabilities';
import { CashError, type CashErrorRecovery, type CashErrorShape } from '../client/errors';
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
  cashFillJsonSchema,
  cashOrderJsonSchema,
  cashSourceCapabilitiesJsonSchema,
  relayQuoteJsonSchema,
  relayExecutionResultJsonSchema,
  relayStatusJsonSchema,
  cashoutResultJsonSchema,
  cashPreparedStepJsonSchema,
  prepareResultJsonSchema,
  preparedTransactionJsonSchema,
  withdrawResultJsonSchema,
  topUpResultJsonSchema,
  cashBuyerProfileJsonSchema,
  cashErrorJsonSchema,
  type CashBuyerProfileJson,
  type CashAssetJson,
  type CashCapabilitiesJson,
  type CashEstimateJson,
  type CashErrorJson,
  type CashFillJson,
  type CashOrderJson,
  type CashSourceCapabilitiesJson,
  type RelayQuoteJson,
  type RelayExecutionResultJson,
  type RelayStatusJson,
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

export function fillFromJson(json: unknown): CashFill {
  const parsed = cashFillJsonSchema.parse(json);
  return omitUndefined({
    ...parsed,
    amount: BigInt(parsed.amount),
    conversionRate: parsed.conversionRate !== undefined ? BigInt(parsed.conversionRate) : undefined,
    releasedAmount: parsed.releasedAmount !== undefined ? BigInt(parsed.releasedAmount) : undefined,
  }) as unknown as CashFill;
}

// --- CashOrder ---

export function orderToJson(order: CashOrder): CashOrderJson {
  return cashOrderJsonSchema.parse(
    omitUndefined({
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
    }),
  );
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
            ...(estimate.source.relayQuote.fees !== undefined
              ? { fees: sanitizeRelayValue(estimate.source.relayQuote.fees) }
              : {}),
            raw: sanitizeRelayQuoteRaw(estimate.source.relayQuote.raw),
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
            ...(parsed.source.relayQuote.fees !== undefined
              ? { fees: restoreRelayValue(parsed.source.relayQuote.fees) }
              : {}),
            raw: restoreRelayQuoteRaw(parsed.source.relayQuote.raw),
          },
        }
      : undefined,
  }) as unknown as CashEstimate;
}

// --- RelayQuote ---

function cashAssetFromJson(asset: CashAssetJson): CashAsset {
  return {
    chainId: asset.chainId,
    address: asset.address,
    symbol: asset.symbol,
    decimals: asset.decimals,
    ...(asset.name !== undefined ? { name: asset.name } : {}),
    ...(asset.isNative !== undefined ? { isNative: asset.isNative } : {}),
  };
}

export function relayQuoteToJson(quote: RelayQuote): RelayQuoteJson {
  return relayQuoteJsonSchema.parse({
    ...(quote.requestId !== undefined ? { requestId: quote.requestId } : {}),
    source: quote.source,
    destination: quote.destination,
    inputAmount: quote.inputAmount.toString(),
    outputAmount: quote.outputAmount.toString(),
    ...(quote.rate !== undefined ? { rate: quote.rate } : {}),
    ...(quote.timeEstimateSeconds !== undefined
      ? { timeEstimateSeconds: quote.timeEstimateSeconds }
      : {}),
    ...(quote.fees !== undefined ? { fees: sanitizeRelayValue(quote.fees) } : {}),
    txs: quote.txs.map(preparedTxToJson),
    raw: sanitizeRelayQuoteRaw(quote.raw),
  });
}

export function relayQuoteFromJson(json: unknown): RelayQuote {
  const parsed = relayQuoteJsonSchema.parse(json);
  return {
    ...(parsed.requestId !== undefined ? { requestId: parsed.requestId } : {}),
    source: cashAssetFromJson(parsed.source),
    destination: cashAssetFromJson(parsed.destination),
    inputAmount: BigInt(parsed.inputAmount),
    outputAmount: BigInt(parsed.outputAmount),
    ...(parsed.rate !== undefined ? { rate: parsed.rate } : {}),
    ...(parsed.timeEstimateSeconds !== undefined
      ? { timeEstimateSeconds: parsed.timeEstimateSeconds }
      : {}),
    ...(parsed.fees !== undefined ? { fees: restoreRelayValue(parsed.fees) } : {}),
    txs: parsed.txs.map(preparedTxFromJson),
    raw: restoreRelayQuoteRaw(parsed.raw),
  };
}

export function sourceCapabilitiesToJson(
  capabilities: CashSourceCapabilities,
): CashSourceCapabilitiesJson {
  return cashSourceCapabilitiesJsonSchema.parse(capabilities);
}

export function sourceCapabilitiesFromJson(json: unknown): CashSourceCapabilities {
  const parsed = cashSourceCapabilitiesJsonSchema.parse(json);
  return {
    destination: cashAssetFromJson(parsed.destination),
    chains: parsed.chains.map((chain) => ({
      id: chain.id,
      name: chain.name,
      displayName: chain.displayName,
      disabled: chain.disabled,
      depositEnabled: chain.depositEnabled,
      blockProductionLagging: chain.blockProductionLagging,
      ...(chain.vmType !== undefined ? { vmType: chain.vmType } : {}),
      tokens: chain.tokens.map(cashAssetFromJson),
    })),
    source: parsed.source,
    asOf: parsed.asOf,
  };
}

export function relayStatusToJson(status: RelayStatus): RelayStatusJson {
  return relayStatusJsonSchema.parse({ ...status, raw: sanitizeRelayValue(status.raw) });
}

export function relayStatusFromJson(json: unknown): RelayStatus {
  const parsed = relayStatusJsonSchema.parse(json);
  return {
    requestId: parsed.requestId,
    status: parsed.status,
    ...(parsed.details !== undefined ? { details: parsed.details } : {}),
    inTxHashes: parsed.inTxHashes,
    txHashes: parsed.txHashes,
    ...(parsed.updatedAt !== undefined ? { updatedAt: parsed.updatedAt } : {}),
    ...(parsed.originChainId !== undefined ? { originChainId: parsed.originChainId } : {}),
    ...(parsed.destinationChainId !== undefined
      ? { destinationChainId: parsed.destinationChainId }
      : {}),
    ...(parsed.quoteCreatedAt !== undefined ? { quoteCreatedAt: parsed.quoteCreatedAt } : {}),
    raw: restoreRelayValue(parsed.raw),
  };
}

export function relayExecutionResultToJson(result: RelayExecutionResult): RelayExecutionResultJson {
  return relayExecutionResultJsonSchema.parse({
    ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
    txHashes: result.txHashes,
    ...(result.transactions !== undefined ? { transactions: result.transactions } : {}),
    quote: sanitizeRelayQuoteRaw(result.quote),
  });
}

export function relayExecutionResultFromJson(json: unknown): RelayExecutionResult {
  const parsed = relayExecutionResultJsonSchema.parse(json);
  return {
    ...(parsed.requestId !== undefined ? { requestId: parsed.requestId } : {}),
    txHashes: parsed.txHashes,
    ...(parsed.transactions !== undefined ? { transactions: parsed.transactions } : {}),
    quote: restoreRelayQuoteRaw(parsed.quote),
  };
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

// --- CashError ---

export function cashErrorToJson(error: CashErrorShape): CashErrorJson {
  return cashErrorJsonSchema.parse({
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    remediation: error.remediation,
    ...(error.recovery ? { recovery: error.recovery } : {}),
  });
}

export function cashErrorFromJson(json: unknown): CashError {
  const parsed = cashErrorJsonSchema.parse(json);
  let recovery: CashErrorRecovery | undefined;
  if (parsed.recovery) {
    if (parsed.recovery.kind === 'inspect-base-transaction') {
      recovery = {
        kind: parsed.recovery.kind,
        transactionHash: parsed.recovery.transactionHash,
        operation: parsed.recovery.operation,
      };
    } else if (parsed.recovery.kind === 'inspect-base-operation-submission') {
      recovery = {
        kind: parsed.recovery.kind,
        operation: parsed.recovery.operation,
      };
    } else if (parsed.recovery.kind === 'inspect-relay-route') {
      recovery = {
        kind: parsed.recovery.kind,
        txHashes: parsed.recovery.txHashes,
        ...(parsed.recovery.requestId !== undefined
          ? { requestId: parsed.recovery.requestId }
          : {}),
        ...(parsed.recovery.transactions !== undefined
          ? { transactions: parsed.recovery.transactions }
          : {}),
      };
    } else {
      const common = {
        amount: parsed.recovery.amount,
        txHashes: parsed.recovery.txHashes,
        ...(parsed.recovery.requestId !== undefined
          ? { requestId: parsed.recovery.requestId }
          : {}),
        ...(parsed.recovery.transactions !== undefined
          ? { transactions: parsed.recovery.transactions }
          : {}),
      };
      if (parsed.recovery.kind === 'retry-base-usdc-cashout') {
        recovery = { ...common, kind: parsed.recovery.kind };
      } else if (parsed.recovery.kind === 'inspect-base-cashout-submission') {
        recovery = {
          ...common,
          kind: parsed.recovery.kind,
          depositor: parsed.recovery.depositor,
        };
      } else {
        recovery = {
          ...common,
          kind: parsed.recovery.kind,
          depositTxHash: parsed.recovery.depositTxHash,
        };
      }
    }
  }
  return new CashError({
    code: parsed.code,
    message: parsed.message,
    retryable: parsed.retryable,
    remediation: parsed.remediation,
    ...(recovery ? { recovery } : {}),
  });
}
