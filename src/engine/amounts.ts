import { USDC_DECIMALS } from './constants';

/**
 * Convert a human USDC amount to base units (6 decimals).
 *
 * @example
 * usdc(1000)      // 1_000_000_000n
 * usdc('12.34')   // 12_340_000n
 */
export function usdc(amount: number | string): bigint {
  const text = typeof amount === 'number' ? amount.toString() : amount.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`Invalid USDC amount: '${amount}'`);
  }
  const [whole = '0', frac = ''] = text.split('.');
  if (frac.length > USDC_DECIMALS) {
    throw new Error(`USDC has ${USDC_DECIMALS} decimals; '${amount}' has too many`);
  }
  return (
    BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.padEnd(USDC_DECIMALS, '0') || '0')
  );
}

/** Format USDC base units back to a decimal string (no trailing zeros). */
export function formatUsdc(amount: bigint): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const whole = abs / 10n ** BigInt(USDC_DECIMALS);
  const frac = (abs % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, '0');
  const trimmed = frac.replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${trimmed ? `.${trimmed}` : ''}`;
}

/** Protocol rate precision — conversion rates are fiat-per-USDC scaled by 1e18. */
export const RATE_PRECISION = 10n ** 18n;

/**
 * Fiat owed for a USDC amount at a locked 1e18 conversion rate, in fiat base
 * units (6 decimals), rounded UP to the nearest cent — the same math the
 * protocol clients use, so the number matches what the buyer is told to pay.
 */
export function fiatFromUsdc(amount: bigint, conversionRate: bigint): bigint {
  const raw = (amount * conversionRate) / RATE_PRECISION;
  const penny = 10n ** BigInt(USDC_DECIMALS - 2);
  const remainder = raw % penny;
  return remainder > 0n ? raw - remainder + penny : raw;
}

/** Decode a 1e18 conversion rate to a plain number (fiat per USDC). */
export function rateToNumber(conversionRate: bigint): number {
  return Number(conversionRate) / 1e18;
}

/** Decode fiat base units (6 decimals) to a plain number. */
export function fiatToNumber(fiat: bigint): number {
  return Number(fiat) / 10 ** USDC_DECIMALS;
}

/** Decode fiat cents (verified `paymentAmount` precision) to a plain number. */
export function centsToNumber(cents: bigint): number {
  return Number(cents) / 100;
}
