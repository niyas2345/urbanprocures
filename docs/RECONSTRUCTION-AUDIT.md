# Urban Procures reconstruction audit and handoff

## Baseline and source

- Input: `Corrected files(3).zip`, including `urban-procure-merged-cloudflare.zip`. The nested archive's tracked project files match the extracted outer project. The ZIP contains no Git metadata.
- Production observed through Cloudflare: Pages project `urban-procure`, GitHub source `niyas2345/urban-procure`, production branch `main`, latest successful deployment `440e68d0-a6f1-46e3-b881-2ecb4f5d4990`, commit `66a41d4315758b0c8c5e74d7773a540bff65860c` on 2026-09-23. `urbanprocures.com` and `www.urbanprocures.com` are active domains.
- The connected GitHub account cannot read that production repository. **Do not treat this ZIP as the verified current production revision or merge it into `main` blindly.** Compare against that commit and resolve drift first.
- Existing Supabase project: `vdlrwekoyvvspxuyzgrx`, active, with client/vendor/admin profiles, RFQs, quotations, awards, documents, notifications, terms, and `app_admins`. RLS is enabled on listed public tables. This work performs no database mutation.
- Existing Cloudflare Pages uses `npm run build` to `dist`; the snapshot declares D1 `URBAN_PROCURE_DB`, R2 `URBAN_PROCURE_RFQ_DOCUMENTS` and `URBAN_PROCURE_QUOTE_DOCUMENTS`. The production bindings/secrets must be reconciled with the connected project before promotion.

## Architecture retained

The Vite multi-page frontend calls the same-origin Worker API. The Worker verifies Supabase bearer tokens and owns privileged Supabase requests. RFQ and quotation originals go to private server-managed storage; client/vendor/admin data is returned by `/api/desk/bootstrap` according to server role. The reconstruction keeps the API, tables, storage paths, commercial mode, and domain untouched.

| Surface | Route | Backend contract | Access |
| --- | --- | --- | --- |
| Public home and directory | `/`, `/vendors` | `/api/public/stats`, `/api/public/vendors` | Public |
| Registration | `/signup` | `/api/auth/signup`, `/api/terms/accept`, `/api/desk/{client,vendor}-profile` | New client/vendor |
| Sign in and recovery | `/signin`, `/reset-password` | Supabase Auth, `/api/auth/role`, `/api/auth/recover` | Account holder |
| Guest request | `/rfq/new` | `/api/public/rfq` | Public, subject to existing server rules |
| Client workspace | `/client/*` | `/api/desk/bootstrap`, `/api/desk/rfqs`, `/api/rfq-documents/upload`, `/api/desk/rfqs/:id/award`, private document download | Client |
| Vendor workspace | `/vendor/*` | `/api/desk/bootstrap`, `/api/desk/rfqs/:id/quote`, `/api/quotations/documents`, profile update | Verified/invited vendor for protected actions |
| Admin workspace | `/admin/*` | `/api/desk/bootstrap`, `/api/desk/rfqs/:id/{issue,match,invite}`, `/api/desk/vendors/:id/status` | Server-verified admin |

## Changes made

- Rebuilt sign-in, registration, recovery, and all three workspace shells. New workspaces render live server data through `public/js/dashboard.js`, use safe text nodes for dynamic values, expose responsive navigation and explicit loading/empty/error states.
- Canonical routes are handled by `server/static-routes.js`: legacy `.html` links redirect to clean paths with query parameters retained; deep links serve their role page; unknown pages return 404. Public links, sitemap, robots, and recovery redirect were updated.
- Removed reserved-email admin self-registration. A valid admin token must also have a matching `app_admins.user_id` record. `/api/auth/role` returns the server-authoritative role. Client-side email rules no longer grant privilege.
- Vendor registration no longer requests a licence file that the old handler silently ignored. Licence details are saved; document verification needs a separate secure upload endpoint before asking vendors for a file.
- Client terms acceptance is awaited explicitly. The previous `window.fetch` interception is removed.
- Browser tests default to a local preview and refuse production URLs. Mutating account tests require `RUN_MUTATING_E2E=1` and an isolated staging backend.

## Verified and outstanding

`npm test`: 111 passing (including role-grant and routing coverage). `npm run build`: passed. Built Worker route probes: `/`, `/signup`, `/signin`, role deep links 200; unknown 404; `.html` legacy 308 with query retained; `/api/health` 200. These are source and simulated Worker checks, not real account transactions.

Browser-based Playwright tests could not run here because Chromium is absent and its download endpoint returned invalid/blocked content. No production sign-up, password email, private upload, quotation, award, or admin action was executed. The public host could not be fetched directly from this runtime; Cloudflare deployment metadata established the production baseline.

Before production promotion:

1. Get read access to `niyas2345/urban-procure` at `66a41d4…`; compare every changed file, merge into an isolated branch, and review any drift.
2. Configure an isolated preview with the **existing** Supabase project only if live-data staging access is acceptable, or a properly cloned nonproduction backend for mutating tests. Never paste service keys into browser code or this archive.
3. Confirm Pages Worker bindings, Supabase Auth allowed redirect URLs (including the preview origin), email confirmation mode, admin membership, and the real document buckets.
4. Run Playwright in staging for client/vendor registration, confirmation, login, refresh, recovery, RFQ/upload, quotation/upload, admin authorization, award, responsive screens, and URL refresh. Use test accounts and clean up through normal application policy.
5. Promote only after the preview works and the production source diff is reviewed. The new `/api/auth/role` and admin grant check require the existing service-role credential on the Worker.

## Environment checklist

`SUPABASE_URL`, `SUPABASE_ANON_KEY` (publishable), `SUPABASE_SECRET_KEY` **or** `SUPABASE_SERVICE_ROLE_KEY` (Worker only), `PLATFORM_BILLING_MODE`, and the existing D1/R2 bindings in `wrangler.jsonc`. Optional AI/messaging credentials remain as configured in production. Do not commit any secret value. For E2E, use `PLAYWRIGHT_BASE_URL` pointing to an isolated preview and `RUN_MUTATING_E2E=1` only there.

## Commands

`npm ci`, `npm test`, `npm run build`, `npm run test:e2e` (requires installed Chromium). For local route inspection after building: `node scripts/preview-worker.mjs`. The local preview has no privileged credentials; authenticated transactions remain unavailable there.
