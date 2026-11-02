# Storage

AETHER stores audio in Cloudflare R2 and exposes **one** library regardless of how many
providers are registered. This document explains the model, the routing rules, and the
operational flows.

## 1. Provider model

One row in `storage_providers` is one physical location:

| Column | Meaning |
| --- | --- |
| `id` | `prv_…`, referenced by every stored object. |
| `name` | Unique operator-facing label. |
| `kind` | `r2` or `s3`. |
| `account_id` | Cloudflare account id (or S3 account), for humans. |
| `bucket_name` | The bucket. |
| `endpoint` | API root **without** a bucket path, e.g. `https://<account>.r2.cloudflarestorage.com`. |
| `region` | `auto` for R2. |
| `auth_mode` | `binding` or `credentials`. |
| `credential_ref` | Name of a Worker secret namespace — **never a secret**. |
| `priority` | Lower is tried first for reads; uploads prefer the lowest-priority healthy provider. |
| `enabled` | Disabled providers are skipped entirely. |
| `capacity_bytes` | `NULL` unless an operator records the real entitlement. |
| `health_*` | Result of the last explicit probe. |

### Auth modes

**`binding`** — uses the Worker's `MUSIC_BUCKET` R2 binding.

* No credentials anywhere.
* Presigning is impossible, so uploads stream through the Worker and playback is proxied by
  the Worker with HTTP byte ranges.
* Cheapest and simplest for the primary bucket.

**`credentials`** — talks to the S3 API with SigV4 using secrets named:

```
R2_<REF>_ACCESS_KEY_ID
R2_<REF>_SECRET_ACCESS_KEY
R2_<REF>_SESSION_TOKEN      (optional, temporary credentials)
```

`<REF>` is the `credential_ref` uppercased with non-alphanumerics replaced by `_`. Example:
`credential_ref = "secondary-eu"` → `R2_SECONDARY_EU_ACCESS_KEY_ID`.

* Enables presigned uploads (browser → R2 directly) and 302 playback redirects.
* The API reports **which secret names are missing**, never their values.

### Capacity: no invented numbers

The console shows capacity only when it was recorded, and computes utilisation only then.
`GET /api/admin/storage` returns `totalCapacityBytes: null` unless *every* provider has a
recorded capacity. Free-tier allowances are not pooled, inferred or assumed.

## 2. Object layout

```
audio/<trackId>/<sha256-prefix>/<sanitised-filename>
artwork/<trackId>/<sha256-prefix>.<ext>
```

`storage_objects` records `provider_id`, `bucket_name`, `object_key`, `role`
(`audio`/`artwork`), `size_bytes`, `content_type`, `sha256`, `is_primary`, `status`
(`active`/`missing`/`corrupt`/`pending_delete`/`deleted`) and timestamps.

Constraints worth knowing:

* Exactly one `is_primary = 1` audio object per track (partial unique index).
* Primary audio objects have a unique `sha256` — that is the dedupe mechanism.
* `status = 'corrupt'` is set by the integrity check; such objects are excluded from
  playback until re-uploaded or re-migrated.

## 3. Routing

### Uploads

`routing.ts` picks the first provider that is:

1. `enabled = 1`,
2. not in `error`/`unconfigured` health,
3. credentials resolvable,

ordered by `priority ASC`, then by fewest stored bytes (light balancing). No candidate →
`503` with an explicit message; the API never fabricates a provider.

### Playback

`loadObjectCandidates()` returns every active audio copy for the track, primary first, then
by provider priority. Streaming tries them in order:

* a missing object (404/`null`) falls through to the next copy;
* a provider that throws (outage, missing credentials) falls through and is logged;
* if no copy can be served → `503`, not `404`, because the track exists.

This is what makes a second storage location useful without touching the catalogue.

## 4. Upload modes

| Mode | When | Byte path |
| --- | --- | --- |
| `direct` | Provider can presign (credentials mode) | Browser → R2 directly via presigned PUT |
| `worker` | Provider is the binding | Browser → Worker (`PUT /api/upload/:jobId/file`) → R2 |

Both modes:

* validate declared size against `uploadMaxBytes` and the per-user daily quota,
* verify size, SHA-256 and magic bytes on `complete`,
* extract metadata and embedded artwork server-side,
* create the track as `pending` + `private`, with the rights confirmation recorded,
* never publish automatically unless an operator enables `autoPublishUploads`.

