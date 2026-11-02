# Deployment

Deployment is **manual and gated**. Nothing in this repository deploys to production on its
own: the deploy workflow requires a typed confirmation and a protected environment, and the
first deploy needs credentials only the owner can provide.

## 1. Environments

| Environment | Worker | D1 | R2 | Notes |
| --- | --- | --- | --- | --- |
| Local | `wrangler dev --local` | local SQLite | local R2 emulation | No account needed. |
| Preview (optional) | separate Worker name | separate D1 | separate bucket | Recommended before production. |
| Production | `aether-api` | `aether-db` | `aether-music` | Real users. |

Never point a preview Worker at the production D1 database: `d1_migrations` would be shared
and the data would be live.

## 2. Pre-flight

```bash
npm install
npm run check:all          # typecheck + lint + 240 tests + migrations + web build
npm run check:env -- --strict
```

`check:env` prints only names/presence, never values. It fails while `worker/wrangler.toml`
still contains the all-zero placeholder ids, when `JWT_SECRET` is missing/short, or when a
credential namespace is half-configured.

## 3. Create resources (once, owner action)

```bash
npx wrangler login
npx wrangler d1 create aether-db
npx wrangler r2 bucket create aether-music
npx wrangler kv namespace create MUSIC_CACHE
```

Paste the ids into `worker/wrangler.toml` (`database_id`, `bucket_name`, KV `id`).

### Secrets

```bash
npx wrangler secret put JWT_SECRET --config worker/wrangler.toml
npx wrangler secret put TURNSTILE_SECRET_KEY --config worker/wrangler.toml      # optional
npx wrangler secret put BOOTSTRAP_ADMIN_EMAIL --config worker/wrangler.toml     # optional
npx wrangler secret put R2_SECONDARY_ACCESS_KEY_ID     --config worker/wrangler.toml
npx wrangler secret put R2_SECONDARY_SECRET_ACCESS_KEY --config worker/wrangler.toml
```

Secrets are additive and never printed by the API. `wrangler secret list` shows names only.

## 4. Apply migrations

```bash
# Inspect first (no credentials, applies to a scratch in-memory DB):
npm run db:validate
npm run db:list

# Apply to production D1:
npx wrangler d1 migrations apply DB --remote --config worker/wrangler.toml
```

Rules:

* Migrations are append-only. **Never** edit a file that has been applied; add the next
  number instead.
* Each file is applied in order and recorded in `d1_migrations` (the same table wrangler
  uses), so wrangler and the local engine stay compatible.
* A file that fails is *not* recorded, but D1 has no cross-statement rollback for DDL:
  inspect the database, repair by hand if a statement partially applied, then re-run.
  `npm run db:validate` exists to catch this before it reaches production.

## 5. Deploy the Worker

```bash
npm run deploy:worker         # wrangler deploy --config worker/wrangler.toml
```

The dry run used in CI is:

```bash
npx wrangler deploy --dry-run --config worker/wrangler.toml --outdir dist/worker
```

Post-deploy smoke test:

```bash
curl -s https://<worker-host>/api/health | jq
curl -s https://<worker-host>/api/config | jq
```

`/api/health` must report `ok: true`, `checks.database: true`, `checks.migrations: true`,
`checks.jwtSecret: true` and at least one storage provider. `pendingConfiguration` lists
anything still missing.

## 6. Deploy the console

```bash
npm run build:web             # dist/web
```

Host `dist/web` on Cloudflare Pages (or any static host) at the same origin as the API, or set
`VITE_API_BASE_URL` at build time and add that origin to `ALLOWED_ORIGINS`.

Because the console holds administrator power, protect it:

* Cloudflare Access (or an equivalent SSO proxy) in front of the console host, **and**
* the API's own role checks (the console is unusable without an admin/moderator token).

## 7. Deploy gating in CI

`.github/workflows/ci.yml` runs on every push and pull request:

typecheck (worker + tests + web) → lint → tests → migration validation → web build → worker
dry-run bundle.

`.github/workflows/deploy.yml` is `workflow_dispatch` only and requires:

1. the `production` GitHub Environment with required reviewers, and
2. typing `deploy-production` into the confirmation input.

It then runs `check:all`, applies migrations, deploys the Worker and prints the health
endpoint. No secrets are echoed. No force-push, no history rewrite.

Required repository secrets (set by the owner, never committed):

| Secret | Used by |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | wrangler (Workers + D1 + R2 edit permissions) |
| `CLOUDFLARE_ACCOUNT_ID` | wrangler |

The Worker's runtime secrets are set with `wrangler secret put`, not GitHub secrets — they
never need to leave Cloudflare.

## 8. Rollback

```bash
npx wrangler deployments list --config worker/wrangler.toml
npx wrangler rollback <deployment-id> --config worker/wrangler.toml
```

Migrations are forward-only. A schema change that must be undone needs a new migration that
restores the previous shape; keep data-destructive steps in a separate, reviewed migration.

## 9. Operations

```bash
npm run cf:tail                                   # live logs (structured JSON)
npx wrangler d1 execute aether-db --remote --command "SELECT COUNT(*) FROM tracks" --config worker/wrangler.toml
```

Watch for these log messages:

| Message | Meaning |
| --- | --- |
| `jwt_secret_missing` | Auth routes return 503. |
| `rate_limited` | A subject hit a limiter (429 to the client). |
| `stream_provider_failed` | A copy could not be read; fallback attempted. |
| `upload_failed` | Job failed with an error code stored in D1. |
| `cors_wildcard` | `ALLOWED_ORIGINS` is unset in production. |
| `unhandled_error` | Bug; the fingerprint correlates with `requestId`. |

## 10. Capacity planning notes

* Workers free plan: 10 ms CPU per invocation. PBKDF2 (210k iterations) needs more — use the
  paid plan, or lower `PASSWORD_HASH_ITERATIONS` after measuring.
* D1: keep hot queries indexed (`idx_tracks_*`, `idx_storage_objects_*`). The audit log grows
  fastest; prune with a scheduled query if needed.
* R2: egress is free; Class A (writes) and Class B (reads) counts matter. Redirect-mode
  playback moves reads to the client directly, which keeps Worker CPU at ~0.
* KV writes are limited on the free plan (1k/day). The only KV writer is the
  `GET /api/config` cache (one write per 30 s per colo, at most).

## 11. What is deliberately not automated

* Creating Cloudflare resources.
* Setting secrets.
* Applying production migrations from CI on push.
* Deploying to production without a human confirmation.
* Pushing tags or rewriting history.

All of those need the owner, and the runbook above is written so they can be done without
guesswork.
