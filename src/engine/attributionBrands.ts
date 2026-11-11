/**
 * Attribution brands: the display identity behind an ERC-8021 attribution code.
 *
 * A deposit carries only its attribution codes on chain. Clients that list
 * deposits (Peer's order book) look the codes up here to show who opened the
 * deposit. Entries are added by pull request to this package, so every logo is
 * reviewed and bundled; nothing is fetched at runtime. A code is unauthenticated
 * (any maker can stamp any code), so a brand label is attribution, not
 * verification of the maker.
 */

export interface AttributionBrand {
  /** ERC-8021 code the integrator passes as `referrer`. */
  readonly code: string;
  /** Display name, e.g. in "<name> fee recipient". */
  readonly name: string;
  /** Square PNG or SVG logo as a `data:` URI, at most {@link ATTRIBUTION_BRAND_LOGO_MAX_LENGTH} characters. */
  readonly logo: string;
  /** Deposits are opened for the integrator's fee recipients rather than by the integrator itself. */
  readonly opensForFeeRecipients: boolean;
  /** Note a buyer types into an X Money payment (X Money cannot prefill one), or `null` for none. */
  readonly xMoneyPaymentNote: string | null;
}

/** Upper bound on a logo data URI, so the registry stays small in every bundle. */
export const ATTRIBUTION_BRAND_LOGO_MAX_LENGTH = 16_384;

const LOGO_PREFIXES = [
  'data:image/png;base64,',
  'data:image/svg+xml;base64,',
  'data:image/svg+xml,',
];
// ERC-8021 schema 0 joins codes with commas: printable ASCII, no space or comma.
const ERC8021_CODE_RE = /^[\x21-\x2b\x2d-\x7e]+$/;

/** Registered brands. Add an entry (code, name, 64x64 logo) by pull request. */
export const ATTRIBUTION_BRANDS: readonly AttributionBrand[] = [
  {
    code: 'bags-payout-bot',
    name: 'Bags',
    logo: 'data:image/png;base64,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',
    opensForFeeRecipients: true,
    xMoneyPaymentNote: 'sent via @BagsPay 💰',
  },
];

/** Throws on the first entry a client must not render: a duplicate or unsafe code, empty name, or non-inline or oversized logo. */
export function assertAttributionBrands(brands: readonly AttributionBrand[]): void {
  const codes = new Set<string>();
  for (const brand of brands) {
    if (!ERC8021_CODE_RE.test(brand.code)) {
      throw new Error(`attribution brand code is not ERC-8021 safe: ${JSON.stringify(brand.code)}`);
    }
    if (codes.has(brand.code)) {
      throw new Error(`duplicate attribution brand code: ${brand.code}`);
    }
    codes.add(brand.code);
    if (brand.name.trim() === '') {
      throw new Error(`attribution brand ${brand.code} has an empty name`);
    }
    if (!LOGO_PREFIXES.some((prefix) => brand.logo.startsWith(prefix))) {
      throw new Error(`attribution brand ${brand.code} logo is not a PNG or SVG data URI`);
    }
    if (brand.logo.length > ATTRIBUTION_BRAND_LOGO_MAX_LENGTH) {
      throw new Error(
        `attribution brand ${brand.code} logo exceeds ${ATTRIBUTION_BRAND_LOGO_MAX_LENGTH} characters`,
      );
    }
  }
}

const BRANDS_BY_CODE = new Map(ATTRIBUTION_BRANDS.map((brand) => [brand.code, brand]));

/** The brand of the first registered code in a deposit's attribution codes, in order, or `undefined`. */
export function findAttributionBrand(
  attributionCodes: readonly string[],
): AttributionBrand | undefined {
  for (const code of attributionCodes) {
    const brand = BRANDS_BY_CODE.get(code);
    if (brand) return brand;
  }
  return undefined;
}
