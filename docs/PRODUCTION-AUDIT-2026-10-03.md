# Production audit — 3 October 2026

Status: incomplete; production readiness is not established.

## Verified observations

- `https://www.urbanprocures.com/` returned HTTP 200 and rendered the current homepage in the cloud browser. Preserve that design and original logo.
- Homepage Get quotes navigation reached `/rfq/new`. Submitting the empty form focused Full Name without creating a request.
- Sign-in navigation reached `/signin` with the client/vendor/admin entry point.
- `/api/native/health` returned `ok: true`, `database: true`, `emailConfigured: true`, `turnstileConfigured: true`.
- `/api/health` returned `ok: true`, `supabaseConfigured: true`, `mailConfigured: true`.
- Health flags establish configuration presence, not successful email delivery, migration completeness, document persistence, or recovery capability.
- Production build stamp: `2026-09-24-auth-qa-3`, built at `2026-09-29T03:47:55.144Z`; it does not identify a Git commit.
- Accessible GitHub main: `2d06255fec839135212044f9d507f95033c6c9f0`. Its homepage differs from the live homepage. Some assets match, but production equivalence is not established.
- `production-rebuild` at `572cd1f8d2fbafb213531c410710c10329d59224` lacks newer native server, frontend and migration files. Do not promote this older branch.
- The historical repository `niyas2345/urban-procure` returned Not Found through the connected GitHub account.
- Cloudflare dashboard remained on a security-verification page after one reload. No deployment logs, private records, bindings, secrets, or backup settings could be inspected.

## Tested fixes in this branch

- Revoke the same native session token on logout whether authenticated by cookie or bearer. Tests prove the revoked token subsequently receives 401.
- Reject cookie-authenticated writes marked `Sec-Fetch-Site: cross-site`, including requests missing Origin. Existing foreign/null Origin rejection remains.
- Preserve exact password characters in login, registration and reset forms; continue trimming ordinary text fields.
- Unit suite: 128 passed, 0 failed. No production account or procurement records were created, changed or deleted during this audit.

## Open source-level gaps

These findings concern accessible main; establish their presence in the deployed revision before applying fixes.

1. Native password hashing uses one salted SHA-256 digest. Replace with a versioned password KDF compatible with Workers; preserve existing accounts through a tested migration and upgrade path.
2. Public requests create RFQs with `public_request_id` but no `client_company_id`; the award endpoint requires a client-owned company. No public-owner authorization/award endpoint is implemented here. Provide an authenticated owner or scoped expiring owner link, with client-only award confirmation and no admin substitution.
3. Password-reset requests ignore the mail provider delivery result, while the UI says a link was sent. Implement a durable retry/outbox path and accurate user messaging without account enumeration.
4. No test files previously exercised the native API handlers directly. The existing 122 passing tests mostly cover legacy paths and shared modules; expand native integration tests with actual D1/R2 behavior.
5. Verification/reset token consumption reads and updates separately. Make consumption atomic and prove one-time behavior under concurrent requests.
6. Retained Supabase legacy API paths mean complete Cloudflare-only operation is not established. Inventory callers and data before removing legacy paths.

## Required completion evidence

- Identify the production Worker source commit, routing and deployment integration; reconcile without replacing the live homepage.
- Verify D1 migrations, R2 private access, least-privilege credentials, scheduled jobs, backup/restore, alerting and rollback.
- Exercise client/vendor registration, real email verification, login/logout, password recovery, and admin review with disposable test accounts.
- Exercise public and contractor RFQ intake, uploads, admin file viewing, sanitization, invitations, quotations, owner award, identity release and service-charge calculation.
- Confirm general fees remain 2.5% with AED 500 minimum; manpower remains AED 1 per labourer-hour; optional public site visit remains AED 100.
- Verify responsive layout, clean URLs, refresh, unauthorized access and cross-party isolation on the deployed revision.
- Confirm actual email receipt and provider failures/retry; configuration flags alone are insufficient.
- Remove disposable test records through an authorized reversible cleanup path and record results.

No deployment, database migration or permanent production change was performed by this audit. Production sign-off remains blocked on source/deployment reconciliation and privileged backend access.
