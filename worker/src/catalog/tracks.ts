import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { notFound } from '../utils/errors';
import { pagination } from '../utils/http';
import { escapeLike, likePattern } from '../utils/text';
import { resolveUser, canReadTrack } from '../auth/middleware';
import {
  MODERATED_TRACK_SELECT,
  TRACK_SELECT,
  serializeModeratedTrack,
  serializeTrack,
  type TrackRowJoined,
} from './serialize';

export const trackRoutes = new Hono<AppEnv>();

const SORTS: Record<string, string> = {
  recent: 't.published_at DESC, t.created_at DESC',
  oldest: 't.created_at ASC',
  title: 't.title_normalized ASC',
  artist: 't.artist_id ASC, t.title_normalized ASC',
  plays: 't.play_count DESC, t.created_at DESC',
  duration: 't.duration_ms DESC',
};

/**
 * GET /api/tracks
 *
 * Public browsing by default. `mine=1` returns the caller's own uploads in every
 * moderation state; `status=` is honoured for staff only.
 */
trackRoutes.get('/', async (c) => {
  const user = await resolveUser(c);
  const { limit, offset } = pagination(c);
  const isStaff = user?.role === 'admin' || user?.role === 'moderator';
  const mine = c.req.query('mine') === '1' || c.req.query('mine') === 'true';
  const requestedStatus = c.req.query('status');
  const q = c.req.query('q');
  const artistId = c.req.query('artistId') ?? c.req.query('artist');
  const albumId = c.req.query('albumId') ?? c.req.query('album');
  const genre = c.req.query('genre');
  const format = c.req.query('format');
  const sort = SORTS[c.req.query('sort') ?? 'recent'] ?? SORTS.recent;

  if (mine && !user) {
    // Anonymous "mine" is meaningless; return an empty page rather than leaking.
    return c.json({ tracks: [], pagination: { total: 0, limit, offset } });
  }

  const where: string[] = [];
  const bindings: unknown[] = [];

  if (mine && user) {
    where.push('t.uploader_id = ?', 't.is_deleted = 0');
    bindings.push(user.id);
  } else if (isStaff && requestedStatus) {
    where.push('t.status = ?', 't.is_deleted = 0');
    bindings.push(requestedStatus);
  } else {
    where.push("t.status = 'approved'", "t.visibility = 'public'", 't.is_deleted = 0', 't.rights_confirmed = 1');
  }

  if (q && q.trim().length > 0) {
    const pattern = likePattern(q);
    where.push(
      '(t.title_normalized LIKE ? ESCAPE \'\\\' OR a.name_normalized LIKE ? ESCAPE \'\\\' OR al.title_normalized LIKE ? ESCAPE \'\\\')'
    );
    bindings.push(pattern, pattern, pattern);
  }
  if (artistId) {
    where.push('t.artist_id = ?');
    bindings.push(artistId);
  }
  if (albumId) {
    where.push('t.album_id = ?');
    bindings.push(albumId);
  }
  if (genre) {
    where.push('LOWER(t.genre) = ?');
    bindings.push(genre.toLowerCase());
  }
  if (format) {
    where.push('t.format = ?');
    bindings.push(format.toLowerCase());
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = await c.env.DB.prepare(
    `${mine ? MODERATED_TRACK_SELECT : TRACK_SELECT}
     ${whereSql}
     ORDER BY ${sort}
     LIMIT ? OFFSET ?`
  )
    .bind(...bindings, limit, offset)
    .all<TrackRowJoined>();

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM tracks t
       LEFT JOIN artists a ON a.id = t.artist_id
       LEFT JOIN albums al ON al.id = t.album_id
       ${whereSql}`
  )
    .bind(...bindings)
    .first<{ count: number }>();

  const tracks = (rows.results ?? []).map((row) => (mine ? serializeModeratedTrack(row) : serializeTrack(row)));
  return c.json({ tracks, pagination: { total: total?.count ?? 0, limit, offset } });
});

/** GET /api/tracks/:id */
trackRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const user = await resolveUser(c);

  const row = await c.env.DB.prepare(`${MODERATED_TRACK_SELECT} WHERE t.id = ?`)
    .bind(id)
    .first<TrackRowJoined>();
  if (!row) throw notFound('Track not found.');

  const readable = canReadTrack(user ?? null, {
    uploader_id: row.uploader_id!,
    status: row.status!,
    visibility: row.visibility!,
    is_deleted: row.is_deleted ?? 0,
    rights_confirmed: row.rights_confirmed ?? 0,
  });
  if (!readable) throw notFound('Track not found.');

  const isPublic =
    row.status === 'approved' && row.visibility === 'public' && (row.is_deleted ?? 0) === 0 && row.rights_confirmed === 1;

  // Public views never expose moderation internals or uploader identity.
  return c.json({ track: isPublic ? serializeTrack(row) : serializeModeratedTrack(row) });
});

/**
 * GET /api/tracks/:id/stream-info is intentionally NOT provided: streaming lives
 * at /api/stream/:id[/url] so that one code path owns byte-range semantics.
 */
trackRoutes.get('/:id/similar', async (c) => {
  const id = c.req.param('id');
  const track = await c.env.DB.prepare('SELECT artist_id, album_id FROM tracks WHERE id = ?')
    .bind(id)
    .first<{ artist_id: string | null; album_id: string | null }>();
  if (!track) throw notFound('Track not found.');

  const rows = await c.env.DB.prepare(
    `${TRACK_SELECT}
      WHERE t.status = 'approved' AND t.visibility = 'public' AND t.is_deleted = 0 AND t.rights_confirmed = 1
        AND t.id <> ?
        AND (t.artist_id = ? OR t.album_id = ? OR t.genre IS NOT NULL)
      ORDER BY (t.artist_id = ?) DESC, t.play_count DESC
      LIMIT 20`
  )
    .bind(id, track.artist_id, track.album_id, track.artist_id)
    .all<TrackRowJoined>();

  return c.json({ tracks: (rows.results ?? []).map(serializeTrack) });
});

export { escapeLike };
