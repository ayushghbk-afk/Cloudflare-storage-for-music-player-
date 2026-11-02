import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { conflict, forbidden, notFound } from '../utils/errors';
import { pagination, readJson } from '../utils/http';
import { newId } from '../utils/ids';
import { writeAudit } from '../utils/audit';
import { canReadTrack, requireUser, resolveUser } from '../auth/middleware';
import { serializePlaylist, serializeTrack, TRACK_SELECT, type TrackRowJoined } from './serialize';
import { artworkTrackForPlaylist, serveTrackArtwork } from '../streaming/artwork';

export const playlistRoutes = new Hono<AppEnv>();

interface PlaylistRow {
  id: string;
  title: string;
  description: string | null;
  visibility: string;
  owner_id: string;
  owner_name: string | null;
  artwork_key: string | null;
  track_count?: number;
  created_at: string;
  updated_at: string;
}

const createSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  visibility: z.enum(['private', 'public']).optional(),
});

const updateSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  visibility: z.enum(['private', 'public']).optional(),
});

const addTrackSchema = z.strictObject({
  trackId: z.string().min(3).max(64),
  position: z.number().int().min(0).max(10_000).optional(),
});

const PLAYLIST_SELECT = `
  SELECT p.id, p.title, p.description, p.visibility, p.owner_id, u.display_name AS owner_name,
         p.artwork_key, p.created_at, p.updated_at,
         (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS track_count
    FROM playlists p
    LEFT JOIN users u ON u.id = p.owner_id`;

async function loadPlaylist(c: Parameters<typeof requireUser>[0], id: string): Promise<PlaylistRow | null> {
  return c.env.DB.prepare(`${PLAYLIST_SELECT} WHERE p.id = ?`).bind(id).first<PlaylistRow>();
}

function assertPlaylistReadable(playlist: PlaylistRow, user: { id: string; role: string } | null): void {
  const staff = user?.role === 'admin' || user?.role === 'moderator';
  if (playlist.visibility === 'public' || staff || (user && playlist.owner_id === user.id)) return;
  throw notFound('Playlist not found.');
}

function assertPlaylistOwner(playlist: PlaylistRow, user: { id: string; role: string }): void {
  if (playlist.owner_id !== user.id && user.role !== 'admin') {
    throw forbidden('Only the playlist owner can modify this playlist.');
  }
}

/** GET /api/playlists?mine=1 */
playlistRoutes.get('/', async (c) => {
  const user = await resolveUser(c);
  const { limit, offset } = pagination(c);
  const mine = c.req.query('mine') === '1' || c.req.query('mine') === 'true';

  if (mine && !user) return c.json({ playlists: [], pagination: { total: 0, limit, offset } });

  const where = mine && user ? 'WHERE p.owner_id = ?' : "WHERE p.visibility = 'public'";
  const bindings = mine && user ? [user.id] : [];

  const rows = await c.env.DB.prepare(
    `${PLAYLIST_SELECT} ${where} ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`
  )
    .bind(...bindings, limit, offset)
    .all<PlaylistRow>();

  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM playlists p ${where}`)
    .bind(...bindings)
    .first<{ count: number }>();

  return c.json({
    playlists: (rows.results ?? []).map(serializePlaylist),
    pagination: { total: total?.count ?? 0, limit, offset },
  });
});

/** POST /api/playlists */
playlistRoutes.post('/', async (c) => {
  const user = await requireUser(c);
  const settings = c.get('settings');
  const body = await readJson(c, createSchema);

  const count = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM playlists WHERE owner_id = ?')
    .bind(user.id)
    .first<{ count: number }>();
  if ((count?.count ?? 0) >= settings.maxPlaylistsPerUser) {
    throw conflict(`You have reached the limit of ${settings.maxPlaylistsPerUser} playlists.`);
  }

  const id = newId('pl');
  await c.env.DB.prepare(
    'INSERT INTO playlists (id, owner_id, title, description, visibility) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(id, user.id, body.title, body.description ?? null, body.visibility ?? 'private')
    .run();

  await writeAudit(
    c.env.DB,
    { actorUserId: user.id, actorEmail: user.email, action: 'playlist.created', targetType: 'playlist', targetId: id },
    c.get('logger')
  );

  const playlist = await loadPlaylist(c, id);
  return c.json({ playlist: serializePlaylist(playlist!) }, 201);
});

/** GET /api/playlists/:id */
playlistRoutes.get('/:id', async (c) => {
  const user = await resolveUser(c);
  const playlist = await loadPlaylist(c, c.req.param('id'));
  if (!playlist) throw notFound('Playlist not found.');
  assertPlaylistReadable(playlist, user ?? null);

  const rows = await c.env.DB.prepare(
    `${TRACK_SELECT}
       JOIN playlist_tracks pt ON pt.track_id = t.id
      WHERE pt.playlist_id = ?
        AND t.is_deleted = 0
        AND (t.status = 'approved' AND t.visibility = 'public' AND t.rights_confirmed = 1
             OR t.uploader_id = ?
             OR ? IN ('admin','moderator'))
      ORDER BY pt.position ASC`
  )
    .bind(playlist.id, user?.id ?? '', user?.role ?? '')
    .all<TrackRowJoined>();

  return c.json({
    playlist: serializePlaylist(playlist),
    tracks: (rows.results ?? []).map(serializeTrack),
    canEdit: Boolean(user && (playlist.owner_id === user.id || user.role === 'admin')),
  });
});

/** PATCH /api/playlists/:id */
playlistRoutes.patch('/:id', async (c) => {
  const user = await requireUser(c);
  const playlist = await loadPlaylist(c, c.req.param('id'));
  if (!playlist) throw notFound('Playlist not found.');
  // Do not reveal the existence of a private playlist to unrelated users.
  assertPlaylistReadable(playlist, user);
  assertPlaylistOwner(playlist, user);
  const body = await readJson(c, updateSchema);

  const updates: string[] = [];
  const bindings: unknown[] = [];
  if (body.title !== undefined) {
    updates.push('title = ?');
    bindings.push(body.title);
  }
  if (body.description !== undefined) {
    updates.push('description = ?');
    bindings.push(body.description);
  }
  if (body.visibility !== undefined) {
    updates.push('visibility = ?');
    bindings.push(body.visibility);
  }
  if (updates.length === 0) return c.json({ playlist: serializePlaylist(playlist) });

  updates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  await c.env.DB.prepare(`UPDATE playlists SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...bindings, playlist.id)
    .run();

  await writeAudit(
    c.env.DB,
    { actorUserId: user.id, actorEmail: user.email, action: 'playlist.updated', targetType: 'playlist', targetId: playlist.id },
    c.get('logger')
  );

  const updated = await loadPlaylist(c, playlist.id);
  return c.json({ playlist: serializePlaylist(updated!) });
});

