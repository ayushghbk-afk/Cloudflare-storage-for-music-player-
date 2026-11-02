/**
 * Response shaping.
 *
 * Public serialisers deliberately omit storage internals: object keys, bucket
 * names, provider IDs and hashes never leave the API except for staff endpoints.
 */
export interface TrackRowJoined {
  id: string;
  title: string;
  artist_id: string | null;
  artist_name: string | null;
  album_id: string | null;
  album_title: string | null;
  album_year: number | null;
  track_number: number | null;
  disc_number: number | null;
  genre: string | null;
  release_year: number | null;
  duration_ms: number | null;
  format: string;
  mime_type: string;
  size_bytes: number;
  sample_rate: number | null;
  channels: number | null;
  bit_depth: number | null;
  bitrate_kbps: number | null;
  artwork_key: string | null;
  play_count: number;
  published_at: string | null;
  created_at: string;
  // moderation / ownership (staff or owner views only)
  uploader_id?: string;
  uploader_name?: string;
  status?: string;
  visibility?: string;
  rights_confirmed?: number;
  rejection_reason?: string | null;
  reviewed_at?: string | null;
  is_deleted?: number;
  description?: string | null;
}

export interface PublicTrack {
  id: string;
  title: string;
  artist: { id: string; name: string } | null;
  album: { id: string; title: string; year: number | null } | null;
  trackNumber: number | null;
  discNumber: number | null;
  genre: string | null;
  year: number | null;
  durationMs: number | null;
  format: string;
  mimeType: string;
  sizeBytes: number;
  sampleRate: number | null;
  channels: number | null;
  bitDepth: number | null;
  bitrateKbps: number | null;
  artworkUrl: string | null;
  streamUrl: string;
  playCount: number;
  publishedAt: string | null;
  createdAt: string;
}

export interface ModeratedTrack extends PublicTrack {
  uploader: { id: string; name: string | null } | null;
  status: string;
  visibility: string;
  rightsConfirmed: boolean;
  rejectionReason: string | null;
  reviewedAt: string | null;
  description: string | null;
}

export function serializeTrack(row: TrackRowJoined): PublicTrack {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist_id ? { id: row.artist_id, name: row.artist_name ?? 'Unknown artist' } : null,
    album: row.album_id ? { id: row.album_id, title: row.album_title ?? 'Unknown album', year: row.album_year ?? null } : null,
    trackNumber: row.track_number,
    discNumber: row.disc_number,
    genre: row.genre,
    year: row.release_year,
    durationMs: row.duration_ms,
    format: row.format,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sampleRate: row.sample_rate,
    channels: row.channels,
    bitDepth: row.bit_depth,
    bitrateKbps: row.bitrate_kbps,
    artworkUrl: row.artwork_key ? `/api/artwork/${row.id}` : null,
    streamUrl: `/api/stream/${row.id}`,
    playCount: row.play_count,
    publishedAt: row.published_at,
    createdAt: row.created_at,
  };
}

export function serializeModeratedTrack(row: TrackRowJoined): ModeratedTrack {
  return {
    ...serializeTrack(row),
    uploader: row.uploader_id ? { id: row.uploader_id, name: row.uploader_name ?? null } : null,
    status: row.status ?? 'pending',
    visibility: row.visibility ?? 'private',
    rightsConfirmed: row.rights_confirmed === 1,
    rejectionReason: row.rejection_reason ?? null,
    reviewedAt: row.reviewed_at ?? null,
    description: row.description ?? null,
  };
}

export function serializeArtist(row: {
  id: string;
  name: string;
  bio: string | null;
  image_key: string | null;
  track_count?: number;
  album_count?: number;
}): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    bio: row.bio,
    imageUrl: row.image_key ? `/api/artists/${row.id}/image` : null,
    trackCount: row.track_count ?? 0,
    albumCount: row.album_count ?? 0,
  };
}

export function serializeAlbum(row: {
  id: string;
  title: string;
  artist_id: string | null;
  artist_name: string | null;
  release_year: number | null;
  artwork_key: string | null;
  track_count?: number;
  total_duration_ms?: number | null;
}): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist_id ? { id: row.artist_id, name: row.artist_name ?? 'Unknown artist' } : null,
    year: row.release_year,
    artworkUrl: row.artwork_key ? `/api/albums/${row.id}/artwork` : null,
    trackCount: row.track_count ?? 0,
    durationMs: row.total_duration_ms ?? null,
  };
}

export function serializePlaylist(row: {
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
}): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    owner: { id: row.owner_id, name: row.owner_name },
    artworkUrl: row.artwork_key ? `/api/playlists/${row.id}/artwork` : null,
    trackCount: row.track_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** SQL fragment joining artist/album for a track row. */
export const TRACK_SELECT = `
  SELECT t.id, t.title, t.artist_id, a.name AS artist_name, t.album_id, al.title AS album_title,
         al.release_year AS album_year, t.track_number, t.disc_number, t.genre, t.release_year,
         t.duration_ms, t.format, t.mime_type, t.size_bytes, t.sample_rate, t.channels, t.bit_depth,
         t.bitrate_kbps, t.artwork_key, t.play_count, t.published_at, t.created_at
    FROM tracks t
    LEFT JOIN artists a ON a.id = t.artist_id
    LEFT JOIN albums al ON al.id = t.album_id`;

/** Same as TRACK_SELECT but with moderation fields (staff/owner endpoints only). */
export const MODERATED_TRACK_SELECT = `
  SELECT t.id, t.title, t.artist_id, a.name AS artist_name, t.album_id, al.title AS album_title,
         al.release_year AS album_year, t.track_number, t.disc_number, t.genre, t.release_year,
         t.duration_ms, t.format, t.mime_type, t.size_bytes, t.sample_rate, t.channels, t.bit_depth,
         t.bitrate_kbps, t.artwork_key, t.play_count, t.published_at, t.created_at,
         t.uploader_id, u.display_name AS uploader_name, t.status, t.visibility, t.rights_confirmed,
         t.rejection_reason, t.reviewed_at, t.is_deleted, t.description
    FROM tracks t
    LEFT JOIN artists a ON a.id = t.artist_id
    LEFT JOIN albums al ON al.id = t.album_id
    LEFT JOIN users u ON u.id = t.uploader_id`;
