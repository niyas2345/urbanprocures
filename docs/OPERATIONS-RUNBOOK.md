# Release and recovery procedures

This runbook describes procedures. It is not a declaration that a release has passed verification. Keep actual release evidence, recovery bookmarks and credentials in restricted operational records.

## Release

1. Record the current production Git SHA, Pages deployment ID, database schema version and recovery bookmark.
2. Reconcile changes against the deployed frontend. Confirm the approved homepage, logo, colors and navigation remain unchanged.
3. Run `npm test`, `npm run build` and `npm run test:preview-assets` using the supported Node version from `package.json`.
4. Deploy the exact reviewed commit to the preview environment of the existing Pages project. Confirm preview D1, R2, secrets and email recipients are isolated from production.
5. Apply pending versioned migrations to preview. Verify authentication, document access, procurement, public requests, admin workflows, job processing and actual email delivery there. Record outcomes and remove disposable fixtures.
6. Review migration compatibility and rehearse recovery on disposable data. Confirm a known-good native-authentication-compatible rollback deployment exists.
7. Before production migration, create a recovery bookmark and restricted export. Apply only reviewed migrations, then deploy the same tested commit through the controlled production release path.
8. Verify the deployed commit in `/build-stamp.json` and `/api/native/health`. Check production clean routes, controlled disposable account workflows, email delivery and scheduled maintenance. Record the production deployment ID and clean up test records.
9. Enable the existing maintenance schedule only after its authenticated Pages endpoint is verified. Keep business APIs in Pages; the scheduled Worker is only a trigger and health probe.

Stop promotion when a critical or high-priority check fails. A successful build is not an E2E result.

## Application rollback

1. Pause promotion and, if necessary, the maintenance schedule.
2. Select the recorded known-good deployment in the same Pages project. Check compatibility with current schema, password hashing and commercial terms before invoking Cloudflare's production rollback operation.
3. Verify the rollback deployment ID and commit, database health, existing-account login, session revocation, document retrieval and job processing.
4. Resume maintenance after checks pass. Record the reason, times, deployment IDs and validation evidence.

Code rollback does not undo database writes. Do not reverse additive migrations blindly or roll back to an authentication implementation that cannot read current password hashes.

## Database and document recovery

1. Keep an encrypted, access-controlled database export and a current Time Travel bookmark before each production migration. Verify the account's actual retention period; do not assume a retention window.
2. Rehearse restores using disposable databases. Check relational constraints, record counts and application workflows after restoration.
3. For a production incident, pause writes and jobs, record the current bookmark/export, and determine the recovery point. Restore only under explicit incident authorization because later writes may be lost.
4. Restore private R2 objects from separately retained, access-controlled object backups as required. Database restoration does not restore R2 objects.
5. Verify document ownership, private bucket access, sanitized-object relationships and authorized opening before resuming traffic. Never make backup objects public.

## Secret rotation

Rotate one environment at a time through Cloudflare secret settings. Never commit, paste into logs or store secret values in release reports.

- Jobs secret: pause cron, update Pages and the existing trigger Worker together, verify protected processing, then resume.
- Email credentials: verify new credentials with a controlled recipient, update the intended environment, verify retries and revoke replaced provider credentials.
- Email encryption key: drain or securely re-encrypt queued payloads before replacing the key; retained ciphertext requires its original key.
- Rate-limit salt: replace through secret settings and expect existing rate-limit buckets to reset.
- Turnstile secret: rotate through Cloudflare and verify server-side hostname/action checks with a controlled submission.

Revoke exposed sessions and reset/verification tokens when an incident requires it. Preserve access-controlled audit evidence without storing raw credentials or tokens.

## Scheduled maintenance and monitoring

The maintenance trigger probes application database health and the homepage, then calls the protected Pages job endpoint. Public requests to the trigger return 404. The trigger holds no business database or document-storage bindings.

Check Worker exceptions, failed cron invocations, job age, retries, exhausted jobs and notification delivery. Keep logs limited to safe event names and aggregate counters. Do not log recipient addresses, document contents, reset links, passwords or tokens.

After schedule or notification changes, run a controlled execution and a notification delivery test. Provider acceptance of a test notification does not prove inbox receipt. Review alert recipients and perform recovery/rollback rehearsals periodically.
