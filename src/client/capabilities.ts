/**
 * Discovery - sync, static. Platforms × currencies × pricing semantics ×
 * amount bounds × payee format hints, all derivable without a network call.
 */
import { getPaymentMethodsCatalog, getCurrencyCodeFromHash } from '@zkp2p/sdk';
import type { CurrencyType, RuntimeEnv } from '../sdk-types';
import { BASE_CHAIN_ID, BASE_USDC_ADDRESS, USDC_DECIMALS } from '../engine/constants';
import { isMarketRateSupported } from '../engine/marketRate';
import { isCreationRateCorridor } from './creationRate';
import type { CashSourceCapabilities } from './relay';
import type { NearIntentsSourceCapabilities } from './nearIntents';

/** Hard floor: below one cent a deposit is dust and can never fill. */
export const MIN_CASHOUT_AMOUNT = 10_000n; // $0.01
/** Recommended floor: sub-1-USDC deposits force min==max fills and starve matching. */
export const RECOMMENDED_MIN_CASHOUT_AMOUNT = 1_000_000n; // 1 USDC

/**
 * Payee handle format hints per platform, for input UX and agent validation.
 * Purely informational - the curator validates authoritatively at registration.
 */
const PAYEE_HINTS: Record<string, string> = {
  venmo: 'Venmo username, with or without the leading @ (e.g. @andrew-w)',
  cashapp: 'Cashtag, with or without the leading $ (e.g. $andrew)',
  revolut: 'Revtag (e.g. andrew1abc)',
  wise: 'Wisetag or the email on the Wise account',
  zelle: 'Email address or US phone number enrolled with Zelle',
  paypal: 'PayPal.Me handle or account email',
  mercadopago: 'Mercado Pago alias or CVU',
  monzo: 'Monzo.me username',
  chime: 'ChimeSign (e.g. $andrew)',
  luxon: 'Luxon Pay ID or account email',
  n26: 'MoneyBeam email or phone number',
  alipay: 'Email address linked to your Alipay account',
};

/**
 * Platforms whose curator payee registration requires a signed maker identity
 * attestation for a new handle. The SDK accepts but does not mint the
 * attestation; first-party Peer web obtains it through the Peer TEE browser
 * extension. An existing registered handle can be reused with bare payee data.
 */
const IDENTITY_ATTESTATION_PLATFORMS = new Set(['wise', 'paypal', 'alipay']);

export type CashCorridorPricing =
  | { kind: 'oracle-at-intent-signal'; spreadBps: 0 }
  | { kind: 'fixed-at-deposit-creation'; source: 'chainlink-ethereum'; spreadBps: 0 };

/** Whether a platform's curator registration needs a signed identity attestation. */
export function platformRequiresIdentityAttestation(platform: string): boolean {
  return IDENTITY_ATTESTATION_PLATFORMS.has(platform.toLowerCase());
}

export interface CashPlatformCapability {
  /** Platform id, e.g. `'venmo'` - the value `receive.platform` accepts. */
  platform: string;
  /** Supported currencies this platform can pay out. */
  currencies: CurrencyType[];
  /** Pricing semantics for each advertised currency. */
  pricing: Partial<Record<CurrencyType, CashCorridorPricing>>;
  /** Human hint for the payee handle format. */
  payeeHint: string;
  /**
   * When true, registering a payee for this platform requires a signed maker
   * identity attestation the SDK cannot produce. First-party Peer web obtains
   * it through the Peer TEE browser extension. Existing registrations can be
   * reused with bare payee data; a new bare handle throws
   * `PAYEE_VERIFICATION_REQUIRED`.
   */
  requiresIdentityAttestation: boolean;
  /**
   * @deprecated Always false. This does not report the sequential restricted-
   * platform policy; prepared hosts must inspect
   * `PrepareResult.accessPolicyPaymentMethods`.
   */
  requiresAtomicAccessPolicy: boolean;
}

export interface CashCapabilities {
  chainId: number;
  token: { address: string; symbol: 'USDC'; decimals: number };
  environment: RuntimeEnv;
  /** Destination asset for every Peer Cash order. */
  destination: { chainId: number; token: { address: string; symbol: 'USDC'; decimals: number } };
  /**
   * Source discovery. The sync default is Base USDC only; pass
   * `{ includeRelaySources: true }` or `{ includeNearIntentsSources: true }`
   * to `capabilities()` for live bridge source assets.
   */
  source: {
    default: { chainId: number; token: { address: string; symbol: 'USDC'; decimals: number } };
    relay?: CashSourceCapabilities;
    nearIntents?: NearIntentsSourceCapabilities;
  };
  /** Every payout corridor supported by the Cash product. */
  platforms: CashPlatformCapability[];
  /** All supported currencies across platforms. */
  currencies: CurrencyType[];
  /** Amount bounds in USDC base units. */
  amount: { min: bigint; recommendedMin: bigint; max: null };
  /** Default pricing for corridors without a platform-level creation-time exception. */
  pricing: { kind: 'oracle-market-rate'; spreadBps: 0 };
}

export function buildCapabilities(environment: RuntimeEnv): CashCapabilities {
  const catalog = getPaymentMethodsCatalog(BASE_CHAIN_ID, environment);

  const platforms: CashPlatformCapability[] = Object.entries(catalog)
    .map(([platform, entry]) => {
      const currencies = (entry.currencies ?? [])
        .map((hash) => getCurrencyCodeFromHash(hash))
        .filter(
          (code): code is CurrencyType =>
            code != null &&
            (isMarketRateSupported(code as CurrencyType) || isCreationRateCorridor(platform, code)),
        );
      const uniqueCurrencies = [...new Set(currencies)].sort();
      return {
        platform,
        currencies: uniqueCurrencies,
        pricing: Object.fromEntries(
          uniqueCurrencies.map((currency) => [
            currency,
            isCreationRateCorridor(platform, currency)
              ? {
                  kind: 'fixed-at-deposit-creation' as const,
                  source: 'chainlink-ethereum' as const,
                  spreadBps: 0 as const,
                }
              : { kind: 'oracle-at-intent-signal' as const, spreadBps: 0 as const },
          ]),
        ),
        payeeHint: PAYEE_HINTS[platform] ?? 'Your payment handle for this platform',
        requiresIdentityAttestation: IDENTITY_ATTESTATION_PLATFORMS.has(platform),
        requiresAtomicAccessPolicy: false,
      };
    })
    .filter((p) => p.currencies.length > 0)
    .sort((a, b) => a.platform.localeCompare(b.platform));

  const currencies = [...new Set(platforms.flatMap((p) => p.currencies))].sort();

  const baseUsdc = { address: BASE_USDC_ADDRESS, symbol: 'USDC' as const, decimals: USDC_DECIMALS };

  return {
    chainId: BASE_CHAIN_ID,
    token: baseUsdc,
    environment,
    destination: { chainId: BASE_CHAIN_ID, token: baseUsdc },
    source: { default: { chainId: BASE_CHAIN_ID, token: baseUsdc } },
    platforms,
    currencies,
    amount: { min: MIN_CASHOUT_AMOUNT, recommendedMin: RECOMMENDED_MIN_CASHOUT_AMOUNT, max: null },
    pricing: { kind: 'oracle-market-rate', spreadBps: 0 },
  };
}
