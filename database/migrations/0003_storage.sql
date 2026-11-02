-- 0003_storage.sql
-- Storage provider registry + physical object index.
--
-- Design notes
-- ------------
-- * A provider row is metadata only. Credentials are NEVER stored in D1: the
--   row holds a `credential_ref` that resolves to Worker secrets named
--   `R2_<CREDENTIAL_REF>_ACCESS_KEY_ID` / `R2_<CREDENTIAL_REF>_SECRET_ACCESS_KEY`.
-- * `capacity_bytes` is NULL unless an administrator records the real, provider
--   reported entitlement. The API never invents or extrapolates capacity, and
--   never claims that free tiers from multiple accounts can be pooled.
-- * `storage_objects` indexes every physical copy. A track has exactly one
--   primary copy (`is_primary = 1`) and may have more after a migration.

CREATE TABLE storage_providers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  kind              TEXT NOT NULL DEFAULT 'r2'
                      CHECK (kind IN ('r2', 's3')),
  account_id        TEXT,
  bucket_name       TEXT NOT NULL,
  endpoint          TEXT NOT NULL,
  region            TEXT NOT NULL DEFAULT 'auto',
  -- 'binding' = the statically bound MUSIC_BUCKET, 'credentials' = S3 API,
  -- 'none'    = no usable credential is configured yet
  auth_mode         TEXT NOT NULL DEFAULT 'credentials'
                      CHECK (auth_mode IN ('credentials', 'binding')),
  credential_ref    TEXT,
  priority          INTEGER NOT NULL DEFAULT 100,
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  capacity_bytes    INTEGER CHECK (capacity_bytes IS NULL OR capacity_bytes >= 0),
  -- lifecycle status of the last health probe
  health_status     TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'error', 'unconfigured')),
  health_checked_at TEXT,
  health_latency_ms INTEGER,
  health_message    TEXT,
  notes             TEXT,
  created_by        TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_storage_providers_enabled ON storage_providers (enabled, priority);

CREATE TABLE storage_objects (
  id             TEXT PRIMARY KEY,
  track_id       TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
  provider_id    TEXT NOT NULL REFERENCES storage_providers (id) ON DELETE RESTRICT,
  -- denormalised bucket name: proves which bucket holds the bytes even if the
  -- provider row is later edited
  bucket_name    TEXT NOT NULL,
  object_key     TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'audio'
                   CHECK (role IN ('audio', 'artwork', 'staging')),
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  content_type   TEXT,
  etag           TEXT,
  sha256         TEXT,
  is_primary     INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'missing', 'corrupt', 'pending_delete', 'deleted')),
  verified_at    TEXT,
  last_checked_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (provider_id, object_key)
);

CREATE INDEX idx_storage_objects_track ON storage_objects (track_id, is_primary);
CREATE INDEX idx_storage_objects_sha ON storage_objects (sha256);
CREATE INDEX idx_storage_objects_provider ON storage_objects (provider_id, status);

-- Exactly one primary audio copy per (track, content hash).
CREATE UNIQUE INDEX idx_storage_objects_primary_audio
  ON storage_objects (track_id)
  WHERE is_primary = 1 AND role = 'audio';

-- Duplicate detection: one primary object per distinct content hash.
CREATE UNIQUE INDEX idx_storage_objects_sha_primary_audio
  ON storage_objects (sha256)
  WHERE is_primary = 1 AND role = 'audio' AND sha256 IS NOT NULL;

-- Stable pointer from the catalogue to the current primary object.
ALTER TABLE tracks ADD COLUMN primary_object_id TEXT REFERENCES storage_objects (id) ON DELETE SET NULL;

CREATE INDEX idx_tracks_primary_object ON tracks (primary_object_id);
