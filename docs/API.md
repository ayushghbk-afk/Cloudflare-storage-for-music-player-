# API reference

Base URL: `https://<worker-host>` (or the Vite proxy at `/api` during development).

* JSON in, JSON out. `Content-Type: application/json` for bodies.
* Authentication: `Authorization: Bearer <accessToken>`. Media endpoints also accept
  `?access_token=<accessToken>` because `<audio>`/Media3 cannot set headers.
* Errors use one envelope:
  ```json
  { "error": { "code": "FORBIDDEN", "message": "…", "details": {}, "requestId": "…" } }
  ```
  Useful codes: `VALIDATION_FAILED` (422), `BAD_REQUEST` (400), `UNAUTHORIZED` (401),
  `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `PAYLOAD_TOO_LARGE` (413),
  `RATE_LIMITED` (429), `SERVICE_UNAVAILABLE` (503), `NOT_CONFIGURED` (503).
* Pagination: `?limit=&offset=`; responses include `pagination: { total, limit, offset }`.
  Default 20–50, hard caps per endpoint (200 for the audit log).
* Every response carries `X-Request-Id`; log lines carry the same id.

## Operational

### `GET /`

```json
{ "service": "aether-public-music-cloud", "version": "0.4.0", "docs": "…", "health": "/api/health" }
```

### `GET /api/health`

No auth. Reports **whether** configuration exists, never values.

```json
{
  "ok": true,
  "version": "0.4.0",
  "environment": "production",
  "checks": { "database": true, "migrations": true, "jwtSecret": true, "turnstile": false,
              "r2Binding": true, "kvCache": true, "storageProvider": true },
  "storage": { "total": 2, "enabled": 2, "healthy": 1 },
  "pendingConfiguration": ["turnstile"]
}
```

`503` when the database or schema is unavailable.

### `GET /api/config`

Public bootstrap, cached in KV for 30 s when bound (`X-Aether-Cache: hit|miss`).

```json
{
  "apiVersion": "0.4.0",
  "environment": "production",
  "turnstile": { "enabled": true, "siteKey": "0x…" },
  "upload": { "maxBytes": 52428800, "allowedMimeTypes": ["audio/mpeg"], "requireRightsConfirmation": true,
              "dailyQuotaBytes": 0, "enabled": true },
  "streaming": { "urlTtlSeconds": 900, "mode": "auto" }
}
```

## Auth

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | public (+Turnstile) | Create an account. First account becomes admin **only** when `BOOTSTRAP_ADMIN_EMAIL` matches and no admin exists. |
| POST | `/api/auth/login` | public (+Turnstile) | Returns access + refresh tokens. |
| POST | `/api/auth/refresh` | refresh token | Rotates the refresh token (reuse is detected and revokes the family). |
| POST | `/api/auth/logout` | access token | Revokes the presented session. |
| GET | `/api/auth/me` | access token | Current user. |
| PATCH | `/api/auth/me` | access token | Change display name / password. |
| GET | `/api/auth/sessions` | access token | List active sessions. |
| DELETE | `/api/auth/sessions/:id` | access token | Revoke one session. |

Register:

```bash
curl -sX POST https://api.example.com/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"a@b.test","password":"A-long-unique-passphrase-9271","displayName":"A","turnstileToken":"…"}'
```

```json
{
  "user": { "id": "usr_…", "email": "a@b.test", "displayName": "A", "role": "user", "status": "active" },
  "accessToken": "…", "refreshToken": "…", "expiresIn": 900
}
```

Password policy: ≥ 12 characters, at least one letter and one number, not containing the
email local-part, not a common password. Failures return `422 VALIDATION_FAILED` with the
specific rule.

## Catalogue

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/tracks` | optional | Public tracks; `?mine=1` shows the caller's own uploads; filters `artistId, albumId, genre, format, year, q, sort, limit, offset`. |
| GET | `/api/tracks/:id` | optional | Public track, or owner/staff. |
| GET | `/api/tracks/:id/similar` | optional | Same artist/genre. |
| GET | `/api/search?q=` | optional | Returns `{ query, tracks, albums, artists }`; case/accent insensitive. |
| GET | `/api/albums` | optional | Albums with only public tracks. |
| GET | `/api/albums/:id` | optional | Album + its tracks. |
| GET | `/api/albums/:id/artwork` | optional | Artwork bytes. |
| GET | `/api/artists` | optional | |
| GET | `/api/artists/:id` | optional | Artist + albums + top tracks. |
| GET | `/api/artists/:id/image` | optional | |

Track shape (abridged):

