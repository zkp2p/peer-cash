/**
 * Peer Cash - payout-leg reconstruction from indexed deposit relations.
 *
 * A deposit's payment methods and per-method currency tuples live on-chain as
 * hashes. This decodes them back to human units (platform id, currency code)
 * via the protocol catalogs and surfaces the pricing state - including the
 * verifiable zero-spread invariant every cash order carries.
 */
import { getCurrencyCodeFromHash, resolvePaymentMethodNameFromHash } from '@zkp2p/sdk';
import type { PaymentMethodCatalog } from '@zkp2p/sdk';
import { toBigIntOrUndefined } from '../internal/convert';
import { rateToNumber } from './amounts';
import type { CashPayoutInfo, CashPayoutPricing } from './types';

/** The raw indexed shape of a deposit's payment method (relation row). */
export interface PaymentMethodLike {
  paymentMethodHash?: string | null;
  payeeDetailsHash?: string | null;
  active?: boolean | null;
}

/** The raw indexed shape of a per-method currency tuple (relation row). */
export interface MethodCurrencyLike {
  paymentMethodHash?: string | null;
  currencyCode?: string | null;
  spreadBps?: number | string | null;
  kind?: string | null;
  rateSource?: string | null;
  oracleRate?: string | number | bigint | null;
  lastOracleUpdatedAt?: string | number | null;
}

const ORACLE_KINDS = new Set(['oracle_chainlink', 'oracle_pyth']);

function toPricing(tuple: MethodCurrencyLike | undefined): CashPayoutPricing {
  if (!tuple) return { marketRate: false };

  const spreadBps = tuple.spreadBps != null ? Number(tuple.spreadBps) : undefined;
  const oracleRate = toBigIntOrUndefined(tuple.oracleRate);
  const lastOracleUpdatedAt =
    tuple.lastOracleUpdatedAt != null ? Number(tuple.lastOracleUpdatedAt) : undefined;

  return {
    ...(spreadBps !== undefined && Number.isFinite(spreadBps) ? { spreadBps } : {}),
    ...(tuple.kind != null ? { kind: tuple.kind } : {}),
    ...(tuple.rateSource != null ? { rateSource: tuple.rateSource } : {}),
    ...(oracleRate !== undefined && oracleRate > 0n
      ? { oracleRate: rateToNumber(oracleRate) }
      : {}),
    ...(lastOracleUpdatedAt !== undefined && Number.isFinite(lastOracleUpdatedAt)
      ? { lastOracleUpdatedAt }
      : {}),
    marketRate: spreadBps === 0 && tuple.kind != null && ORACLE_KINDS.has(tuple.kind),
  };
}

/**
 * Decode a deposit's payment methods + currency tuples into payout legs.
 * Pure - the environment arrives via the catalog. One leg per
 * (method, currency) pair; cash orders create exactly one in v1.
 */
export function derivePayouts(
  paymentMethods: ReadonlyArray<PaymentMethodLike>,
  currencies: ReadonlyArray<MethodCurrencyLike>,
  catalog: PaymentMethodCatalog,
): CashPayoutInfo[] {
  return paymentMethods.flatMap((method) => {
    const platformHash = method.paymentMethodHash ?? '';
    if (!platformHash) return [];

    let platform: string | undefined;
    try {
      platform = resolvePaymentMethodNameFromHash(platformHash, catalog);
    } catch {
      // Malformed / non-bytes32 hash - keep the raw value, no decoded name.
      platform = undefined;
    }
    const tuples = currencies.filter(
      (c) => (c.paymentMethodHash ?? '').toLowerCase() === platformHash.toLowerCase(),
    );
    const base = {
      ...(platform !== undefined ? { platform } : {}),
      platformHash,
      payeeHash: method.payeeDetailsHash ?? '',
      active: method.active ?? true,
    };

    if (tuples.length === 0) return [{ ...base, pricing: toPricing(undefined) }];

    return tuples.map((tuple) => {
      const currency =
        tuple.currencyCode != null ? getCurrencyCodeFromHash(tuple.currencyCode) : undefined;
      return {
        ...base,
        ...(currency !== undefined ? { currency } : {}),
        ...(tuple.currencyCode != null ? { currencyHash: tuple.currencyCode } : {}),
        pricing: toPricing(tuple),
      };
    });
  });
}
