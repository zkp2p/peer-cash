/**
 * Coercion helpers for raw indexer values (string | number | null | missing).
 * Internal - not part of the public API.
 */

/** Coerce to bigint, treating null/undefined/empty/malformed as 0n. */
export function toBigInt(value: unknown): bigint {
  return toBigIntOrUndefined(value) ?? 0n;
}

/** Coerce to bigint, or undefined when absent/malformed (caller decides the fallback). */
export function toBigIntOrUndefined(value: unknown): bigint | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  try {
    return BigInt(typeof value === 'number' ? Math.trunc(value) : String(value));
  } catch {
    return undefined;
  }
}
