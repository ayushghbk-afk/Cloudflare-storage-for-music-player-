# Setup

Everything in this document is local or free-tier by default. The last two steps (creating
real Cloudflare resources and deploying) need **your** Cloudflare account — nothing here
runs them for you.

## 0. Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | ≥ 22.12 | `node:sqlite` is used by the migration validator and tests. |
| npm | ≥ 10 | Ships with Node 22. |
| Cloudflare account | — | Free plan is enough to start (see `docs/DEPLOYMENT.md` for CPU limits). |
| Wrangler | installed by `npm install` | `npx wrangler …` from the repo. |

## 1. Install and verify the code (no credentials needed)

```bash
git clone https://github.com/ayushghbk-afk/Cloudflare-storage-for-music-player-.git
cd Cloudflare-storage-for-music-player-
npm install

npm run typecheck     # worker + tests + web
npm run lint
npm test              # 240+ tests, no network, no Cloudflare account
npm run db:validate   # applies every migration to an in-memory SQLite database
npm run build:web     # builds the admin console into dist/web
```

`npm run check:all` runs all of the above.

## 2. Create the Cloudflare resources (owner action)

```bash
npx wrangler login          # opens a browser; nothing is stored in this repo

npx wrangler d1 create aether-db
npx wrangler r2 bucket create aether-music
npx wrangler kv namespace create MUSIC_CACHE
```

Copy the printed ids into `worker/wrangler.toml`:

* `[[d1_databases]].database_id` ← the D1 `database_id`
* `[[r2_buckets]].bucket_name` ← the bucket you created
* `[[kv_namespaces]].id` ← the KV namespace id

`npx wrangler kv namespace create MUSIC_CACHE` prints a snippet to paste; keep the binding
name `MUSIC_CACHE`.

> The committed values are syntactically valid placeholders so `wrangler dev --local` works
> untouched. `npm run check:env -- --strict` fails while they are still placeholders.

## 3. Secrets

Secrets are **never** committed and never written to D1.

```bash
# Required: signs access tokens (>= 32 chars).
# Generate one locally and paste it when prompted:
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
npx wrangler secret put JWT_SECRET --config worker/wrangler.toml

# Optional but recommended: Cloudflare Turnstile (abuse protection on register/login).
npx wrangler secret put TURNSTILE_SECRET_KEY --config worker/wrangler.toml

# Optional: creates the first administrator on first registration.
npx wrangler secret put BOOTSTRAP_ADMIN_EMAIL --config worker/wrangler.toml

# Optional: credentials for extra providers registered with authMode="credentials".
# The credential reference "secondary" maps to these names:
npx wrangler secret put R2_SECONDARY_ACCESS_KEY_ID     --config worker/wrangler.toml
npx wrangler secret put R2_SECONDARY_SECRET_ACCESS_KEY --config worker/wrangler.toml
```

Public settings (origins, streaming mode, token lifetimes) live in `[vars]` in
`worker/wrangler.toml`. Set `ALLOWED_ORIGINS` to your real web origin(s) before going live.

## 4. Local development

```bash
cp worker/.dev.vars.example worker/.dev.vars     # then edit the values
npm run check:env                                # reports what is missing, prints no values

npm run db:migrate:local                         # apply migrations to the local D1
npm run dev:worker                               # API on http://127.0.0.1:8787
npm run dev:web                                  # console on http://localhost:5173 (proxies /api)
```

The Vite dev server proxies `/api` to the Worker, so the browser never needs CORS locally.

### Create the first administrator

1. Set `BOOTSTRAP_ADMIN_EMAIL` in `worker/.dev.vars` to the address you will register with.
2. `POST /api/auth/register` with that address (the console's login screen does not register;
   use curl or the existing AETHER client):

   ```bash
   curl -s -X POST http://127.0.0.1:8787/api/auth/register \
     -H 'content-type: application/json' \
     -d '{"email":"owner@example.com","password":"A-long-unique-passphrase-9271","displayName":"Owner"}'
   ```

   The account becomes `admin` **only** if no administrator exists.
3. Sign in to the console at http://localhost:5173.

### Register the primary storage provider

The API never invents providers: until one exists, uploads return `503`. In the console go to
**Storage → Add provider** and use:

| Field | Value for the bound bucket |
| --- | --- |
| Name | `primary` |
| Kind | Cloudflare R2 |
| Auth mode | **binding** (uses `MUSIC_BUCKET`, no secrets) |
| Bucket name | the bucket from step 2 |
| Endpoint | `https://<account-id>.r2.cloudflarestorage.com` |
| Priority | `10` |
| Capacity | leave empty unless you know the real entitlement |

Or with curl:

```bash
TOKEN=…   # accessToken from POST /api/auth/login
curl -s -X POST http://127.0.0.1:8787/api/admin/storage/providers \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"primary","kind":"r2","authMode":"binding","bucketName":"aether-music",
       "endpoint":"https://<account-id>.r2.cloudflarestorage.com","priority":10}'
```

The response includes a health report produced immediately. `status: "unconfigured"` means
secrets are missing; `"healthy"` means the bucket answered.

## 5. Add more storage locations

Each additional R2 account/bucket is one provider row plus two secrets. Nothing else changes:
the catalogue stays one library, and playback tries providers by priority.

```bash
# 1) secrets for credential reference "secondary"
npx wrangler secret put R2_SECONDARY_ACCESS_KEY_ID     --config worker/wrangler.toml
npx wrangler secret put R2_SECONDARY_SECRET_ACCESS_KEY --config worker/wrangler.toml
# 2) provider row (credentials mode)
curl -s -X POST https://<worker>/api/admin/storage/providers \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"secondary","kind":"r2","accountId":"<id>","bucketName":"aether-music-2",
       "endpoint":"https://<id>.r2.cloudflarestorage.com","authMode":"credentials",
       "credentialRef":"secondary","priority":50}'
```

Read `docs/STORAGE.md` for routing, capacity honesty and the migration flow.

## 6. Required resources

| Resource | Binding | Required | Free-plan note |
| --- | --- | --- | --- |
| D1 database | `DB` | yes | 5 GB storage, 5 M rows read/day on the free tier. |
| R2 bucket | `MUSIC_BUCKET` | yes | 10 GB storage/month free, egress free; operations are billed beyond the free allowance. |
| KV namespace | `MUSIC_CACHE` | optional | Only caches `GET /api/config`. Remove the binding to disable. |
| Turnstile | secrets | optional | Free. |
| Custom domain | Cloudflare | optional | Needed for a stable API origin. |

## 7. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `503` on auth routes, log `jwt_secret_missing` | `JWT_SECRET` unset or < 32 chars | Set the secret, redeploy. |
| `POST /api/upload/init` → `503 No storage provider…` | No enabled provider row | Register a provider (step 4). |
| Provider health `unconfigured` | `R2_<REF>_…` secrets missing | Set both access key id and secret key. |
| Migrations not applied | `d1_migrations` empty | `npm run db:migrate:remote` (or `--local`). |
| `check:env` fails on placeholders | `wrangler.toml` still has the all-zero ids | Paste the real ids from step 2. |
| Registration works but console refuses login | account is not admin/moderator | Promote it via another admin or `BOOTSTRAP_ADMIN_EMAIL`. |
| Streaming `416` | requested range beyond the file | Client bug; the API reports the real size in `Content-Range: bytes */<size>`. |
