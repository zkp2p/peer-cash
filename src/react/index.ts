/**
 * `@zkp2p/cash/react` — optional hooks over the six verbs.
 *
 * React is an optional peer dependency; importing from the package root never
 * pulls it in. Build the client once (e.g. in a provider) with
 * `createCashClient` and pass it to the hooks.
 */
export { useEstimate } from './useEstimate';
export type { UseEstimateOptions } from './useEstimate';

export { useCashout } from './useCashout';
export type { UseCashoutOptions } from './useCashout';

export { useOrder } from './useOrder';
export type { UseOrderOptions } from './useOrder';

export { useOrders } from './useOrders';
export type { UseOrdersOptions } from './useOrders';
