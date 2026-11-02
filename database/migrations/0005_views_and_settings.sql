-- 0005_views_and_settings.sql
-- Read models, usage aggregation and default settings.

-- Everything the public API is allowed to expose. `rights_confirmed = 1` is part
-- of the definition: an approved track whose rights confirmation was revoked is
-- automatically excluded from public listings, streaming and albums/artists.
CREATE VIEW public_tracks AS
SELECT
  t.id,
  t.title,
  t.artist_id,
  t.album_id,
  t.track_number,
  t.disc_number,
  t.genre,
  t.release_year,
  t.duration_ms,
  t.format,
  t.mime_type,
  t.size_bytes,
  t.sample_rate,
  t.channels,
  t.bit_depth,
  t.bitrate_kbps,
  t.artwork_key,
  t.artwork_mime,
  t.play_count,
  t.published_at,
  t.created_at,
  t.primary_object_id
FROM tracks t
WHERE t.status = 'approved'
  AND t.visibility = 'public'
  AND t.is_deleted = 0
  AND t.rights_confirmed = 1;

-- Per-provider usage derived from the object index. `capacity_bytes` is only
-- present when an administrator recorded a real figure.
CREATE VIEW storage_provider_usage AS
SELECT
  p.id                AS provider_id,
  p.name,
  p.enabled,
  p.priority,
  p.capacity_bytes,
  COUNT(o.id)         AS object_count,
  COALESCE(SUM(o.size_bytes), 0) AS used_bytes,
  MAX(o.created_at)   AS last_object_at
FROM storage_providers p
LEFT JOIN storage_objects o
  ON o.provider_id = p.id AND o.status = 'active'
GROUP BY p.id;

-- Default runtime settings. `INSERT OR IGNORE` keeps admin edits intact when a
-- later migration re-declares a default.
INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('uploadMaxBytes', '52428800'),
  ('uploadDailyUserQuotaBytes', '2147483648'),
  ('uploadAllowedMimeTypes', '["audio/mpeg","audio/flac","audio/x-flac","audio/mp4","audio/x-m4a","audio/m4a","audio/aac","audio/ogg","audio/opus","audio/wav","audio/x-wav"]'),
  ('uploadRequireRightsConfirmation', 'true'),
  ('autoPublishUploads', 'false'),
  ('storageMigrationMaxBytes', '26214400'),
  ('streamUrlTtlSeconds', '300'),
  ('maxPlaylistsPerUser', '100'),
  ('maxTracksPerPlaylist', '500');
