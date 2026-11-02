import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { notFound } from '../utils/errors';
import { pagination } from '../utils/http';
import { likePattern } from '../utils/text';
import { serializeAlbum, serializeArtist, serializeTrack, TRACK_SELECT, type TrackRowJoined } from './serialize';
import { serveTrackArtwork, artworkTrackForAlbum } from '../streaming/artwork';

export const browseRoutes = new Hono<AppEnv>();

const PUBLIC_TRACK_WHERE = "t.status = 'approved' AND t.visibility = 'public' AND t.is_deleted = 0 AND t.rights_confirmed = 1";

/**
 * GET /api/search?q=
 * Searches titles, artists and albums in one round trip so the client can render
 * a single results page without three requests.
 */
browseRoutes.get('/search', async (c) => {
  const raw = (c.req.query('q') ?? '').trim();
  const { limit } = pagination(c, { limit: 20, maxLimit: 50 });
  if (raw.length === 0) {
    return c.json({ query: '', tracks: [], albums: [], artists: [] });
  }
  const pattern = likePattern(raw);

  const [tracks, albums, artists] = await Promise.all([
    c.env.DB.prepare(
      `${TRACK_SELECT}
        WHERE ${PUBLIC_TRACK_WHERE}
          AND (t.title_normalized LIKE ? ESCAPE '\\' OR a.name_normalized LIKE ? ESCAPE '\\' OR al.title_normalized LIKE ? ESCAPE '\\')
        ORDER BY t.play_count DESC, t.created_at DESC
        LIMIT ?`
    )
      .bind(pattern, pattern, pattern, limit)
      .all<TrackRowJoined>(),
    c.env.DB.prepare(
      `SELECT al.id, al.title, al.artist_id, a.name AS artist_name, al.release_year, al.artwork_key,
              (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id AND ${PUBLIC_TRACK_WHERE}) AS track_count
         FROM albums al
         LEFT JOIN artists a ON a.id = al.artist_id
        WHERE al.title_normalized LIKE ? ESCAPE '\\' OR a.name_normalized LIKE ? ESCAPE '\\'
        ORDER BY al.updated_at DESC
        LIMIT 10`
    )
      .bind(pattern, pattern)
      .all<Parameters<typeof serializeAlbum>[0]>(),
    c.env.DB.prepare(
      `SELECT ar.id, ar.name, ar.bio, ar.image_key,
              (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = ar.id AND ${PUBLIC_TRACK_WHERE}) AS track_count,
              (SELECT COUNT(*) FROM albums al WHERE al.artist_id = ar.id) AS album_count
         FROM artists ar
        WHERE ar.name_normalized LIKE ? ESCAPE '\\'
        ORDER BY track_count DESC, ar.name ASC
        LIMIT 10`
    )
      .bind(pattern)
      .all<Parameters<typeof serializeArtist>[0]>(),
  ]);

  return c.json({
    query: raw,
    tracks: (tracks.results ?? []).map(serializeTrack),
    albums: (albums.results ?? []).map(serializeAlbum),
    artists: (artists.results ?? []).map(serializeArtist),
  });
});

/** GET /api/albums */
browseRoutes.get('/albums', async (c) => {
  const { limit, offset } = pagination(c);
  const q = c.req.query('q');

  const where = q && q.trim().length > 0 ? "WHERE al.title_normalized LIKE ? ESCAPE '\\' OR a.name_normalized LIKE ? ESCAPE '\\'" : '';
  const bindings = q && q.trim().length > 0 ? [likePattern(q), likePattern(q)] : [];

  const rows = await c.env.DB.prepare(
    `SELECT al.id, al.title, al.artist_id, a.name AS artist_name, al.release_year, al.artwork_key,
            COUNT(t.id) AS track_count,
            SUM(t.duration_ms) AS total_duration_ms
       FROM albums al
       LEFT JOIN artists a ON a.id = al.artist_id
       JOIN tracks t ON t.album_id = al.id AND ${PUBLIC_TRACK_WHERE}
       ${where}
      GROUP BY al.id
      ORDER BY al.updated_at DESC
      LIMIT ? OFFSET ?`
  )
    .bind(...bindings, limit, offset)
    .all<Parameters<typeof serializeAlbum>[0]>();

  const total = await c.env.DB.prepare(`SELECT COUNT(DISTINCT t.album_id) AS count FROM tracks t WHERE ${PUBLIC_TRACK_WHERE}`)
    .first<{ count: number }>();

  return c.json({
    albums: (rows.results ?? []).map(serializeAlbum),
    pagination: { total: total?.count ?? 0, limit, offset },
  });
});

