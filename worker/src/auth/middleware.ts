import type { D1Database } from '../platform';
import type { AppContext } from '../utils/http';
import { forbidden, unauthorized } from '../utils/errors';
import { requireJwtSecret } from '../config';
import { parseBearer, verifyAccessToken } from './tokens';
import { toAuthUser, type AuthUser, type Role, type UserRow, roleAtLeast } from './types';

/**
 * Resolve the caller from a bearer token (or `access_token` query parameter for
 * media endpoints where headers cannot be set).
 *
 * The token is only a hint: the authoritative role/status is re-read from D1 on
 * every request so that a demotion or suspension takes effect immediately rather
 * than when the JWT happens to expire.
 */
export async function resolveUser(c: AppContext, db: D1Database = c.env.DB): Promise<AuthUser | null> {
  const config = c.get('config');
  const header = c.req.header('authorization');
  const queryToken = c.req.query('access_token');
  const bearer = parseBearer(header) ?? (queryToken && queryToken.length > 0 ? queryToken : null);
  if (!bearer) return null;

  let secret: string;
  try {
    secret = requireJwtSecret(config);
  } catch {
    return null;
  }

  const claims = await verifyAccessToken(secret, bearer, config.issuer);
  if (!claims) return null;

  const row = await db
    .prepare('SELECT id, email, display_name, role, status FROM users WHERE id = ?')
    .bind(claims.sub)
    .first<Pick<UserRow, 'id' | 'email' | 'display_name' | 'role' | 'status'>>();
  if (!row || row.status !== 'active') return null;
  return toAuthUser(row);
}

export async function requireUser(c: AppContext): Promise<AuthUser> {
  const existing = c.get('user');
  if (existing) return existing;
  const resolved = await resolveUser(c);
  if (!resolved) throw unauthorized();
  c.set('user', resolved);
  return resolved;
}

export async function requireRole(c: AppContext, minimum: Role): Promise<AuthUser> {
  const user = await requireUser(c);
  if (!roleAtLeast(user.role, minimum)) throw forbidden();
  return user;
}

/** Admin-only helper. */
export const requireAdmin = (c: AppContext): Promise<AuthUser> => requireRole(c, 'admin');

/** Moderator-or-above helper. */
export const requireStaff = (c: AppContext): Promise<AuthUser> => requireRole(c, 'moderator');

/**
 * True when the caller may read a track: public+approved tracks are readable by
 * anyone, everything else only by its uploader or staff.
 */
export function canReadTrack(
  user: AuthUser | null,
  track: { uploader_id: string; status: string; visibility: string; is_deleted: number; rights_confirmed: number }
): boolean {
  const isPublic =
    track.status === 'approved' &&
    track.visibility === 'public' &&
    track.is_deleted === 0 &&
    track.rights_confirmed === 1;
  if (isPublic) return true;
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'moderator') return true;
  return track.uploader_id === user.id && track.is_deleted === 0;
}
