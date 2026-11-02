# Security policy

AETHER Cloud stores and serves user-uploaded audio. Please treat vulnerabilities accordingly.

## Supported versions

The default branch is the supported version. Releases are tagged `v0.x.y` during the build-out
and `v1.0.0` for the first production-ready version.

## Reporting a vulnerability

**Do not open a public issue.** Contact the repository owner privately with:

* the affected endpoint or file,
* reproduction steps (a failing test is ideal),
* the impact you believe it has.

Do not test against production data you do not own, do not attempt to access other users'
uploads, and do not run load tests against a live deployment.

## Scope

In scope:

* the Worker API in `worker/src/`,
* the admin console in `web/`,
* database migrations and the storage adapters,
* authentication, authorisation, upload validation and streaming.

Out of scope:

* the existing AETHER web/Android players (report those to their own repositories),
* Cloudflare platform behaviour,
* missing hardening that is explicitly documented as a known limitation in
  `docs/SECURITY.md` (for example: no antivirus scanning, no DRM).

## Defence in depth

The full security design — token handling, RBAC, upload validation, signed streaming URLs,
rate limits, credential handling and known limitations — is in **[docs/SECURITY.md](docs/SECURITY.md)**.

## Secrets

No credential belongs in this repository. `.env`, `.dev.vars` and every variant are ignored;
`.env.example` and `worker/.dev.vars.example` contain placeholders only. If you find a
committed secret, report it privately so it can be rotated before disclosure.