/** GET /api/albums/:id — album with its track list in disc/track order. */
browseRoutes.get('/albums/:id', async (c) => {
  const id = c.req.param('id');
  const album = await c.env.DB.prepare(
    `SELECT al.id, al.title, al.artist_id, a.name AS artist_name, al.release_year, al.artwork_key, al.description
       FROM albums al
       LEFT JOIN artists a ON a.id = al.artist_id
      WHERE al.id = ?`
  )
    .bind(id)
    .first<Parameters<typeof serializeAlbum>[0] & { description: string | null }>();
  if (!album) throw notFound('Album not found.');

  const tracks = await c.env.DB.prepare(
    `${TRACK_SELECT}
      WHERE t.album_id = ? AND ${PUBLIC_TRACK_WHERE}
      ORDER BY t.disc_number ASC, t.track_number ASC, t.created_at ASC`
  )
    .bind(id)
    .all<TrackRowJoined>();

  return c.json({
    album: { ...serializeAlbum(album), description: album.description },
    tracks: (tracks.results ?? []).map(serializeTrack),
  });
});

/** GET /api/albums/:id/artwork — artwork delegated to a representative track. */
browseRoutes.get('/albums/:id/artwork', async (c) => {
  const trackId = await artworkTrackForAlbum(c, c.req.param('id'));
  if (!trackId) throw notFound('Artwork not found.');
  return serveTrackArtwork(c, trackId);
});

/** GET /api/artists */
browseRoutes.get('/artists', async (c) => {
  const { limit, offset } = pagination(c);
  const q = c.req.query('q');
  const where = q && q.trim().length > 0 ? "WHERE ar.name_normalized LIKE ? ESCAPE '\\'" : '';
  const bindings = q && q.trim().length > 0 ? [likePattern(q)] : [];

  const rows = await c.env.DB.prepare(
    `SELECT ar.id, ar.name, ar.bio, ar.image_key,
            COUNT(DISTINCT t.id) AS track_count,
            COUNT(DISTINCT t.album_id) AS album_count
       FROM artists ar
       JOIN tracks t ON t.artist_id = ar.id AND ${PUBLIC_TRACK_WHERE}
       ${where}
      GROUP BY ar.id
      ORDER BY track_count DESC, ar.name ASC
      LIMIT ? OFFSET ?`
  )
    .bind(...bindings, limit, offset)
    .all<Parameters<typeof serializeArtist>[0]>();

  const total = await c.env.DB.prepare(
    `SELECT COUNT(DISTINCT t.artist_id) AS count FROM tracks t WHERE ${PUBLIC_TRACK_WHERE}`
  ).first<{ count: number }>();

  return c.json({
    artists: (rows.results ?? []).map(serializeArtist),
    pagination: { total: total?.count ?? 0, limit, offset },
  });
});

/** GET /api/artists/:id — artist profile with albums and top tracks. */
browseRoutes.get('/artists/:id', async (c) => {
  const id = c.req.param('id');
  const artist = await c.env.DB.prepare('SELECT id, name, bio, image_key FROM artists WHERE id = ?')
    .bind(id)
    .first<Parameters<typeof serializeArtist>[0]>();
  if (!artist) throw notFound('Artist not found.');

  const [albums, tracks] = await Promise.all([
    c.env.DB.prepare(
      `SELECT al.id, al.title, al.artist_id, ar.name AS artist_name, al.release_year, al.artwork_key,
              COUNT(t.id) AS track_count, SUM(t.duration_ms) AS total_duration_ms
         FROM albums al
         LEFT JOIN artists ar ON ar.id = al.artist_id
         JOIN tracks t ON t.album_id = al.id AND ${PUBLIC_TRACK_WHERE}
        WHERE al.artist_id = ?
        GROUP BY al.id
        ORDER BY al.release_year DESC, al.title ASC`
    )
      .bind(id)
      .all<Parameters<typeof serializeAlbum>[0]>(),
    c.env.DB.prepare(
      `${TRACK_SELECT}
        WHERE t.artist_id = ? AND ${PUBLIC_TRACK_WHERE}
        ORDER BY t.play_count DESC, t.created_at DESC
        LIMIT 50`
    )
      .bind(id)
      .all<TrackRowJoined>(),
  ]);

  return c.json({
    artist: serializeArtist(artist),
    albums: (albums.results ?? []).map(serializeAlbum),
    tracks: (tracks.results ?? []).map(serializeTrack),
  });
});
