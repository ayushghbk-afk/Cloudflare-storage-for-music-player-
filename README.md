# AETHER Cloud

Cloud infrastructure for **AETHER**, the existing React/TypeScript music player with a native
Android (Media3) client: audio in **Cloudflare R2**, catalogue in **D1**, one API on
**Cloudflare Workers**, optional **KV** caching, **Turnstile** abuse protection, and GitHub as
the source of truth.

One library, whichever R2 location a file physically lives in. No second player: the existing
web player and the existing Android playback engine keep working, and the API speaks the HTTP
they already understand (JSON, MIME types, byte ranges).

```
existing AETHER clients ──▶ Worker API ──┬── D1 (catalogue, users, uploads, audit)
                                         ├── R2 provider #1 (binding)
                                         ├── R2 provider #2..n (S3 API + secrets)
                                         └── KV (30 s cache for GET /api/config)
```

## Status

| Area | State |
| --- | --- |
| Worker API (Hono + zod, Cloudflare runtime only) | implemented |
| D1 schema (5 migrations) | implemented, validated |
| R2 provider registry (binding + S3/SigV4 adapters) | implemented, unit-tested |
| Uploads (presigned + proxied) with metadata/artwork extraction | implemented, integration-tested |
| Streaming (byte ranges, signed URLs, redirect/proxy, fallback) | implemented, integration-tested |
| Auth, RBAC, moderation, admin, audit | implemented, integration-tested |
| Admin console (`web/`) | implemented, builds |
| Tests | **241 passing** (`npm test`), no Cloudflare account required |
| Live Cloudflare resources | **not created** — needs the owner's account (see `docs/SETUP.md`) |
| Production deployment | **not performed** — gated manual workflow (see `docs/DEPLOYMENT.md`) |

## Quick start

```bash
npm install
npm run check:all            # typecheck + lint + 241 tests + migration validation + web build

cp worker/.dev.vars.example worker/.dev.vars   # set JWT_SECRET (>= 32 chars) and ALLOWED_ORIGINS
npm run db:migrate:local
npm run dev:worker           # API      → http://127.0.0.1:8787
npm run dev:web              # console  → http://localhost:5173  (proxies /api)
```

Then, once, create the primary storage provider (the API never invents one) — see
`docs/SETUP.md` §4 for the console form and the equivalent `curl`.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, request lifecycle, data model, storage abstraction, upload/streaming pipelines, caching, failure modes. |
| [docs/SETUP.md](docs/SETUP.md) | Zero-credential local start, Cloudflare resource creation, secrets, first admin, first provider, troubleshooting. |
| [docs/STORAGE.md](docs/STORAGE.md) | Provider model, auth modes, routing, capacity honesty, integrity, migration, adding a new provider kind, costs. |
| [docs/API.md](docs/API.md) | Every endpoint with shapes, status codes, ranges/signed URLs and examples. |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Environments, migrations, deploy and rollback, CI gating, operations, capacity notes. |
| [docs/SECURITY.md](docs/SECURITY.md) | Auth internals, RBAC, upload validation, streaming security, rate limits, known limitations. |
| [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) · [CHANGELOG.md](CHANGELOG.md) | Contribution rules, disclosure policy, change history. |

## Repository layout

```
worker/            Cloudflare Worker (API) + wrangler.toml + .dev.vars.example
  src/app.ts       Hono app: middleware, health, config, route mounting
  src/auth/        register, login, refresh rotation, RBAC
  src/catalog/     tracks, albums, artists, search, playlists
  src/library/     favourites, history, "my uploads"
  src/uploads/     init → bytes → complete, validation, metadata
  src/metadata/    ID3, FLAC, MP4, Ogg/Opus, WAV parsers (no dependencies)
  src/storage/     provider registry, R2 binding + S3 SigV4 adapters, health, integrity, migration
  src/streaming/   byte ranges, signed URLs, authorization, artwork, redirect/proxy
  src/admin/       storage, moderation, stats, users, settings, audit
database/          migrations 0001…0005
web/               React 19 admin console (Vite)
tests/             unit + full-API integration tests (in-memory D1/R2/KV)
scripts/           validate-migrations, list-migrations, check-env, storage-copy
docs/              architecture, setup, storage, API, deployment, security
```

## API at a glance

