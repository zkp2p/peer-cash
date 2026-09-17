import { getPaymentMethodsCatalog, resolvePaymentMethodHashFromCatalog } from '@zkp2p/sdk';
import type { RuntimeEnv } from '../sdk-types';

type PaymentMethodCatalog = ReturnType<typeof getPaymentMethodsCatalog>;

export function getCashPaymentMethodsCatalog(environment: RuntimeEnv): PaymentMethodCatalog {
  return getPaymentMethodsCatalog(8453, environment);
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
