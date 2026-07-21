/**
 * `@zkp2p/cash` - Peer Cash: an offramp-only SDK for the ZKP2P protocol.
 *
 * A resumable maker lifecycle, serializable wire formats, and a thin
 * opinionated facade over `@zkp2p/sdk`. A React app, a Node service, and an
 * agent host are equal consumers.
 *
 * @packageDocumentation
 */

// The client - the verbs
export { createCashClient, CASH_ATTRIBUTION_CODE } from './client/createCashClient';
export type {
  CashClient,
  CashClientOptions,
  CashLeg,
  CashMultiCurrencyLeg,
  CashPreparedStep,
  CashPreparedStepKind,
  CashoutInput,
  CashoutOptions,
  CashoutResult,
  PrepareResult,
  WithdrawResult,
  WithdrawOptions,
  TopUpResult,
  SignerOptions,
  WatchOptions,
  OrdersOptions,
} from './client/createCashClient';

// Discovery + estimate
export {
  buildCapabilities,
  MIN_CASHOUT_AMOUNT,
  RECOMMENDED_MIN_CASHOUT_AMOUNT,
} from './client/capabilities';
export type { CashCapabilities, CashPlatformCapability } from './client/capabilities';
export type { CashEstimate, EstimateInput, EstimateOptions } from './client/estimate';
export type {
  CashAsset,
  CashChain,
  CashSourceCapabilities,
  RelayExecutionResult,
  RelayOptions,
  RelayQuote,
  RelayQuoteInput,
  RelaySourceInput,
  RelayStatus,
  RelayTransaction,
} from './client/relay';
export type { CashFillEta, CashFillStats, CashPairFillStats } from './client/fillEta';

// Payee input normalization
export { normalizeCashPayee } from './client/payee';
export type { CashPayeeInput } from './client/payee';

// Typed errors
export { CashError, isCashError, isUserRejectedError, errors } from './client/errors';
export type { CashErrorCode, CashErrorRecovery, CashErrorShape } from './client/errors';

// Amount helpers
export { usdc, formatUsdc } from './engine/amounts';

// The pure engine
export * from './engine';

// Wire codecs (zod schemas + JSON round-trips)
export * from './codecs';

// SDK type re-exports integrators commonly need
export type {
  CurrencyType,
  CuratorPayeeDataInput,
  PreparedTransaction,
  RuntimeEnv,
} from './sdk-types';
