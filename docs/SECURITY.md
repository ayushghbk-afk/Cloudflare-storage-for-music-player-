# Security

## 1. What the API protects

* **Accounts** — passwords, sessions and roles.
* **Private audio** — uploads are private until a moderator publishes them.
* **Rights** — a track cannot be published without an explicit rights confirmation.
* **Operations** — storage credentials, provider configuration and privileged actions.

## 2. Authentication

| Mechanism | Detail |
| --- | --- |
| Access token | JWT (HS256), 15 minutes by default, signed with `JWT_SECRET` (≥ 32 chars, enforced; the Worker returns 503 for authenticated routes without it). |
| Refresh token | Opaque 256-bit random value; only its SHA-256 hash is stored. Rotated on every use. |
| Reuse detection | Presenting an already-rotated refresh token revokes the whole session family. |
| Sessions | Revocable individually (`DELETE /api/auth/sessions/:id`) and on suspension. |
| Password storage | PBKDF2-SHA256, 210 000 iterations by default, per-user salt, parameters embedded so hashes can be upgraded on login (`needsRehash`). |
| Password policy | ≥ 12 chars, letter + number, not the email local-part, not in a common-password list. |
| Token transport | `Authorization: Bearer`; `?access_token=` is accepted only where a media element cannot set headers. |

The console keeps tokens in `sessionStorage` (cleared when the tab closes) and refreshes once
on `401`. Put the console behind Cloudflare Access in production as defence in depth.

## 3. Authorization

* Roles: `user`, `moderator`, `admin`.
* Role and status are re-read from D1 on **every** request; a demotion or suspension is
  effective immediately rather than at token expiry.
* Ownership checks on playlists, uploads and private tracks.
* Private playlists return `404` (not `403`) to unrelated users so their existence is not
  disclosed.
* Only admins may remove tracks, delete files, change roles, change settings or manage
  storage providers.
* Removing the last active admin, or self-demotion, returns `409`.

## 4. Uploads

* Size limits (`uploadMaxBytes`, per-user rolling 24 h quota, per-user override) are enforced
  before any bytes are accepted.
* MIME is verified three ways: declared value, file extension, and magic bytes. A mismatch
  fails the job and deletes the object.
* The server computes SHA-256 itself; a client-supplied hash mismatch aborts completion.
* Embedded artwork is size-capped and re-served with the detected image type.
* Metadata is parsed by dependency-free, bounds-checked parsers.
* Nothing is public until approved; `autoPublishUploads` still requires rights confirmation.
* Upload URLs expire; expired jobs are marked `expired`.

## 5. Streaming

* Every request is authorised before bytes are read (`public + approved + rights confirmed`,
  or uploader/staff, or a valid signed URL).
* Unpublished audio is `Cache-Control: private, no-store`.
* Signed URLs use HMAC-SHA256 over track id + expiry, keyed by `JWT_SECRET`; tampering or
  expiry → `404`.
* Presigned R2 URLs are short-lived (default 900 s, clamped to SigV4's 7-day maximum).
* The Worker never buffers a whole file: proxy mode streams ranges; redirect mode hands the
  request to R2.
* Provider fallback never widens access: the authorisation decision happens before provider
  selection.

## 6. Storage credentials

* Stored only as Worker secrets (`R2_<REF>_ACCESS_KEY_ID`, `R2_<REF>_SECRET_ACCESS_KEY`,
  optional `_SESSION_TOKEN`).
* D1 stores a **credential reference** (a name), never a value.
* API responses report `missingSecrets` names only. The console never renders a value.
* Audit rows record the credential reference that changed, never the secret.
* No secret is written to logs; error messages include the provider name and status code.

## 7. Abuse protection

| Control | Where |
| --- | --- |
| Cloudflare Turnstile on register/login | `utils/turnstile.ts` (skipped with a warning when unset) |
| Rate limits in D1 | login, register, refresh, upload init, reports, playback telemetry |
| 429 responses | include `Retry-After` |
| Body size limits | JSON bodies are small; audio goes through the upload path only |
| Input validation | `zod` `strictObject` everywhere, so unknown fields are rejected |

Rate limits are keyed by a **salted hash** of the client IP (never the raw address). Audit
rows store the same hash prefix.

## 8. Data handling

* Only a salted SHA-256 prefix of the IP is stored; the raw IP is not persisted.
* User agents are stored for audit entries (bounded length).
* Deleting a user cascades sessions, playlists, favourites and history; tracks are
  `ON DELETE RESTRICT` so an account cannot silently orphan audio.
* Tracks are soft-deleted (`is_deleted = 1`) so the audit trail survives a takedown.

## 9. HTTP hardening

* `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `x-request-id` on every
  response.
* CORS is an explicit allowlist; the wildcard fallback is logged.
* Error responses never include stack traces; internal errors return a fingerprint that maps
  to a log line.
* SQL is always parameterised; `LIKE` patterns are escaped.

## 10. Known limitations

1. **No antivirus scanning.** Audio is validated structurally, not scanned. If you accept
   untrusted uploads at scale, add a scanning step.
2. **No DRM.** Published audio is downloadable by anyone who can play it. Only publish content
   you are licensed to distribute.
3. **Worker CPU budget.** PBKDF2 at 210k iterations exceeds the free plan's 10 ms; use the
   paid plan (recommended) or lower the iteration count with a documented trade-off.
4. **KV is eventually consistent.** It is used only for the `GET /api/config` cache, never for
   permissions. A stale value can advertise an outdated limit but cannot grant access.
5. **Console tokens in `sessionStorage`.** XSS on the console origin would expose a session;
   keep the console on a trusted origin, behind SSO, and avoid third-party scripts.
6. **Rate limiting is D1-based.** It is per-colo and approximate by design; Cloudflare's
   WAF/rate limiting is a stronger complement.
7. **Turnstile is optional.** Without it, registration relies on rate limits alone.
8. **No multi-region replication.** One D1 primary; R2 replication (if desired) is an
   operator choice and does not change the API.

## 11. Reporting a vulnerability

Do not open a public issue for a vulnerability. Contact the repository owner privately with:

* affected endpoint/version,
* reproduction steps,
* impact assessment.

You will get an acknowledgement, and a fix or mitigation plan. Please do not test against
production data you do not own.
