import { getPaymentMethodsCatalog, resolvePaymentMethodHashFromCatalog } from '@zkp2p/sdk';
import type { RuntimeEnv } from '../sdk-types';

export interface CashCatalogFeatures {
  upi?: boolean;
}

type PaymentMethodCatalog = ReturnType<typeof getPaymentMethodsCatalog>;

export function getCashPaymentMethodsCatalog(
  environment: RuntimeEnv,
  features: CashCatalogFeatures = {},
): PaymentMethodCatalog {
  const catalog = getPaymentMethodsCatalog(8453, environment);
  if ((environment === 'staging' || environment === 'preproduction') && features.upi === true) {
    return catalog;
  }
  const enabledCatalog = { ...catalog };
  delete enabledCatalog.upi;
  return enabledCatalog as PaymentMethodCatalog;
}

export function resolveCashPaymentMethodHash(
  processorName: string,
  catalog: PaymentMethodCatalog,
): `0x${string}` {
  if (processorName.trim().toLowerCase() === 'upi' && !catalog.upi) {
    throw new Error('UPI is not enabled in this environment catalog');
  }
  return resolvePaymentMethodHashFromCatalog(processorName, catalog);
}
