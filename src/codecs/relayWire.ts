import type { Execute } from '@relayprotocol/relay-sdk';

function isRelaySecretKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === 'headers' || normalized === 'apikey';
}

function redactRelayValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || value instanceof Error) return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const entry of value) output.push(redactRelayValue(entry, seen));
    return output;
  }
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, entry] of Object.entries(value)) {
    if (!isRelaySecretKey(key)) output[key] = redactRelayValue(entry, seen);
  }
  return output;
}

const RELAY_WIRE_TYPE = '__zkp2pCashType';

export function sanitizeRelayValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'bigint') {
    return { [RELAY_WIRE_TYPE]: 'bigint', value: value.toString() };
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : { [RELAY_WIRE_TYPE]: 'number', value: String(value) };
  }
  if (typeof value === 'undefined') return { [RELAY_WIRE_TYPE]: 'undefined' };
  if (value instanceof Date) {
    return { [RELAY_WIRE_TYPE]: 'date', value: value.toISOString() };
  }
  if (value instanceof Error) {
    return {
      [RELAY_WIRE_TYPE]: 'error',
      name: value.name,
      message: value.message,
    };
  }
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) throw new TypeError('Relay payload contains a circular reference');
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((entry) => sanitizeRelayValue(entry, seen));
    seen.delete(value);
    return output;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    // Relay request headers can contain API credentials and are never needed
    // to resume, inspect, or serialize a quote.
    if (isRelaySecretKey(key)) continue;
    const sanitized = sanitizeRelayValue(entry, seen);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  seen.delete(value);
  return output;
}

export function restoreRelayValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restoreRelayValue);
  if (value === null || typeof value !== 'object') return value;
  const row = value as Record<string, unknown>;
  const wireType = row[RELAY_WIRE_TYPE];
  const keyCount = Object.keys(row).length;
  if (keyCount === 2 && wireType === 'bigint' && typeof row.value === 'string') {
    return BigInt(row.value);
  }
  if (keyCount === 2 && wireType === 'date' && typeof row.value === 'string') {
    return new Date(row.value);
  }
  if (keyCount === 2 && wireType === 'number' && typeof row.value === 'string') {
    return Number(row.value);
  }
  if (keyCount === 1 && wireType === 'undefined') return undefined;
  if (keyCount === 3 && wireType === 'error' && typeof row.message === 'string') {
    const error = new Error(row.message);
    if (typeof row.name === 'string') error.name = row.name;
    return error;
  }
  return Object.fromEntries(
    Object.entries(row).map(([key, entry]) => [key, restoreRelayValue(entry)]),
  );
}

/** Deeply remove Relay request credentials without changing runtime value types. */
export function redactRelayQuoteRaw(quote: Execute): Execute {
  return redactRelayValue(quote) as Execute;
}

/** Remove Relay credentials and encode non-JSON values for a lossless wire round-trip. */
export function sanitizeRelayQuoteRaw(quote: Execute): unknown {
  return sanitizeRelayValue(quote);
}

/** Restore a Relay Execute payload produced by {@link sanitizeRelayQuoteRaw}. */
export function restoreRelayQuoteRaw(value: unknown): Execute {
  return restoreRelayValue(value) as Execute;
}
