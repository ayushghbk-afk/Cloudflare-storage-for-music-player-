import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { notFound } from '../utils/errors';
import { noStoreHeaders, pagination, readJson } from '../utils/http';
import { canReadTrack, requireUser } from '../auth/middleware';
import { serializeModeratedTrack, serializePlaylist, serializeTrack, MODERATED_TRACK_SELECT, TRACK_SELECT, type TrackRowJoined } from '../catalog/serialize';

export const libraryRoutes = new Hono<AppEnv>();

const favoriteSchema = z.strictObject({ trackId: z.string().min(3).max(64) });

const historySchema = z.strictObject({
  trackId: z.string().min(3).max(64),
  positionMs: z.number().int().min(0).max(86_400_000).optional(),
  completed: z.boolean().optional(),
  playlistId: z.string().min(3).max(64).optional(),
  source: z.enum(['library', 'album', 'artist', 'playlist', 'search', 'favorites', 'history', 'upload', 'other']).optional(),
  device: z.enum(['web', 'android', 'ios', 'desktop', 'other']).optional(),
});

interface GuardRow {
  id: string;
  uploader_id: string;
  status: string;
  visibility: string;
  is_deleted: number;
  rights_confirmed: number;
}

async function assertTrackReadable(c: Parameters<typeof requireUser>[0], trackId: string): Promise<void> {
  const user = await requireUser(c);
  const track = await c.env.DB.prepare(
    'SELECT id, uploader_id, status, visibility, is_deleted, rights_confirmed FROM tracks WHERE id = ?'
  )
    .bind(trackId)
    .first<GuardRow>();
  if (!track || !canReadTrack(user, track)) throw notFound('Track not found.');
}

/**
 * GET /api/library
 *
 * The signed-in user's home screen in one request: favorites, recently played,
 * their own uploads and their playlists.
 */