```
GET    /api/health · /api/config
POST   /api/auth/{register,login,refresh,logout}
GET    /api/auth/me · PATCH /api/auth/me
GET    /api/tracks · /api/tracks/:id · /api/tracks/:id/similar · /api/search
GET    /api/albums · /api/albums/:id · /api/artists · /api/artists/:id
GET    /api/stream/:id · HEAD /api/stream/:id · GET /api/stream/:id/url · GET /api/artwork/:id
POST   /api/upload/init · PUT /api/upload/:jobId/file · POST /api/upload/complete
GET    /api/upload/status/:jobId · DELETE /api/upload/:jobId
GET    /api/library · /api/library/favorites · /api/library/history
GET    /api/playlists · POST /api/playlists · /api/playlists/:id[/tracks]
POST   /api/tracks/:id/report · POST /api/playback/errors
GET    /api/admin/{stats,audit,users,settings,uploads,playback-errors}
GET    /api/admin/tracks · POST /api/admin/tracks/:id/{approve,reject,remove}
GET    /api/admin/reports · POST /api/admin/reports/:id/resolve
GET    /api/admin/storage · POST /api/admin/storage/providers · PATCH|DELETE …/providers/:id
GET    /api/admin/storage/health · POST /api/admin/storage/{health/:id/check,verify,migrate}
```

## Security posture (short version)

* JWT access tokens + hashed, rotating refresh tokens with reuse detection; PBKDF2 passwords.
* Roles re-read from D1 on every request; suspension takes effect immediately.
* Uploads are private and pending until a moderator approves **and** rights are confirmed.
* Provider credentials live only in Worker secrets, referenced by name; responses show which
  secret names are missing, never values.
* Streaming is authorised per request and prefers a 302 to a short-lived presigned URL, so the
  Worker never buffers a whole file.
* No secret is committed: `.env.example` and `worker/.dev.vars.example` hold placeholders only.

Known limitations (no antivirus, no DRM, free-plan CPU budget, KV eventual consistency, console
token storage) are listed in `docs/SECURITY.md` §10.

## What still needs the owner

1. Create the D1 database, R2 bucket and (optional) KV namespace; paste the ids into
   `worker/wrangler.toml`.
2. Set Worker secrets (`JWT_SECRET` required; Turnstile and `R2_<REF>_*` optional).
3. Apply migrations to the remote D1 and deploy the Worker.
4. Register the first storage provider and confirm its health shows `healthy`.
5. Tag releases `v0.1.0 → … → v1.0.0` when satisfied (tags are not pushed by automation).

No billing or credentialed Cloudflare action has been performed from this repository.

---

## Appendix — original AETHER specification (kept verbatim)

The text below is the specification this implementation was built against. It is preserved
unchanged for reference; where it and `docs/` differ, `docs/` describes what the code does.

---

PROJECT: AETHER PUBLIC MUSIC CLOUD

You are the lead software architect, senior backend engineer, DevOps engineer, and security engineer for AETHER.

Your task is to build the complete cloud infrastructure for AETHER, an existing React/TypeScript music player that also has a native Android playback implementation.

1. MAIN OBJECTIVE

Build a public music library using:

- Cloudflare R2 for audio file storage.
- Cloudflare Workers for the central backend API.
- Cloudflare D1 for the central database.
- Cloudflare Workers KV only where useful for caching.
- Cloudflare Turnstile for abuse protection where appropriate.
- GitHub for source control, version history, releases and deployment automation.

The architecture must support multiple authorized R2 storage locations connected through one central API.

The end user must experience ONE unified music library, regardless of where a song is physically stored.

Do not build a separate music player. Integrate with the existing AETHER application.

2. FIRST: INSPECT THE EXISTING REPOSITORY

Before writing code:

1. Inspect the complete repository structure.
2. Identify the frontend framework and existing architecture.
3. Identify the current music library implementation.
4. Identify the existing audio playback engine.
5. Identify the Android native playback implementation.
6. Identify existing authentication, metadata and database systems.
7. Identify existing upload functionality.
8. Identify existing API services and environment variables.
9. Identify the current build and deployment process.

Do not overwrite working functionality.

Do not remove existing features.

Do not replace the native Android playback engine unnecessarily.

Create an implementation plan based on the actual repository.

