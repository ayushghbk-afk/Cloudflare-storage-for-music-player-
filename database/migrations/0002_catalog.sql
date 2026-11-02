-- 0002_catalog.sql
-- Public music catalogue: artists, albums, tracks, playlists, favorites, history.
--
-- A track ID is stable and independent of physical storage: the bytes live in
-- `storage_objects` (added in 0003) and can be re-pointed without changing any
-- track ID, playlist entry, favourite or play-history row.

CREATE TABLE artists (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  name_normalized  TEXT NOT NULL UNIQUE,
  sort_name        TEXT,
  bio              TEXT,
  image_key        TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_artists_normalized ON artists (name_normalized);

CREATE TABLE albums (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  title_normalized TEXT NOT NULL,
  artist_id        TEXT REFERENCES artists (id) ON DELETE SET NULL,
  release_year     INTEGER,
  artwork_key      TEXT,
  description      TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (title_normalized, artist_id)
);

CREATE INDEX idx_albums_artist ON albums (artist_id);
CREATE INDEX idx_albums_normalized ON albums (title_normalized);

CREATE TABLE tracks (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  title_normalized   TEXT NOT NULL,
  artist_id          TEXT REFERENCES artists (id) ON DELETE SET NULL,
  album_id           TEXT REFERENCES albums (id) ON DELETE SET NULL,
  -- who uploaded it and therefore owns the private copy until it is published
  uploader_id        TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  track_number       INTEGER,
  disc_number        INTEGER,
  genre              TEXT,
  release_year       INTEGER,
  description        TEXT,

  -- audio facts extracted from the file itself
  duration_ms        INTEGER,
  format             TEXT NOT NULL DEFAULT 'unknown'
                       CHECK (format IN ('mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'unknown')),
  mime_type          TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes         INTEGER NOT NULL DEFAULT 0,
  sample_rate        INTEGER,
  channels           INTEGER,
  bit_depth          INTEGER,
  bitrate_kbps       INTEGER,

  -- integrity + artwork
  integrity_sha256   TEXT,
  artwork_key        TEXT,
  artwork_mime       TEXT,

  -- publication / moderation state
  visibility         TEXT NOT NULL DEFAULT 'private'
                       CHECK (visibility IN ('private', 'public')),
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'approved', 'rejected', 'removed')),
  rights_confirmed   INTEGER NOT NULL DEFAULT 0 CHECK (rights_confirmed IN (0, 1)),
  rights_statement   TEXT,
  rejection_reason   TEXT,
  reviewed_by        TEXT REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at        TEXT,
  published_at       TEXT,

  play_count         INTEGER NOT NULL DEFAULT 0,
  is_deleted         INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),

  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_tracks_artist ON tracks (artist_id);
CREATE INDEX idx_tracks_album ON tracks (album_id);
CREATE INDEX idx_tracks_uploader ON tracks (uploader_id, created_at DESC);
CREATE INDEX idx_tracks_public ON tracks (status, visibility, is_deleted, created_at DESC);
CREATE INDEX idx_tracks_title_normalized ON tracks (title_normalized);
CREATE INDEX idx_tracks_sha ON tracks (integrity_sha256);
CREATE INDEX idx_tracks_created ON tracks (created_at DESC);

CREATE TABLE playlists (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  visibility   TEXT NOT NULL DEFAULT 'private'
                 CHECK (visibility IN ('private', 'public')),
  artwork_key  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_playlists_owner ON playlists (owner_id);
CREATE INDEX idx_playlists_visibility ON playlists (visibility, updated_at DESC);

CREATE TABLE playlist_tracks (
  id           TEXT PRIMARY KEY,
  playlist_id  TEXT NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
  track_id     TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  added_by     TEXT REFERENCES users (id) ON DELETE SET NULL,
  added_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (playlist_id, track_id)
);

CREATE INDEX idx_playlist_tracks_order ON playlist_tracks (playlist_id, position);

CREATE TABLE favorites (
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  track_id    TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, track_id)
);

CREATE INDEX idx_favorites_track ON favorites (track_id);
CREATE INDEX idx_favorites_user_created ON favorites (user_id, created_at DESC);

CREATE TABLE play_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  track_id     TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
  playlist_id  TEXT REFERENCES playlists (id) ON DELETE SET NULL,
  played_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  position_ms  INTEGER,
  completed    INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  source       TEXT,
  device       TEXT
);

CREATE INDEX idx_play_history_user ON play_history (user_id, played_at DESC);
CREATE INDEX idx_play_history_track ON play_history (track_id, played_at DESC);
