# AETHER Cloud — architecture

AETHER Cloud is the server side of the existing AETHER music player. It stores audio in
Cloudflare R2, keeps the catalogue in D1, and exposes one HTTP API that the existing web
player and the existing Android (Media3) player talk to.

It is **not** a player. There is no second playback engine, no duplicate library and no
replacement UI for listeners: the admin console in `web/` is the only new browser surface,
and it exists to operate the library.

```
        ┌──────────────────────────┐        ┌────────────────────────────┐
        │ AETHER web player        │        │ AETHER Android (Media3)    │
        │ (existing, unchanged)    │        │ (existing, unchanged)      │
        └───────────┬──────────────┘        └─────────────┬──────────────┘
                    │  JSON + Range requests              │
                    ▼                                     ▼
        ┌──────────────────────────────────────────────────────────────┐
        │ Cloudflare Worker  (worker/src)  — the only public API       │
        │  auth · catalogue · uploads · moderation · streaming · admin │
        └───────┬───────────────────────┬──────────────────────┬───────┘
                │                       │                      │
        ┌───────▼────────┐     ┌────────▼─────────┐   ┌────────▼─────────┐
        │ D1 (SQLite)    │     │ R2 providers     │   │ KV (optional)    │
        │ source of      │     │ primary bucket   │   │ 30 s cache for   │
        │ truth          │     │ + 0..n extra     │   │ GET /api/config  │
        └────────────────┘     │ accounts/buckets │   └──────────────────┘
                               └──────────────────┘
```

## Components

| Path | Responsibility |
| --- | --- |
| `worker/src/index.ts` | Worker entrypoint; exports `fetch`. |
| `worker/src/app.ts` | Hono app: middleware, health/config, route mounting, 404/onError. |
| `worker/src/auth/` | Registration, login, refresh rotation, logout, RBAC middleware, password policy. |
| `worker/src/catalog/` | Track/album/artist browsing, search, playlists, serialisation. |
| `worker/src/library/` | Favourites, play history, "my uploads" aggregate. |
| `worker/src/uploads/` | Upload init → bytes → complete, validation, metadata extraction, dedupe. |
| `worker/src/metadata/` | Dependency-free ID3v2/v1, FLAC, MP4, Ogg/Opus, WAV parsers. |
| `worker/src/storage/` | Provider registry, R2 binding adapter, S3/SigV4 adapter, routing, health, integrity, migration. |
| `worker/src/streaming/` | Byte-range serving, signed URLs, authorization, artwork, redirect vs proxy. |
| `worker/src/moderation/` | Listener reports. |
| `worker/src/admin/` | Storage administration, moderation actions, stats, users, settings, audit. |
| `worker/src/utils/` | Errors, logging, ids, hashing, ranges, rate limiting, Turnstile, audit writer. |
| `database/migrations/` | D1 schema, applied by wrangler **or** `scripts/validate-migrations.mjs`. |
| `web/` | React 19 admin console (no audio engine of its own beyond a moderation preview). |
| `tests/` | Vitest: pure units + full API integration against an in-memory D1/R2/KV. |

## Request lifecycle

1. `app.ts` middleware assigns a request id, security headers and a logger.
2. CORS is applied from `ALLOWED_ORIGINS` (wildcard only when unset, and logged as such).
3. `/api/*` loads cached settings and **optionally** resolves the caller. Attachment is
   best-effort: handlers decide whether authentication is required.
4. The route handler validates input with a `zod` `strictObject`, performs the D1 work in a
   single statement or an explicit transaction-like sequence, writes an audit row where the
   action is privileged, and returns JSON.
5. Errors become a stable envelope:
   ```json
   { "error": { "code": "VALIDATION_FAILED", "message": "…", "details": {}, "requestId": "…" } }
   ```
   Internal errors never leak stack traces; they return a short fingerprint that matches
   the structured log line.

## Data model (D1)

```
users ──┬─< sessions
        ├─< tracks >─ artists
        │        └─> albums
        ├─< playlists ─< playlist_tracks
        ├─< favorites
        ├─< play_history
        ├─< upload_jobs >─ storage_objects >─ storage_providers
        ├─< moderation_reports
        └─< audit_logs
tracks ─< storage_objects          playback_errors
```

Key decisions:

* **Track IDs are stable and storage-independent** (`trk_…`). Bytes live in
  `storage_objects`; moving a file between providers only rewrites the primary pointer, so
  playlists, favourites, history and Media3 caches survive.
* `tracks.status` (`pending`/`approved`/`rejected`/`removed`) and `tracks.visibility`
  (`private`/`public`) are separate from `is_deleted` (soft delete). The public view
  `public_tracks` requires `approved + public + rights_confirmed + not deleted`.