3. STORAGE ARCHITECTURE

Build a modular storage provider system.

Initial provider:

- Cloudflare R2.

Architecture must support adding more authorized storage providers in the future.

Each provider must have:

- Provider identifier.
- Account identifier.
- Bucket name.
- Endpoint.
- Connection status.
- Storage capacity information where available.
- Health status.
- Credential reference.
- Priority.
- Enabled/disabled status.

Never assume every provider has identical APIs or free quotas.

Never assume that multiple Cloudflare accounts can legally pool free allowances. Respect provider terms, account eligibility and billing rules.

Do not create fake storage capacity or unlimited storage claims.

The system must support:

- Storage registration.
- Provider health checks.
- Upload routing.
- File location indexing.
- Storage usage monitoring.
- Provider failure handling.
- Duplicate detection.
- Optional migration between providers.
- File integrity verification.

Build the provider architecture so additional legitimate providers can be integrated later.

4. CENTRAL API

Create one Cloudflare Worker API.

Suggested endpoints:

Authentication:

- POST /auth/register
- POST /auth/login
- GET /auth/me

Music:

- GET /tracks
- GET /tracks/:id
- GET /search
- GET /albums
- GET /artists

Uploads:

- POST /upload/init
- POST /upload/complete
- GET /upload/status/:id

Streaming:

- GET /stream/:id
- GET /stream/:id/url

Library:

- GET /library
- POST /library/favorites
- DELETE /library/favorites/:id

Storage administration:

- GET /admin/storage
- POST /admin/storage/providers
- PATCH /admin/storage/providers/:id
- GET /admin/storage/health

Moderation:

- GET /admin/reports
- POST /admin/tracks/:id/approve
- POST /admin/tracks/:id/reject

These are proposed endpoints. Adapt them to the existing architecture and avoid unnecessary duplication.

5. DATABASE

Create the D1 database schema and migrations.

Include tables for:

- users
- tracks
- artists
- albums
- playlists
- playlist_tracks
- favorites
- play_history
- storage_providers
- storage_objects
- upload_jobs
- moderation_reports
- audit_logs

Every track must have a stable ID independent of its physical storage location.

The database must know:

- Who uploaded a track.
- Who owns or administers it.
- Whether it is public or private.
- Whether it is approved for public streaming.
- Which storage provider contains it.
- Which bucket contains it.
- Its object key.
- Its file format and size.
- Its metadata and artwork.
- Its integrity hash.

Create indexes and appropriate foreign keys.

Create database migrations rather than relying on manual database editing.

6. PUBLIC MUSIC LIBRARY

The application must support:

- Public music browsing.
- Search by title, artist and album.
- Album pages.
- Artist pages.
- Playlists.
- Recently played.
- Favorites.
- Music uploads.
- Upload progress.
- Metadata extraction.
- Cover artwork.
- Track reporting.
- Admin moderation.

Users should be able to upload music, but uploads must not automatically become publicly accessible.

Implement:

- Private upload staging.
- File validation.
- Upload size limits configurable by administrators.
- MIME-type verification.
- Metadata extraction.
- Moderation and rights confirmation.
- Public publishing after approval.

Only music that the uploader has permission to distribute may be published.

7. AUDIO STREAMING

Streaming is a critical requirement.

Implement:

- HTTP byte-range requests.
- Partial content responses.
- HTTP 206 support.
- Correct Content-Type.
- Content-Length.
- Accept-Ranges.
- Efficient seeking.
- Temporary signed playback URLs where appropriate.
- Provider fallback when a storage provider is unavailable.

Do not download an entire large audio file into Worker memory.

Do not proxy every audio byte through Worker if a secure redirect to a signed storage URL is possible.

Preserve compatibility with the existing AETHER playback engine and Android Media3.

Test MP3, FLAC, M4A and other formats actually supported by the current player.

8. SECURITY

Implement:

- Secure authentication.
- Role-based permissions.
- Admin and moderator roles.
- Upload ownership checks.
- Private credentials.
- Rate limiting.
- Input validation.
- File size restrictions.
- Upload abuse protection.
- Signed URLs.
- Secure CORS configuration.
- Audit logging.
- Secret management.

Never put R2 secret keys, service credentials or privileged tokens inside frontend code.

Never commit secrets to GitHub.

Create:

