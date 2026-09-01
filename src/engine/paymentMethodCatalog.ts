import {
  currencyInfo,
  getPaymentMethodsCatalog,
  resolvePaymentMethodHashFromCatalog,
} from '@zkp2p/sdk';
import type { RuntimeEnv } from '../sdk-types';

export interface CashCatalogFeatures {
  upi?: boolean;
}

export const UPI_STAGING_PAYMENT_METHOD_HASH =
  '0xe99a5081226cbbff9440a63da5caa04fa30f210c12c4dd9976132ac075054cd9' as const;

type PaymentMethodCatalog = ReturnType<typeof getPaymentMethodsCatalog>;

export function getCashPaymentMethodsCatalog(
  environment: RuntimeEnv,
  features: CashCatalogFeatures = {},
): PaymentMethodCatalog {
  const catalog = getPaymentMethodsCatalog(8453, environment);
  if (environment !== 'staging' || features.upi !== true || catalog.upi) {
    return catalog;
  }
  return {
    ...catalog,
    upi: {
      paymentMethodHash: UPI_STAGING_PAYMENT_METHOD_HASH,
      currencies: [currencyInfo.INR.currencyCodeHash as `0x${string}`],
      timestampBuffer: 30,
      providerHashes: [],
    },
  } as PaymentMethodCatalog;
}

export function resolveCashPaymentMethodHash(
  processorName: string,
  catalog: PaymentMethodCatalog,
): `0x${string}` {
  const normalized = processorName.trim().toLowerCase();
  if (normalized === 'upi' && catalog.upi) {
    return catalog.upi.paymentMethodHash;
  }
  return resolvePaymentMethodHashFromCatalog(processorName, catalog);
}
