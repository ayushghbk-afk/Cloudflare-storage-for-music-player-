-- 0001_core_identity.sql
-- Identity, sessions, settings, rate limiting and the audit trail.
--
-- Conventions used across every migration:
--   * All timestamps are ISO-8601 UTC strings (TEXT) for portable comparisons.
--   * IDs are application-generated time-ordered strings ("usr_...", "trk_...").
--   * Foreign keys are declared explicitly; D1 enforces them.

CREATE TABLE users (
  id                    TEXT PRIMARY KEY,
  email                 TEXT NOT NULL,
  -- lower-cased, trimmed address used for the uniqueness constraint
  email_normalized      TEXT NOT NULL UNIQUE,
  display_name          TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  role                  TEXT NOT NULL DEFAULT 'user'
                          CHECK (role IN ('user', 'moderator', 'admin')),
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'suspended', 'deleted')),
  -- optional per-user override of the global daily upload quota
  upload_quota_bytes    INTEGER CHECK (upload_quota_bytes IS NULL OR upload_quota_bytes >= 0),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at         TEXT
);

CREATE INDEX idx_users_role ON users (role);
CREATE INDEX idx_users_status ON users (status);

-- Refresh-token sessions. Only a SHA-256 hash of the refresh token is stored, so
-- a database leak cannot be replayed against the API.
CREATE TABLE sessions (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  refresh_token_hash  TEXT NOT NULL UNIQUE,
  user_agent          TEXT,
  ip_hash             TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at        TEXT,
  expires_at          TEXT NOT NULL,
  revoked_at          TEXT
);

CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- Admin-editable runtime settings (upload limits, moderation policy, ...).
CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by  TEXT REFERENCES users (id) ON DELETE SET NULL
);

-- Fixed-window counters. `key` embeds the window index so rows are naturally
-- scoped per window and can be swept by `expires_at`.
CREATE TABLE rate_limits (
  key           TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER NOT NULL
);

CREATE INDEX idx_rate_limits_expires ON rate_limits (expires_at);

-- Append-only audit trail for privileged operations and authentication events.
CREATE TABLE audit_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  actor_email    TEXT,
  action         TEXT NOT NULL,
  target_type    TEXT,
  target_id      TEXT,
  metadata       TEXT,
  ip_hash        TEXT,
  user_agent     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_audit_created ON audit_logs (created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs (action, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_logs (actor_user_id, created_at DESC);
