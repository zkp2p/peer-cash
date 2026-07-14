import type { PaymentMethodCatalog } from '@zkp2p/sdk';

/**
 * Public platforms whose on-chain deposits attach more than one payment
 * method. The base method stays first; the remaining methods are internal
 * buyer routes that share the same maker payee details.
 */
const PLATFORM_METHOD_GROUPS = {
  zelle: ['zelle', 'zelle-chase', 'zelle-bofa', 'zelle-citi'],
} as const satisfies Record<string, readonly string[]>;

const METHOD_TO_BASE_PLATFORM = new Map<string, string>(
  Object.entries(PLATFORM_METHOD_GROUPS).flatMap(([platform, methods]) =>
    methods.map((method) => [method, platform] as const),
  ),
);

/** Collapse an internal bank-scoped method to the public platform id. */
export function basePlatformForMethod(method: string): string {
  return METHOD_TO_BASE_PLATFORM.get(method) ?? method;
}

/**
 * Resolve the on-chain payment methods attached for a public platform. Entries
 * absent from the active environment's core catalog are omitted defensively.
 */
export function paymentMethodsForPlatform(
  platform: string,
  catalog: PaymentMethodCatalog,
): string[] {
  const configured = PLATFORM_METHOD_GROUPS[platform as keyof typeof PLATFORM_METHOD_GROUPS];
  const methods = configured ?? [platform];
  return methods.filter((method) => catalog[method] !== undefined);
}
