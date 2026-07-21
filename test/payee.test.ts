import { describe, expect, it } from 'vitest';
import { normalizeCashPayee } from '../src/client/payee';

describe('normalizeCashPayee', () => {
  it.each([
    ['venmo', '  @SellerTag  ', 'SellerTag'],
    ['cashapp', '  $SellerTag  ', 'SellerTag'],
    ['chime', '  $SellerTag  ', '$sellertag'],
    ['n26', ' user @ example.com ', 'user@example.com'],
    ['paypal', ' https://www.paypal.me/@SellerTag?locale=en ', 'sellertag'],
    ['zelle', ' Alice@Example.COM ', 'alice@example.com'],
  ])('normalizes %s raw input', (platform, input, offchainId) => {
    expect(normalizeCashPayee(platform, input)).toEqual({ offchainId });
  });

  it('preserves structured payee data for identity attestations', () => {
    const payee = {
      offchainId: 'WiseTag',
      identityAttestation: { signature: '0x1234' },
    } as never;

    expect(normalizeCashPayee('wise', payee)).toBe(payee);
  });
});
