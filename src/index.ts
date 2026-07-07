/**
 * `@zkp2p/cash` — Peer Cash: an offramp-only SDK for the ZKP2P protocol.
 *
 * Six verbs, every operation available as pure serializable data, a thin
 * opinionated facade over `@zkp2p/sdk`. A React app, a Node service, and an
 * AI agent are equal consumers.
 *
 * @packageDocumentation
 */

// The client — the six verbs
export { createCashClient } from './client/createCashClient';
export type {
  CashClient,
  CashClientOptions,
  CashLeg,
  CashoutInput,
  CashoutResult,
  PrepareResult,
  WithdrawResult,
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
export type { CashEstimate, EstimateInput } from './client/estimate';

// Typed errors
export { CashError, isCashError, errors } from './client/errors';
export type { CashErrorCode, CashErrorShape } from './client/errors';

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
