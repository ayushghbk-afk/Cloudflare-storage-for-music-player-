import { notFound } from '../utils/errors';
import type { AppContext } from '../utils/http';
import { requireJwtSecret } from '../config';
import { canReadTrack, resolveUser } from '../auth/middleware';
import { verifyStreamToken } from './signed';
import type { TrackRow } from './serve';

/**
 * Media authorisation shared by audio and artwork endpoints.
 *
 * Playable/readable when the track is public+approved, OR the caller is staff or
 * the owner, OR a valid short-lived stream token is supplied. Everything else
 * answers 404 so private IDs cannot be enumerated.
 */
export async function authorizeMedia(c: AppContext, track: TrackRow): Promise<void> {
  const config = c.get('config');
  const expiresAt = Number(c.req.query('exp'));
  const signature = c.req.query('sig');

  if (signature && Number.isFinite(expiresAt) && config.jwtSecret) {
    const valid = await verifyStreamToken(requireJwtSecret(config), track.id, expiresAt, signature);
    if (valid) return;
  }

  const user = await resolveUser(c);
  if (canReadTrack(user ?? null, track)) return;

  throw notFound('Track not found.');
}

export function isPubliclyReadable(track: TrackRow): boolean {
  return (
    track.status === 'approved' &&
    track.visibility === 'public' &&
    track.is_deleted === 0 &&
    track.rights_confirmed === 1
  );
}

export function cacheControlFor(track: TrackRow): string {
  return isPubliclyReadable(track) ? 'public, max-age=3600' : 'private, no-store';
}