```json
{
  "id": "trk_…", "title": "Neon Rain",
  "artist": { "id": "art_…", "name": "Aurora Field" },
  "album": { "id": "alb_…", "title": "Night Drive", "year": 2024 },
  "genre": "Synthwave", "year": 2024, "trackNumber": 3, "discNumber": 1,
  "durationMs": 214000, "format": "flac", "mimeType": "audio/flac", "sizeBytes": 31234567,
  "sampleRate": 96000, "channels": 2, "bitDepth": 24, "bitrateKbps": 2400,
  "artworkUrl": "/api/artwork/trk_…", "streamUrl": "/api/stream/trk_…",
  "playCount": 42, "publishedAt": "2026-10-01T…", "createdAt": "2026-09-30T…"
}
```

Unpublished tracks are invisible unless you are the uploader or staff. Removed/rejected
tracks are never listed.

## Playlists, favourites, history

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/playlists` | optional | Public playlists; `?mine=1` for your own. |
| POST | `/api/playlists` | user | Create (`title`, `description?`, `visibility` default private). |
| GET | `/api/playlists/:id` | optional | Private playlists 404 for non-owners. |
| PATCH | `/api/playlists/:id` | owner/admin | |
| DELETE | `/api/playlists/:id` | owner/admin | |
| POST | `/api/playlists/:id/tracks` | owner/admin | `{ trackId, position? }`; duplicates → 409. |
| DELETE | `/api/playlists/:id/tracks/:trackId` | owner/admin | |
| GET | `/api/playlists/:id/artwork` | optional | First track artwork as playlist cover. |
| GET | `/api/library` | user | Favourites, recent plays, uploads and counts in one call. |
| GET/POST | `/api/library/favorites` | user | List / add `{ trackId }`. |
| DELETE | `/api/library/favorites/:trackId` | user | |
| GET/POST | `/api/library/history` | user | List / record `{ trackId, positionMs?, completed?, source?, device? }`. |
| DELETE | `/api/library/history` | user | Clears the caller's history. |

## Uploads

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/api/upload/init` | user | Validate and reserve an upload slot. |
| PUT | `/api/upload/:jobId/file` | owner | Stream bytes (worker mode only). |
| POST | `/api/upload/complete?jobId=` | owner | Verify, extract metadata, create the pending track. |
| GET | `/api/upload/status/:jobId` | owner | Job state. |
| DELETE | `/api/upload/:jobId` | owner | Cancel before completion. |

Init request:

```json
{
  "filename": "neon-rain.flac", "size": 31234567, "mimeType": "audio/flac",
  "rightsConfirmed": true,
  "title": "Neon Rain", "artist": "Aurora Field", "album": "Night Drive",
  "albumArtist": "Aurora Field", "genre": "Synthwave", "year": 2024,
  "trackNumber": 3, "discNumber": 1,
  "turnstileToken": "…", "preferredMode": "auto"
}

Metadata fields are **top level** (they are optional hints; server extraction wins where the
file carries its own tags). `preferredMode` may be `auto` (default), `direct` or `worker`.
```

Response (`201`):

```json
{
  "jobId": "upl_…", "trackId": null, "uploadMode": "direct",
  "uploadUrl": "https://<account>.r2.cloudflarestorage.com/…&X-Amz-Signature=…",
  "method": "PUT", "headers": { "content-type": "audio/flac" },
  "expiresAt": "2026-11-02T11:00:00.000Z", "providerId": "prv_…"
}
```

In `worker` mode `uploadUrl` points at `/api/upload/<jobId>/body` on the API itself.

Complete response:

```json
{ "jobId": "upl_…", "trackId": "trk_…", "status": "pending", "duplicate": false,
  "metadata": { "title": "Neon Rain", "durationMs": 214000, "format": "flac", "sampleRate": 96000, "channels": 2 },
  "artwork": true, "providerId": "prv_…" }
```

Errors worth handling: `413` (too large), `422` (MIME/extension/rights), `409` with
`details.duplicateTrackId`, `503` (no provider), `409` (client hash mismatch or size mismatch
— the object is deleted and the job failed).

## Streaming

### `GET|HEAD /api/stream/:id`

* `200`/`206` with `Accept-Ranges: bytes`, `Content-Length`, `Content-Type` and
  `Content-Range` for partial content. `HEAD` returns the headers with an empty body.
* `302` to a presigned R2 URL in redirect mode.
* `416` with `Content-Range: bytes */<size>` for an unsatisfiable range.
* `404` when the track is invisible to the caller; `503` when every copy is unreadable.
* `Cache-Control: private, no-store` for unpublished audio.

```bash
curl -sI https://api.example.com/api/stream/trk_… -H "authorization: Bearer $TOKEN"
curl -s https://api.example.com/api/stream/trk_… -H 'range: bytes=0-65535' -o part1.bin
curl -s https://api.example.com/api/stream/trk_… -H 'range: bytes=-4096' -o tail.bin   # suffix range
```

