# Contributing

AETHER Cloud is the server side of the existing AETHER player. Two rules shape every change:

1. **Do not break existing clients.** The web player and the Android (Media3) player must keep
   working. That means stable JSON shapes, correct MIME types, byte ranges and stable track ids.
2. **Do not fake infrastructure.** No invented capacities, no assumed free tiers, no provider
   that reports healthy without answering, no credentials in the repository.

## Getting set up

```bash
npm install
npm run check:all        # typecheck + lint + tests + migrations + web build
npm run dev:worker       # API on :8787 (local D1/R2/KV emulation)
npm run dev:web          # console on :5173, proxies /api
```

No Cloudflare account is needed for development or tests.

## Project layout

| Path | What belongs here |
| --- | --- |
| `worker/src/` | The API. One folder per concern (`auth`, `catalog`, `uploads`, `storage`, `streaming`, `admin`, …). |
| `database/migrations/` | Append-only SQL migrations (`NNNN_snake_case.sql`). |
| `tests/worker/` | Pure unit tests (hashing, SigV4, ranges, metadata parsers, adapters). |
| `tests/integration/` | Full HTTP tests against the real app with in-memory D1/R2/KV. |
| `web/src/` | The React admin console. |
| `scripts/` | Repo tooling (migration validation, env check, storage copy). |
| `docs/` | Architecture, setup, storage, API, deployment, security. |

## Rules

* **Migrations are append-only.** Editing an applied migration breaks every deployment.
  `npm run db:validate` must pass.
* **No secrets, ever.** `.env.example` and `worker/.dev.vars.example` are the only environment
  files in Git; both contain placeholders.
* **No TODO-only features.** If you add an endpoint, it must work and be tested. A documented,
  deliberate limitation is fine; a stub is not.
* **Validate at the edge.** Every request body goes through a `zod` `strictObject`; unknown
  fields are rejected.
* **Never log secrets.** Log ids, names and statuses. Error messages may name a missing secret,
  never its value.
* **Audit privileged actions.** Admin/moderation actions call `writeAudit()`.
* **Do not buffer audio.** Streaming uses byte ranges or redirects; uploads stream. The only
  intentional buffer is a bounded single PUT for providers that cannot stream writes.
* **Keep the Worker CPU budget in mind.** Free-plan invocations are limited to 10 ms; note the
  cost of new work in the PR.

## Tests

```bash
npm test                                  # everything
npx vitest run tests/integration/auth.test.ts
npm run test:coverage                     # worker/src coverage
```

Integration tests use a real SQLite-backed D1 shim and an in-memory R2 bucket, so they exercise
the actual handlers, migrations and constraints. When you add an endpoint, add a test for:

* the happy path,
* authorisation (anonymous, wrong role, wrong owner),
* validation failures,
* and at least one failure mode (provider down, duplicate, missing object).

## Commits and pull requests

* Write imperative, descriptive commit messages ("reject uploads whose magic bytes disagree",
  not "fix stuff").
* Keep a PR focused; include the migration number if the schema changes.
* The PR must pass `npm run check:all`.
* Never force-push a shared branch and never rewrite published history.
* Do not tag or release without the owner's approval; tags follow `v0.1.0 → v0.2.0 → … → v1.0.0`.

## Documentation

If you change an endpoint, a setting, a provider behaviour or a limit, update the matching
document in `docs/` **in the same PR**. `docs/API.md` is the contract other clients read.