- .env.example
- .gitignore
- SECURITY.md
- Security configuration documentation.

Use placeholders for every secret.

9. ADMIN DASHBOARD

Build an admin interface integrated into AETHER.

It should show:

- Total tracks.
- Total registered users.
- Pending uploads.
- Approved public tracks.
- Storage provider status.
- Storage usage.
- Upload failures.
- Playback errors.
- Reported music.
- Provider health.

Allow administrators to:

- Connect storage providers.
- Disable a provider.
- Change provider priority.
- Review uploads.
- Approve or reject music.
- Remove infringing or prohibited content.
- View audit logs.

Do not expose private provider credentials in the dashboard.

10. GITHUB VERSION MANAGEMENT

GitHub must be the source of truth for the project.

Create or update:

- README.md
- CHANGELOG.md
- CONTRIBUTING.md
- SECURITY.md
- LICENSE only if the existing project license permits and its ownership is clear.
- .gitignore
- .env.example

Create GitHub Actions workflows for:

1. Type checking.
2. Linting.
3. Frontend build.
4. Worker tests.
5. Database migration validation.
6. Deployment after explicit configuration.

Use version tags such as:

- v0.1.0 — Initial cloud infrastructure.
- v0.2.0 — Upload system.
- v0.3.0 — Streaming integration.
- v0.4.0 — Public library.
- v1.0.0 — Production release.

Do not automatically deploy to production until the owner explicitly configures and approves deployment.

Never push secrets or generated credentials.

Do not force-push or overwrite existing Git history.

11. DEVELOPMENT FILES

Create all required source files, configuration files, migrations, tests and documentation.

Use a clean modular structure. An example:

cloud/
worker/
src/
index.ts
router.ts
auth/
storage/
streaming/
uploads/
moderation/
admin/
utils/
wrangler.toml
package.json
tsconfig.json

database/
migrations/

frontend/
components/
services/
pages/

tests/
worker/
integration/

scripts/
setup.ts
validate.ts
migrate.ts

.github/
workflows/

docs/
ARCHITECTURE.md
SETUP.md
STORAGE.md
API.md
DEPLOYMENT.md
SECURITY.md

.env.example
.gitignore
README.md
CHANGELOG.md

Adapt this structure to the actual repository. Do not create a second application unnecessarily.

12. IMPLEMENTATION RULES

- Write actual working source code, not pseudocode.
- Do not leave core functionality as TODO comments.
- Do not invent API credentials.
- Do not invent successful connection results.
- Do not create fake storage providers.
- Do not silently change existing application behavior.
- Do not delete existing music files or database records.
- Include error handling and logging.
- Include tests for critical operations.
- Use maintained dependencies.
- Document all commands.
- Keep the code suitable for deployment using GitHub and Cloudflare.

If a feature requires credentials, create the complete implementation with secure placeholders and clearly mark it as awaiting configuration.

13. FINAL TASK: TELL ME EXACTLY WHAT I MUST PROVIDE

After creating the files, STOP before performing any operation that requires my credentials or billing authorization.

Give me a clear setup report containing:

A. Files created.

B. Existing files modified.

C. Dependencies I must install.

D. Cloudflare information I must provide:

- Account ID.
- R2 bucket names.
- R2 endpoints.
- Authorized API credentials.
- Worker deployment configuration.

E. GitHub information I must provide:

- Repository access if needed.
- GitHub Actions secrets.
- Deployment permissions.

F. Database configuration I must provide.

G. Any external services or account permissions needed.

H. Exact step-by-step commands I must run.

I. Features already implemented and tested.

J. Features waiting for my credentials or real-world testing.

K. Expected costs and free-plan limitations.

L. Security risks and production-readiness warnings.

14. FINAL ACCEPTANCE CRITERIA

The project is complete only when:

- The codebase builds successfully.
- Database migrations exist.
- Worker API routes exist.
- Storage adapters work with configured credentials.
- Upload flow is implemented.
- Streaming supports seeking.
- Authentication and permissions are implemented.
- Public and private tracks are separated.
- GitHub workflows are configured.
- Documentation is complete.
- Automated tests pass where credentials are not required.
- The owner receives an exact configuration checklist.

Start by inspecting the existing repository. Then create the implementation files. Do not stop after merely writing a plan.