### `GET /api/stream/:id/url`

```json
{ "url": "https://…?exp=1762000000&sig=…", "expiresAt": "…", "mode": "proxy", "trackId": "trk_…" }
```

The URL is self-authenticating for its lifetime (default `streamUrlTtlSeconds`, 900 s).
Tampered or expired signatures return `404`.

### `GET /api/artwork/:id`

Owner-only tracks: `private, no-store`. Public tracks: `public, max-age=31536000, immutable`
with an `ETag`; supports `If-None-Match` → `304`.

### `POST /api/playback/errors`

Authenticated or anonymous playback telemetry:

```json
{ "trackId": "trk_…", "code": "MEDIA_ERR_DECODE", "message": "Decoder init failed", "platform": "android" }
```

Unknown track ids are accepted (the reference is dropped); the report is still stored.

## Moderation

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/api/tracks/:id/report` | user | `{ reason, details? }`; one open report per user per track (409 otherwise). |
| GET | `/api/admin/tracks?status=` | staff | Review queue (`pending`, `approved`, `rejected`, `removed`). |
| POST | `/api/admin/tracks/:id/approve` | staff | Publishes; requires `rights_confirmed = 1`. |
| POST | `/api/admin/tracks/:id/reject` | staff | `{ reason }` required. |
| POST | `/api/admin/tracks/:id/remove` | **admin** | `{ reason, deleteFiles? }`; soft delete + optional storage deletion. |
| GET | `/api/admin/reports?status=` | staff | |
| POST | `/api/admin/reports/:id/resolve` | staff | `{ status: resolved|dismissed, note?, action?: none|unpublish|remove }` — `remove` is admin-only. |

## Storage administration (admin only)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/admin/storage` | Providers + usage + honest capacity summary. |
| POST | `/api/admin/storage/providers` | Register and probe. Body: `name, kind, bucketName, endpoint, authMode, credentialRef?, priority, capacityBytes?, notes?`. |
| PATCH | `/api/admin/storage/providers/:id` | Update (endpoint/bucket/credential changes reset health to `unknown`). |
| DELETE | `/api/admin/storage/providers/:id` | Refused while active objects reference it (409). |
| GET | `/api/admin/storage/health` | Probe every provider. |
| POST | `/api/admin/storage/health/:id/check` | Probe one. |
| POST | `/api/admin/storage/verify` | `{ trackId, objectId? }` → recompute SHA-256. |
| POST | `/api/admin/storage/migrate` | `{ trackId, targetProviderId, deleteSource? }`. |

Provider responses never contain credential values:

```json
{
  "id": "prv_…", "name": "secondary", "kind": "r2", "bucketName": "aether-music-2",
  "endpoint": "https://….r2.cloudflarestorage.com", "authMode": "credentials",
  "credentialRef": "secondary", "enabled": true, "priority": 50, "capacityBytes": null,
  "health": { "status": "healthy", "checkedAt": "…", "latencyMs": 42, "message": "Bucket reachable and credentials accepted." },
  "credentials": { "available": true, "mode": "credentials",
                   "requiredSecrets": ["R2_SECONDARY_ACCESS_KEY_ID","R2_SECONDARY_SECRET_ACCESS_KEY"],
                   "missingSecrets": [] },
  "usage": { "usedBytes": 0, "objectCount": 0, "capacityBytes": null, "utilisation": null }
}
```

## System administration (admin only)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/admin/stats` | Counters, per-provider usage, recent failures. |
| GET | `/api/admin/audit` | `?action=&actorId=&limit=&offset=` (max 200). |
| GET | `/api/admin/users` | `?q=&role=`. |
| PATCH | `/api/admin/users/:id` | `{ role?, status?, uploadQuotaBytes? }`. Self-demotion and last-admin removal → 409; suspension revokes sessions immediately. |
| GET | `/api/admin/settings` | Current values + schema (descriptions, bounds, defaults). |
| PATCH | `/api/admin/settings` | Partial update; unknown keys / out-of-bounds → 422. Clears the KV config cache. |
| GET | `/api/admin/uploads` | Upload jobs by status (default `failed`). |
| GET | `/api/admin/playback-errors` | Last 50 playback errors with track titles. |

## CORS and headers

`ALLOWED_ORIGINS` is a comma separated allowlist. When it is unset the API answers `*` and
logs `cors_wildcard` — a deployment checklist item, not a silent default. Preflight answers
`204` with `access-control-allow-methods`, `-headers` (`authorization, content-type,
if-none-match, range`) and `-max-age`. Actual responses expose
`content-length, content-range, accept-ranges, etag, x-request-id`.

All responses set `x-content-type-options: nosniff`, `referrer-policy: no-referrer` and
`x-request-id`.