/** DELETE /api/playlists/:id */
playlistRoutes.delete('/:id', async (c) => {
  const user = await requireUser(c);
  const playlist = await loadPlaylist(c, c.req.param('id'));
  if (!playlist) throw notFound('Playlist not found.');
  // Do not reveal the existence of a private playlist to unrelated users.
  assertPlaylistReadable(playlist, user);
  assertPlaylistOwner(playlist, user);

  await c.env.DB.prepare('DELETE FROM playlists WHERE id = ?').bind(playlist.id).run();
  await writeAudit(
    c.env.DB,
    { actorUserId: user.id, actorEmail: user.email, action: 'playlist.deleted', targetType: 'playlist', targetId: playlist.id },
    c.get('logger')
  );
  return c.json({ ok: true });
});

/** POST /api/playlists/:id/tracks */
playlistRoutes.post('/:id/tracks', async (c) => {
  const user = await requireUser(c);
  const settings = c.get('settings');
  const playlist = await loadPlaylist(c, c.req.param('id'));
  if (!playlist) throw notFound('Playlist not found.');
  // Do not reveal the existence of a private playlist to unrelated users.
  assertPlaylistReadable(playlist, user);
  assertPlaylistOwner(playlist, user);

  const body = await readJson(c, addTrackSchema);

  const track = await c.env.DB.prepare(
    `SELECT id, uploader_id, status, visibility, is_deleted, rights_confirmed FROM tracks WHERE id = ?`
  )
    .bind(body.trackId)
    .first<{ id: string; uploader_id: string; status: string; visibility: string; is_deleted: number; rights_confirmed: number }>();
  if (!track) throw notFound('Track not found.');
  if (!canReadTrack(user, track)) throw notFound('Track not found.');

  if ((playlist.track_count ?? 0) >= settings.maxTracksPerPlaylist) {
    throw conflict(`This playlist already holds the maximum of ${settings.maxTracksPerPlaylist} tracks.`);
  }

  const existing = await c.env.DB.prepare('SELECT 1 AS present FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?')
    .bind(playlist.id, track.id)
    .first<{ present: number }>();
  if (existing) throw conflict('That track is already in this playlist.');

  const maxPosition = await c.env.DB.prepare('SELECT COALESCE(MAX(position), -1) AS max FROM playlist_tracks WHERE playlist_id = ?')
    .bind(playlist.id)
    .first<{ max: number }>();
  const position = body.position ?? (maxPosition?.max ?? -1) + 1;

  if (body.position !== undefined) {
    await c.env.DB.prepare('UPDATE playlist_tracks SET position = position + 1 WHERE playlist_id = ? AND position >= ?')
      .bind(playlist.id, position)
      .run();
  }

  await c.env.DB.prepare(
    'INSERT INTO playlist_tracks (id, playlist_id, track_id, position, added_by) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(newId('plt'), playlist.id, track.id, position, user.id)
    .run();

  await c.env.DB.prepare("UPDATE playlists SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .bind(playlist.id)
    .run();

  return c.json({ ok: true, playlistId: playlist.id, trackId: track.id, position }, 201);
});

/** DELETE /api/playlists/:id/tracks/:trackId */
playlistRoutes.delete('/:id/tracks/:trackId', async (c) => {
  const user = await requireUser(c);
  const playlist = await loadPlaylist(c, c.req.param('id'));
  if (!playlist) throw notFound('Playlist not found.');
  // Do not reveal the existence of a private playlist to unrelated users.
  assertPlaylistReadable(playlist, user);
  assertPlaylistOwner(playlist, user);

  await c.env.DB.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?')
    .bind(playlist.id, c.req.param('trackId'))
    .run();
  await c.env.DB.prepare("UPDATE playlists SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .bind(playlist.id)
    .run();

  return c.json({ ok: true });
});

/** GET /api/playlists/:id/artwork */
playlistRoutes.get('/:id/artwork', async (c) => {
  const user = await resolveUser(c);
  const playlist = await loadPlaylist(c, c.req.param('id'));
  if (!playlist) throw notFound('Playlist not found.');
  assertPlaylistReadable(playlist, user ?? null);

  const trackId = await artworkTrackForPlaylist(c, playlist.id);
  if (!trackId) throw notFound('Artwork not found.');
  return serveTrackArtwork(c, trackId);
});
