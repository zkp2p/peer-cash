import { USDC_DECIMALS } from '../engine/constants';

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
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.padEnd(USDC_DECIMALS, '0') || '0');
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