libraryRoutes.get('/', async (c) => {
  const user = await requireUser(c);

  const [favorites, recent, uploads, playlists, counts] = await Promise.all([
    c.env.DB.prepare(
      `${TRACK_SELECT}
         JOIN favorites f ON f.track_id = t.id
        WHERE f.user_id = ? AND t.is_deleted = 0
        ORDER BY f.created_at DESC
        LIMIT 100`
    )
      .bind(user.id)
      .all<TrackRowJoined>(),
    c.env.DB.prepare(
      `${TRACK_SELECT}
         JOIN (SELECT track_id, MAX(played_at) AS played_at
                 FROM play_history WHERE user_id = ? GROUP BY track_id) h
           ON h.track_id = t.id
        WHERE t.is_deleted = 0
        ORDER BY h.played_at DESC
        LIMIT 50`
    )
      .bind(user.id)
      .all<TrackRowJoined>(),
    c.env.DB.prepare(
      `${MODERATED_TRACK_SELECT}
        WHERE t.uploader_id = ? AND t.is_deleted = 0
        ORDER BY t.created_at DESC
        LIMIT 50`
    )
      .bind(user.id)
      .all<TrackRowJoined>(),
    c.env.DB.prepare(
      `SELECT p.id, p.title, p.description, p.visibility, p.owner_id, u.display_name AS owner_name,
              p.artwork_key, p.created_at, p.updated_at,
              (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS track_count
         FROM playlists p LEFT JOIN users u ON u.id = p.owner_id
        WHERE p.owner_id = ?
        ORDER BY p.updated_at DESC
        LIMIT 50`
    )
      .bind(user.id)
      .all<Parameters<typeof serializePlaylist>[0]>(),
    c.env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM tracks WHERE uploader_id = ? AND status = 'pending' AND is_deleted = 0) AS pending,
         (SELECT COUNT(*) FROM tracks WHERE uploader_id = ? AND status = 'approved' AND is_deleted = 0) AS approved,
         (SELECT COUNT(*) FROM tracks WHERE uploader_id = ? AND status = 'rejected' AND is_deleted = 0) AS rejected,
         (SELECT COUNT(*) FROM favorites WHERE user_id = ?) AS favorites`
    )
      .bind(user.id, user.id, user.id, user.id)
      .first<{ pending: number; approved: number; rejected: number; favorites: number }>(),
  ]);

  return c.json(
    {
      favorites: (favorites.results ?? []).map(serializeTrack),
      recentlyPlayed: (recent.results ?? []).map(serializeTrack),
      uploads: (uploads.results ?? []).map(serializeModeratedTrack),
      playlists: (playlists.results ?? []).map(serializePlaylist),
      counts: {
        pendingUploads: counts?.pending ?? 0,
        approvedUploads: counts?.approved ?? 0,
        rejectedUploads: counts?.rejected ?? 0,
        favorites: counts?.favorites ?? 0,
      },
    },
    200,
    noStoreHeaders()
  );
});

/** POST /api/library/favorites */
libraryRoutes.post('/favorites', async (c) => {
  const user = await requireUser(c);
  const body = await readJson(c, favoriteSchema);
  await assertTrackReadable(c, body.trackId);

  await c.env.DB.prepare('INSERT OR IGNORE INTO favorites (user_id, track_id) VALUES (?, ?)')
    .bind(user.id, body.trackId)
    .run();

  return c.json({ ok: true, trackId: body.trackId, favorited: true }, 200, noStoreHeaders());
});

/** DELETE /api/library/favorites/:trackId */
libraryRoutes.delete('/favorites/:trackId', async (c) => {
  const user = await requireUser(c);
  await c.env.DB.prepare('DELETE FROM favorites WHERE user_id = ? AND track_id = ?')
    .bind(user.id, c.req.param('trackId'))
    .run();
  return c.json({ ok: true, trackId: c.req.param('trackId'), favorited: false }, 200, noStoreHeaders());
});

/** GET /api/library/favorites */
libraryRoutes.get('/favorites', async (c) => {
  const user = await requireUser(c);
  const rows = await c.env.DB.prepare(
    `${TRACK_SELECT} JOIN favorites f ON f.track_id = t.id WHERE f.user_id = ? AND t.is_deleted = 0 ORDER BY f.created_at DESC LIMIT 200`
  )
    .bind(user.id)
    .all<TrackRowJoined>();
  return c.json({ tracks: (rows.results ?? []).map(serializeTrack) }, 200, noStoreHeaders());
});

/** POST /api/library/history — records a playback start/progress event. */
libraryRoutes.post('/history', async (c) => {
  const user = await requireUser(c);
  const body = await readJson(c, historySchema);
  await assertTrackReadable(c, body.trackId);

  await c.env.DB.prepare(
    `INSERT INTO play_history (user_id, track_id, playlist_id, position_ms, completed, source, device)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      user.id,
      body.trackId,
      body.playlistId ?? null,
      body.positionMs ?? null,
      body.completed ? 1 : 0,
      body.source ?? null,
      body.device ?? null
    )
    .run();

  return c.json({ ok: true }, 201, noStoreHeaders());
});

/** GET /api/library/history */
libraryRoutes.get('/history', async (c) => {
  const user = await requireUser(c);
  const { limit, offset } = pagination(c, { limit: 50, maxLimit: 200 });

  const rows = await c.env.DB.prepare(
    `SELECT h.id, h.track_id, h.played_at, h.position_ms, h.completed, h.source, h.device,
            t.title, t.duration_ms, t.format, t.artwork_key
       FROM play_history h
       JOIN tracks t ON t.id = h.track_id
      WHERE h.user_id = ?
      ORDER BY h.played_at DESC
      LIMIT ? OFFSET ?`
  )
    .bind(user.id, limit, offset)
    .all<Record<string, unknown>>();

  const total = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM play_history WHERE user_id = ?')
    .bind(user.id)
    .first<{ count: number }>();

  return c.json(
    {
      history: (rows.results ?? []).map((row) => ({
        id: row.id,
        trackId: row.track_id,
        title: row.title,
        durationMs: row.duration_ms,
        format: row.format,
        artworkUrl: row.artwork_key ? `/api/artwork/${row.track_id}` : null,
        playedAt: row.played_at,
        positionMs: row.position_ms,
        completed: row.completed === 1,
        source: row.source,
        device: row.device,
      })),
      pagination: { total: total?.count ?? 0, limit, offset },
    },
    200,
    noStoreHeaders()
  );
});

/** DELETE /api/library/history — clears the caller's listening history. */
libraryRoutes.delete('/history', async (c) => {
  const user = await requireUser(c);
  const result = await c.env.DB.prepare('DELETE FROM play_history WHERE user_id = ?').bind(user.id).run();
  return c.json({ ok: true, deleted: result.meta?.changes ?? 0 }, 200, noStoreHeaders());
});