Uploads have a TTL (`uploads.expiresAt`); expired jobs are reported as `expired` and can be
cancelled with `POST /api/upload/:jobId/cancel`.

## 5. Streaming modes

`STREAM_MODE` (default `auto`):

| Mode | Behaviour |
| --- | --- |
| `redirect` | Always ask the adapter for a presigned GET and `302` to it. Battery-cheap for the Worker, ideal for R2 egress-free playback. |
| `proxy` | Always stream through the Worker with byte ranges. Needed for binding-mode providers. |
| `auto` | Redirect **only** when the provider can presign and the request is not a `Range` request; otherwise proxy. |

In both modes the response includes `Accept-Ranges: bytes`, the correct `Content-Type` and
`Content-Length`, and `Content-Range` for `206` responses. Seeking therefore works in the
existing web player and in Android Media3 without client changes.

Owner-only (unpublished) audio is served with `Cache-Control: private, no-store`; published
audio is cacheable. Artwork for public tracks is served `immutable`.

### Signed URLs

`GET /api/stream/:id/url` returns `{ url, expiresAt, mode }`. In proxy mode the URL contains
`exp` and `sig` query parameters (HMAC-SHA256 over track id + expiry, keyed by `JWT_SECRET`).
Tampering or expiry → `404`. Signed URLs are for players that cannot send an `Authorization`
header (for example an external player or a `<audio src>` in a different origin).

## 6. Health

A provider is healthy only when a real request succeeds:

* binding: `MUSIC_BUCKET.head('__aether_healthcheck__')` does not throw;
* credentials: signed `HEAD <endpoint>/<bucket>` returns 2xx.

Any other outcome maps to `unconfigured` (missing secrets), `error` (auth/404/network) or
`degraded` (unexpected status). Probes are explicit (`POST /api/admin/storage/health/:id/check`
or `GET /api/admin/storage/health`), so the dashboard never guesses.

## 7. Integrity

`POST /api/admin/storage/verify` streams the object through the Worker, recomputes SHA-256,
compares it with the recorded hash and records `verified_at`/`status`. Mismatch → `corrupt`
(excluded from playback) and an audit entry. This is an explicit action because it costs one
full read per object.

## 8. Migration between providers

`POST /api/admin/storage/migrate { trackId, targetProviderId, deleteSource }`:

1. reads the primary audio object,
2. copies it to the target (streamed when the target supports streaming writes, otherwise a
   single buffered PUT bounded by `storageMigrationMaxBytes`, default 25 MiB),
3. verifies the SHA-256 of the copy,
4. flips `is_primary` in one step,
5. optionally deletes the source copy,
6. writes an audit entry.

The track ID never changes, so playlists, favourites, history and Media3 caches remain valid.

For objects larger than the limit, use `scripts/storage-copy.mjs` (wrangler/rclone) and then
verify with the integrity endpoint.

## 9. Adding a new provider kind

1. Implement `StorageAdapter` in `worker/src/storage/` (for example, a B2/S3 variant).
2. Register it in `createAdapter()` in `worker/src/storage/registry.ts`.
3. Add the kind to the `kind` CHECK constraint in a **new** migration (never edit an applied
   one) and to the admin schema enum.
4. Add unit tests with a stubbed `fetch` (see `tests/worker/s3-adapter.test.ts`).

Nothing in `catalog/`, `library/`, `moderation/` or `streaming/` needs to change.

## 10. Costs and limits (verify against Cloudflare's current pricing)

| Item | Free tier (typical) | Beyond |
| --- | --- | --- |
| R2 storage | 10 GB-month | per GB-month |
| R2 Class A (writes/lists) | 1 M/month | per million |
| R2 Class B (reads) | 10 M/month | per million |
| R2 egress | free | free |
| Workers requests | 100 k/day | paid plan |
| Worker CPU | **10 ms/invocation** | 30 s on paid |
| D1 rows read | 5 M/day | paid plan |
| KV reads/writes | 100 k reads, 1 k writes/day | paid plan |

**Important:** password hashing with PBKDF2 at 210 000 iterations exceeds the free plan's
10 ms CPU budget. On the free plan set `PASSWORD_HASH_ITERATIONS` to a value you have
measured, or move to the paid plan (recommended for production). Everything else in the
codebase is designed to stay far below 10 ms per request.
