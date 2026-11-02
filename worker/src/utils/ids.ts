/**
 * Identifier generation.
 *
 * IDs are time-ordered so that primary-key inserts stay sequential (good for
 * SQLite/D1 B-tree locality) while remaining unguessable and URL safe:
 *
 *   <prefix>_<10 chars of 48-bit millisecond timestamp><12 chars of randomness>
 *
 * Crockford base32 (no I, L, O, U) keeps IDs readable and case-insensitive-safe.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function encodeCrockford(value: number, length: number): string {
  let out = '';
  let remaining = value;
  for (let i = 0; i < length; i += 1) {
    out = ALPHABET[remaining % 32]! + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function randomChars(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i]! % 32];
  }
  return out;
}

export type IdPrefix =
  | 'usr'
  | 'ses'
  | 'art'
  | 'alb'
  | 'trk'
  | 'pl'
  | 'plt'
  | 'upl'
  | 'prv'
  | 'obj'
  | 'rpt'
  | 'aud'
  | 'px';

export function newId(prefix: IdPrefix | string): string {
  return `${prefix}_${encodeCrockford(Date.now(), 10)}${randomChars(12)}`;
}

/** Case-insensitive UUID v4-style id for non-sequential correlation values. */
export function newRequestId(): string {
  return crypto.randomUUID();
}

export function newOpaqueToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
