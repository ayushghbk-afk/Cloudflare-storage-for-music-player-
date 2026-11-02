# Changelog

All notable changes to AETHER Cloud are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned before `v1.0.0`

* Tagged releases `v0.1.0` … `v1.0.0` (tags are created by the owner; this repository does not
  push them automatically).
* Multi-region copies of the same track with automatic read affinity.
* Optional virus scanning hook for untrusted uploads.
* Console: bulk moderation actions.

## [0.4.0] — 2026-11-02

### Added

* **Storage provider registry** with two adapters: the R2 binding (`binding`) and any
  S3-compatible endpoint over SigV4 (`credentials`). Provider rows carry kind, account, bucket,
  endpoint, region, auth mode, credential *reference*, priority, enabled flag, nullable
  capacity and the last health verdict.
* **One unified library across providers**: tracks have stable, storage-independent ids;
  `storage_objects` holds copies with a single primary pointer, and playback falls back to a
  secondary copy when the primary object is missing or a provider fails.
* **Uploads**: `init → bytes → complete` with two modes (presigned direct upload, or streamed
  through the Worker for binding providers), configurable size limits, rolling 24 h per-user
  quota, MIME verification (declared + extension + magic bytes), server-side SHA-256, duplicate
  detection, metadata and artwork extraction, and rights confirmation. Uploads stay private and
  pending until a moderator approves them.
* **Dependency-free metadata parsers** for ID3v2.2/2.3/2.4 + ID3v1, FLAC (STREAMINFO/VORBIS),
  MP4/M4A (moov before or after mdat, stsd channel/rate), Ogg Opus, and WAV.
* **Streaming**: HTTP byte ranges (`200`/`206`/`416`, suffix ranges, HEAD), correct
  `Content-Type`/`Content-Length`/`Content-Range`/`Accept-Ranges`, signed URLs with `exp`/`sig`,
  `302` redirect to presigned R2 URLs (`STREAM_MODE=auto|proxy|redirect`), provider fallback,
  owner-private `no-store` caching, and immutable artwork.
* **Auth**: JWT access tokens (15 min), hashed rotating refresh tokens with reuse detection,
  PBKDF2 password hashing with rehash-on-login, password policy, session listing/revocation,
  optional Turnstile, D1-backed rate limits, and salted IP hashing.
* **RBAC**: user/moderator/admin, re-read from D1 per request, with last-admin and
  self-demotion protection; suspension revokes sessions immediately.
* **Moderation**: listener reports with de-duplication, staff review queue, approve/reject with
  a required reason, admin-only takedown with optional file deletion, and soft-deleted tracks
  that stay out of every public listing.
* **Admin API**: stats, audit log, users, runtime settings (schema with bounds), failed uploads,
  playback errors, provider CRUD + health probes + integrity verification + migration between
  providers.
* **Admin console** (`web/`): React 19 console for the counts, review queue, reports, providers,
  users, settings and audit log. Credential values are never rendered.
* **Database**: five migrations covering identity/sessions/settings/rate limits/audit, the
  catalogue, storage providers/objects, uploads/moderation/playback errors, and views + seeded
  setting defaults, with indexes, foreign keys and partial unique indexes.
* **KV**: a single, short-lived `GET /api/config` cache with explicit invalidation on settings
  and provider changes. Audio never passes through KV.
* **Tooling**: `scripts/validate-migrations.mjs`, `scripts/list-migrations.mjs`,
  `scripts/check-env.mjs`, `scripts/storage-copy.mjs`, CI (typecheck, lint, tests, migrations,
  web build, worker bundle) and a manual, confirmation-gated deploy workflow.
* **Docs**: ARCHITECTURE, SETUP, STORAGE, API, DEPLOYMENT, SECURITY, plus CONTRIBUTING and
  SECURITY policies.
* **Tests**: 241 tests covering hashing, SigV4 parity with `aws4`, range parsing, metadata
  fixtures, the S3 adapter, auth, uploads, streaming, catalogue, playlists/library, moderation,
  admin/storage administration, the public platform endpoints and the migration engine.

### Changed

* `README.md` now leads with the implemented architecture and links to `docs/`, while keeping the
  original AETHER product specification as an appendix.
* `worker/wrangler.toml` ships syntactically valid placeholder ids so local development works
  without edits; `npm run check:env -- --strict` refuses to treat them as production values.

### Fixed

* Worker-mode uploads now give R2 a `FixedLengthStream` (known length) instead of a raw
  request stream, which the R2 binding rejects with *"Provided readable stream must have a
  known length"*. Streams without a declared length are refused rather than buffered, and a
  short stream is detected as a length mismatch. Found by exercising the real `wrangler dev`
  path (the in-memory bucket accepts streams, so unit tests alone could not catch it).
* Playback error telemetry no longer fails with a foreign-key violation when a client reports
  a track that has since been removed; the dangling reference is dropped and the report kept.
* A tampered object is now recorded as `storage_objects.status = 'corrupt'` (previously both
  branches wrote `active`), and the status is allowed by the CHECK constraint.
* Private playlists return `404` rather than `403` to unrelated users for mutations too, so
  their existence is not disclosed.

### Security

* No secrets in the repository; provider credentials are Worker secrets referenced by name.
* Uploads are never public by default; publishing requires moderation **and** a rights
  confirmation.
* Error envelopes never leak stack traces; internal failures return a log-correlated fingerprint.
