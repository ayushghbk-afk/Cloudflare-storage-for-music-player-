import { notFound, unavailable } from '../utils/errors';
import type { AppContext } from '../utils/http';
import { authorizeMedia, isPubliclyReadable } from './authz';
import { assertCopiesExist, loadObjectCandidates, loadStreamableTrack, resolveCopies } from './serve';

/**
 * Serve cover art for a track.
 *
 * Artwork is always proxied (never redirected): it is small, and proxying keeps a
 * single CORS/caching story for web and Android clients alike.
 */
export async function serveTrackArtwork(c: AppContext, trackId: string): Promise<Response> {
  const logger = c.get('logger');

  const track = await loadStreamableTrack(c.env.DB, trackId);
  if (!track || !track.artwork_key) throw notFound('Artwork not found.');
  await authorizeMedia(c, track);

  const candidates = await loadObjectCandidates(c.env.DB, track.id, 'artwork');
  if (candidates.length === 0) throw notFound('Artwork not found.');

  const { copies, failures } = await resolveCopies(c.env, c.env.DB, candidates, logger);
  assertCopiesExist(copies, failures);

  for (const copy of copies) {
    try {
      const object = await copy.adapter.get(copy.candidate.object_key);
      if (!object) continue;
      const mime = copy.candidate.content_type ?? track.artwork_mime ?? 'image/jpeg';
      return new Response(object.body, {
        status: 200,
        headers: {
          'content-type': mime,
          'content-length': String(object.size),
          'cache-control': isPubliclyReadable(track) ? 'public, max-age=31536000, immutable' : 'private, no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
        },
      });
    } catch (error) {
      logger.error('artwork_provider_failed', { trackId: track.id, providerId: copy.candidate.provider_id, error });
    }
  }

  throw unavailable('Artwork could not be read from storage.');
}

/** Resolve artwork for an album/playlist by delegating to a representative track. */
export async function artworkTrackForAlbum(c: AppContext, albumId: string): Promise<string | null> {
  const row = await c.env.DB.prepare(
    `SELECT id FROM tracks
      WHERE album_id = ? AND artwork_key IS NOT NULL AND status = 'approved' AND visibility = 'public'
        AND is_deleted = 0 AND rights_confirmed = 1
      ORDER BY disc_number ASC, track_number ASC, created_at ASC
      LIMIT 1`
  )
    .bind(albumId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function artworkTrackForPlaylist(c: AppContext, playlistId: string): Promise<string | null> {
  const row = await c.env.DB.prepare(
    `SELECT t.id
       FROM playlist_tracks pt
       JOIN tracks t ON t.id = pt.track_id
      WHERE pt.playlist_id = ? AND t.artwork_key IS NOT NULL
        AND t.status = 'approved' AND t.visibility = 'public' AND t.is_deleted = 0
      ORDER BY pt.position ASC
      LIMIT 1`
  )
    .bind(playlistId)
    .first<{ id: string }>();
  return row?.id ?? null;
}
