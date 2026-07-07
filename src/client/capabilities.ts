/**
 * Discovery — sync, static. Platforms × currencies × oracle support × amount
 * bounds × payee format hints, all derivable without a network call.
 */
import { getPaymentMethodsCatalog, getCurrencyCodeFromHash } from '@zkp2p/sdk';
import type { CurrencyType, RuntimeEnv } from '../sdk-types';
import { BASE_CHAIN_ID, BASE_USDC_ADDRESS, USDC_DECIMALS } from '../engine/constants';
import { isMarketRateSupported } from '../engine/marketRate';

/** Hard floor: below one cent a deposit is dust and can never fill. */
export const MIN_CASHOUT_AMOUNT = 10_000n; // $0.01
/** Recommended floor: sub-1-USDC deposits force min==max fills and starve matching. */
export const RECOMMENDED_MIN_CASHOUT_AMOUNT = 1_000_000n; // 1 USDC

/**
 * Payee handle format hints per platform, for input UX and agent validation.
 * Purely informational — the curator validates authoritatively at registration.
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
};

/**
 * Platforms whose curator payee registration requires a signed maker identity
 * attestation — a bare handle is rejected. The attestation is produced by the
 * ZKP2P app / extension, not this SDK, so a cash-out to these platforms needs
 * the payee registered there first (see `PAYEE_VERIFICATION_REQUIRED`).
 */
const IDENTITY_ATTESTATION_PLATFORMS = new Set(['wise', 'paypal']);

/** Whether a platform's curator registration needs a signed identity attestation. */
export function platformRequiresIdentityAttestation(platform: string): boolean {
  return IDENTITY_ATTESTATION_PLATFORMS.has(platform);
}

export interface CashPlatformCapability {
  /** Platform id, e.g. `'venmo'` — the value `receive.platform` accepts. */
  platform: string;
  /** Market-rate (oracle-priced) currencies this platform can pay out. */
  currencies: CurrencyType[];
  /** Human hint for the payee handle format. */
  payeeHint: string;
  /**
   * When true, registering a payee for this platform requires a signed maker
   * identity attestation the SDK cannot produce — register the payee via the
   * ZKP2P app/extension first. A bare-handle `cashout()` throws
   * `PAYEE_VERIFICATION_REQUIRED`.
   */
  requiresIdentityAttestation: boolean;
}

export interface CashCapabilities {
  chainId: number;
  token: { address: string; symbol: 'USDC'; decimals: number };
  environment: RuntimeEnv;
  /** Every payout corridor: platform × oracle-priced currencies. */
  platforms: CashPlatformCapability[];
  /** All oracle-priced (market-rate) currencies across platforms. */
  currencies: CurrencyType[];
  /** Amount bounds in USDC base units. */
  amount: { min: bigint; recommendedMin: bigint; max: null };
  /** Pricing is always the live oracle at fill time — never a committed quote. */
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
            code != null && isMarketRateSupported(code as CurrencyType),
        );
      return {
        platform,
        currencies: [...new Set(currencies)],
        payeeHint: PAYEE_HINTS[platform] ?? 'Your payment handle for this platform',
        requiresIdentityAttestation: IDENTITY_ATTESTATION_PLATFORMS.has(platform),
      };
    })
    .filter((p) => p.currencies.length > 0)
    .sort((a, b) => a.platform.localeCompare(b.platform));

  const currencies = [...new Set(platforms.flatMap((p) => p.currencies))].sort();

  return {
    chainId: BASE_CHAIN_ID,
    token: { address: BASE_USDC_ADDRESS, symbol: 'USDC', decimals: USDC_DECIMALS },
    environment,
    platforms,
    currencies,
    amount: { min: MIN_CASHOUT_AMOUNT, recommendedMin: RECOMMENDED_MIN_CASHOUT_AMOUNT, max: null },
    pricing: { kind: 'oracle-market-rate', spreadBps: 0 },
  };
}
