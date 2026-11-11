import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_BRANDS,
  ATTRIBUTION_BRAND_LOGO_MAX_LENGTH,
  assertAttributionBrands,
  findAttributionBrand,
  type AttributionBrand,
} from '../src/engine/attributionBrands';
import * as root from '../src/index';

const BAGS = 'bags-payout-bot';
const BUILDER_CODE = 'bc_example';

const brand = (overrides: Partial<AttributionBrand> = {}): AttributionBrand => ({
  code: 'acme-app',
  name: 'Acme',
  logo: 'data:image/png;base64,iVBORw0KGgo=',
  opensForFeeRecipients: false,
  xMoneyPaymentNote: null,
  ...overrides,
});

describe('findAttributionBrand', () => {
  it.each([
    [[BAGS]],
    [['peer-cash', BAGS, BUILDER_CODE]],
    [['peer-cash', 'peer-ref-ABC123', BAGS, BUILDER_CODE]],
    [['acme-unregistered', BUILDER_CODE, BAGS]],
  ])('returns Bags for %j', (codes) => {
    const found = findAttributionBrand(codes);
    expect(found).toMatchObject({
      code: BAGS,
      name: 'Bags',
      opensForFeeRecipients: true,
      xMoneyPaymentNote: 'sent via @BagsPay 💰',
    });
    expect(found?.logo.startsWith('data:image/png;base64,')).toBe(true);
  });

  it.each([[[]], [['peer-cash']], [['peer-cash', 'peer-ref-ABC123', BUILDER_CODE]], [['bags']]])(
    'returns undefined for %j',
    (codes) => {
      expect(findAttributionBrand(codes)).toBeUndefined();
    },
  );

  it('is exported from the package root', () => {
    expect(root.findAttributionBrand).toBe(findAttributionBrand);
    expect(root.ATTRIBUTION_BRANDS).toBe(ATTRIBUTION_BRANDS);
  });
});

describe('assertAttributionBrands', () => {
  it('passes every shipped entry', () => {
    expect(ATTRIBUTION_BRANDS.length).toBeGreaterThan(0);
    expect(() => assertAttributionBrands(ATTRIBUTION_BRANDS)).not.toThrow();
  });

  it('rejects a duplicate code', () => {
    expect(() => assertAttributionBrands([brand(), brand({ name: 'Other' })])).toThrow(
      'duplicate attribution brand code: acme-app',
    );
  });

  it.each(['', 'acme app', 'acme,app', 'acmeé', 'acme\n'])(
    'rejects code %j that is not ERC-8021 safe',
    (code) => {
      expect(() => assertAttributionBrands([brand({ code })])).toThrow('not ERC-8021 safe');
    },
  );

  it.each(['', '   '])('rejects empty name %j', (name) => {
    expect(() => assertAttributionBrands([brand({ name })])).toThrow('has an empty name');
  });

  it.each([
    'https://example.com/logo.png',
    '//example.com/logo.png',
    'data:image/jpeg;base64,/9j/',
    'data:text/html;base64,PGgxPg==',
  ])('rejects logo %j', (logo) => {
    expect(() => assertAttributionBrands([brand({ logo })])).toThrow(
      'logo is not a PNG or SVG data URI',
    );
  });

  it('accepts an SVG data URI', () => {
    const logo = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E';
    expect(() => assertAttributionBrands([brand({ logo })])).not.toThrow();
  });

  it('rejects a logo over the size bound', () => {
    const prefix = 'data:image/png;base64,';
    const atBound = prefix + 'A'.repeat(ATTRIBUTION_BRAND_LOGO_MAX_LENGTH - prefix.length);
    expect(() => assertAttributionBrands([brand({ logo: atBound })])).not.toThrow();
    expect(() => assertAttributionBrands([brand({ logo: `${atBound}A` })])).toThrow(
      `logo exceeds ${ATTRIBUTION_BRAND_LOGO_MAX_LENGTH} characters`,
    );
  });
});
