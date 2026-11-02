import { SignJWT, jwtVerify } from 'jose';
import { sha256Hex } from '../utils/hash';
import { newOpaqueToken } from '../utils/ids';
import type { Role } from './types';

/**
 * Access tokens are stateless HS256 JWTs (short lived). Refresh tokens are
 * opaque random values; only their SHA-256 hash is persisted in `sessions`, so a
 * database disclosure cannot be used to mint sessions.
 */
export const TOKEN_AUDIENCE = 'aether-client';
export const TOKEN_TYPE = 'access';

export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: Role;
  sid: string;
}

const keyFor = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export async function signAccessToken(
  secret: string,
  claims: AccessTokenClaims,
  options: { ttlSeconds: number; issuer: string }
): Promise<{ token: string; expiresAt: number }> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + options.ttlSeconds;
  const token = await new SignJWT({ email: claims.email, role: claims.role, sid: claims.sid, typ: TOKEN_TYPE })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(options.issuer)
    .setAudience(TOKEN_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(keyFor(secret));
  return { token, expiresAt };
}

export interface VerifiedAccessToken extends AccessTokenClaims {
  issuedAt: number;
  expiresAt: number;
}

export async function verifyAccessToken(
  secret: string,
  token: string,
  issuer: string
): Promise<VerifiedAccessToken | null> {
  try {
    const { payload } = await jwtVerify(token, keyFor(secret), {
      issuer,
      audience: TOKEN_AUDIENCE,
      algorithms: ['HS256'],
    });
    if (payload.typ !== TOKEN_TYPE) return null;
    const sub = payload.sub;
    const sid = payload.sid;
    const role = payload.role;
    const email = payload.email;
    if (typeof sub !== 'string' || typeof sid !== 'string' || typeof role !== 'string' || typeof email !== 'string') {
      return null;
    }
    if (!['user', 'moderator', 'admin'].includes(role)) return null;
    return {
      sub,
      email,
      role: role as Role,
      sid,
      issuedAt: payload.iat ?? 0,
      expiresAt: payload.exp ?? 0,
    };
  } catch {
    return null;
  }
}

export interface RefreshToken {
  token: string;
  hash: string;
}

export function createRefreshToken(): RefreshToken {
  const token = newOpaqueToken(32);
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return sha256Hex(`aether-refresh-v1:${token}`);
}

/** Extracts a bearer token from an Authorization header value. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}
