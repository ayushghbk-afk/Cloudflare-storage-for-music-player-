/**
 * Password hashing: PBKDF2-HMAC-SHA256 via WebCrypto.
 *
 * Stored format (self-describing so parameters can be upgraded later):
 *   pbkdf2-sha256$<iterations>$<salt base64url>$<derived key base64url>
 *
 * Operational note: 210k iterations costs roughly 100-250 ms of CPU. Cloudflare
 * Workers on the *free* plan only allow 10 ms CPU per request, so the auth
 * endpoints require the Workers Paid plan (see docs/DEPLOYMENT.md §costs).
 */
import { bytesToBase64Url, base64UrlToBytes } from '../utils/base64';
import { constantTimeEqual } from '../utils/hash';

const ALGORITHM = 'pbkdf2-sha256';
const DEFAULT_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const MIN_ITERATIONS = 50_000;
const MAX_ITERATIONS = 2_000_000;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    KEY_BYTES * 8
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = DEFAULT_ITERATIONS): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const derived = await derive(password, salt, iterations);
  return `${ALGORITHM}$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(derived)}`;
}

export interface PasswordVerifyResult {
  valid: boolean;
  /** True when the stored hash uses weaker parameters than the current default. */
  needsRehash: boolean;
}

export async function verifyPassword(password: string, stored: string): Promise<PasswordVerifyResult> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== ALGORITHM) {
    return { valid: false, needsRehash: false };
  }
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    return { valid: false, needsRehash: false };
  }
  let salt: Uint8Array;
  try {
    salt = base64UrlToBytes(parts[2]!);
  } catch {
    return { valid: false, needsRehash: false };
  }
  const expected = parts[3]!;
  const derived = await derive(password, salt, iterations);
  const actual = bytesToBase64Url(derived);
  return {
    valid: constantTimeEqual(actual, expected),
    needsRehash: iterations < DEFAULT_ITERATIONS,
  };
}
