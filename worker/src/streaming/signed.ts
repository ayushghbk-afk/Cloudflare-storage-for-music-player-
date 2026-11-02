/**
 * Short-lived playback tokens.
 *
 * Purpose: an `<audio>`/Media3 player cannot always send an `Authorization`
 * header (and re-authenticating a media element is awkward), so the API issues a
 * URL containing a signed, expiring token bound to one track ID.
 *
 * The token is an HMAC-SHA256 over a domain-separated message using a key derived
 * from JWT_SECRET, so it is not interchangeable with an access token.
 */
import { bytesToBase64Url, base64UrlToBytes } from '../utils/base64';
import { constantTimeEqual } from '../utils/hash';

const DOMAIN = 'aether:stream-url:v1';

async function deriveKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`${DOMAIN}:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return material;
}

function message(trackId: string, expiresAt: number): string {
  return `${DOMAIN}|${trackId}|${expiresAt}`;
}

export async function createStreamToken(
  secret: string,
  trackId: string,
  ttlSeconds: number
): Promise<{ expiresAt: number; token: string }> {
  const expiresAt = Math.floor(Date.now() / 1000) + Math.max(30, Math.trunc(ttlSeconds));
  const key = await deriveKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message(trackId, expiresAt)));
  return { expiresAt, token: bytesToBase64Url(new Uint8Array(signature)) };
}

export async function verifyStreamToken(
  secret: string,
  trackId: string,
  expiresAt: number,
  token: string
): Promise<boolean> {
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return false;
  if (expiresAt * 1000 > Date.now() + 1000 * 60 * 60 * 24 * 8) return false; // sanity bound
  const key = await deriveKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message(trackId, expiresAt)));
  let provided: Uint8Array;
  try {
    provided = base64UrlToBytes(token);
  } catch {
    return false;
  }
  const providedHex = Array.from(provided, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const expectedHex = Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return constantTimeEqual(providedHex, expectedHex);
}
