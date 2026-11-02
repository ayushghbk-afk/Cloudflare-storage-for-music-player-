-- 0004_uploads_moderation.sql
-- Upload jobs, moderation reports and playback error telemetry.

CREATE TABLE upload_jobs (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider_id          TEXT REFERENCES storage_providers (id) ON DELETE SET NULL,
  storage_object_id    TEXT REFERENCES storage_objects (id) ON DELETE SET NULL,
  track_id             TEXT REFERENCES tracks (id) ON DELETE SET NULL,

  status               TEXT NOT NULL DEFAULT 'initiated'
                         CHECK (status IN (
                           'initiated',      -- presigned URL issued, no bytes yet
                           'uploaded',       -- bytes stored, not yet processed
                           'processing',     -- metadata extraction running
                           'awaiting_review',-- private track created, awaiting moderation
                           'published',      -- approved and public
                           'rejected',       -- rejected by a moderator
                           'duplicate',      -- identical content already exists
                           'failed',         -- unrecoverable error (see error_*)
                           'expired',        -- never completed before expiry
                           'cancelled'
                         )),
  upload_mode          TEXT NOT NULL DEFAULT 'direct'
                         CHECK (upload_mode IN ('direct', 'worker')),

  object_key           TEXT NOT NULL,
  bucket_name          TEXT,
  filename             TEXT NOT NULL,
  declared_mime_type   TEXT NOT NULL,
  declared_size_bytes  INTEGER NOT NULL CHECK (declared_size_bytes >= 0),
  uploaded_size_bytes  INTEGER,
  sha256               TEXT,

  -- uploader supplied metadata; server extraction wins where available
  metadata             TEXT,

  rights_confirmed     INTEGER NOT NULL DEFAULT 0 CHECK (rights_confirmed IN (0, 1)),
  turnstile_verified   INTEGER NOT NULL DEFAULT 0 CHECK (turnstile_verified IN (0, 1)),

  error_code           TEXT,
  error_message        TEXT,

  expires_at           TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at         TEXT
);

CREATE INDEX idx_upload_jobs_user ON upload_jobs (user_id, created_at DESC);
CREATE INDEX idx_upload_jobs_status ON upload_jobs (status, created_at DESC);
CREATE INDEX idx_upload_jobs_track ON upload_jobs (track_id);
CREATE INDEX idx_upload_jobs_sha ON upload_jobs (sha256);

CREATE TABLE moderation_reports (
  id                TEXT PRIMARY KEY,
  track_id          TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
  reporter_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  reporter_ip_hash  TEXT,
  reason            TEXT NOT NULL
                      CHECK (reason IN (
                        'copyright', 'explicit', 'spam', 'malware',
                        'impersonation', 'quality', 'other'
                      )),
  details           TEXT,
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution_note   TEXT,
  resolved_by       TEXT REFERENCES users (id) ON DELETE SET NULL,
  resolved_at       TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_reports_status ON moderation_reports (status, created_at DESC);
CREATE INDEX idx_reports_track ON moderation_reports (track_id);

-- Player-reported playback failures (dashboard metric + provider triage).
CREATE TABLE playback_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id    TEXT REFERENCES tracks (id) ON DELETE SET NULL,
  user_id     TEXT REFERENCES users (id) ON DELETE SET NULL,
  platform    TEXT,
  code        TEXT,
  message     TEXT,
  provider_id TEXT REFERENCES storage_providers (id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_playback_errors_created ON playback_errors (created_at DESC);
CREATE INDEX idx_playback_errors_track ON playback_errors (track_id, created_at DESC);