* `storage_providers` stores connection metadata and a **credential reference**, never a
  credential. `capacity_bytes` is nullable: unknown stays unknown.
* A partial unique index allows exactly one primary `audio` object per track, and dedupe is
  enforced by a unique index on `storage_objects.sha256` for primary audio objects.
* `upload_jobs` records the intent and outcome of every upload, including failures, so the
  console can explain what went wrong and quotas can be computed from real usage.

## Storage abstraction

`StorageAdapter` (in `worker/src/storage/types.ts`) is the only surface the rest of the
application sees:

```ts
head(key)                              → size, etag, content type
get(key, range?)                       → stream + total size + slice size
put(key, bytes, options)               → small objects only (artwork, checksums)
delete(key)
list(prefix, limit)
presignGet(key, ttl) / presignPut(…)   → null when unsupported
probe()                                → healthy | degraded | error | unconfigured
```

Two adapters ship today:

* `BindingStorageAdapter` — uses the `MUSIC_BUCKET` R2 binding. No credentials, no signing,
  supports streamed uploads; playback is proxied by the Worker (byte ranges preserved).
* `S3StorageAdapter` — talks to the R2 or any S3-compatible endpoint with SigV4. Enables
  presigned browser uploads and 302 redirects to signed URLs. It refuses streamed writes on
  purpose: SigV4 payload hashing would require buffering files in Worker memory.

Adding a provider kind means implementing this interface and registering it in
`createAdapter()`. Nothing in the catalogue, streaming or moderation code changes. See
`docs/STORAGE.md`.

## Upload pipeline

```
POST /api/upload/init     validate size/mime/rights, pick provider, create job (expires)
  ├─ direct   → presigned PUT straight to R2, then POST /api/upload/complete
  └─ worker   → PUT /api/upload/:jobId/file (streamed through the Worker)
POST /api/upload/complete verify size + SHA-256 + magic bytes, extract metadata/artwork,
                           store the object, create the track (pending, private, rights
                           recorded), mark the job, write audit rows
```

Guarantees:

* Nothing becomes public automatically (unless the operator opts in with
  `autoPublishUploads`, which still requires rights confirmation).
* Declared MIME, sniffed MIME and extension must agree; mismatches delete the object and
  fail the job.
* A second upload of identical bytes is rejected with `409 duplicateTrackId`.
* Completion is idempotent and single-claim, so a retried `complete` cannot double-create.

## Playback paths

```
GET /api/stream/:id
  ├─ resolve the best active copy (primary, then secondaries by provider priority)
  ├─ authorize (public track OR uploader OR staff; signed token for external players)
  ├─ redirect mode: 302 to a presigned R2 URL (no bytes through the Worker)
  └─ proxy mode:    200/206 with Content-Range, Accept-Ranges, Content-Length
GET /api/stream/:id/url  → JSON { url, expiresAt, mode } for clients that need a URL
GET /api/artwork/:id     → cached artwork with immutable caching when public
```

`STREAM_MODE=auto` redirects only when it is safe to do so (no `Range` request, provider can
presign). Seeking works in both modes: proxy mode answers `Range` requests itself, redirect
mode hands the range request to R2.

## Caching strategy

| Layer | Used for | Why |
| --- | --- | --- |
| Per-isolate settings cache (30 s) | `app_settings` | Avoid a D1 read on every request. |
| Workers KV (30 s) | `GET /api/config` only | Identical for every caller; invalidated on settings/provider changes. |
| R2/HTTP caching | Audio, artwork | `ETag`/`Range` and immutable artwork headers. |
| D1 | Everything else | The only source of truth; no stale reads for auth, quotas, moderation. |

Audio never flows through KV.

## Failure behaviour

| Failure | Behaviour |
| --- | --- |
| No enabled provider | `POST /api/upload/init` → `503`; `GET /api/config` reports `upload.enabled = false`. |
| Provider credentials missing | Health `unconfigured` (never "healthy"), upload routing skips it, playback falls back. |
| Primary object missing | Streaming falls back to a secondary copy; if none, `503`. |
| Object tampered | `POST /api/admin/storage/verify` marks it `corrupt`; it is no longer served. |
| Provider outage | `503` from streaming (with the provider id in logs); uploads route elsewhere if possible. |
| D1 unavailable | `/api/health` → `503` with `checks.database = false`. |

## Non-goals

* No DRM, no transcoding, no waveform generation, no recommendation engine.
* No second player and no changes to the Android Media3 engine: the API returns standard
  HTTP audio with correct MIME types and byte ranges, which is what Media3 already expects.
* No pooled free tiers: capacity is only what an operator records, and each provider is a
  separate account/bucket.
