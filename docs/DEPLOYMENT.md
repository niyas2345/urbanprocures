# Urban Procures deployment runbook

Last reviewed: 2026-09-26.

## Live targets

| Host | Role | Notes |
|---|---|---|
| https://urban-procure.pages.dev | Cloudflare production site | Cloudflare Pages + Worker API |
| https://deploy-preview-5--urbanprocures.netlify.app | Legacy Netlify preview | Historical verification target |
| https://urbanprocures.netlify.app | Old public Netlify URL | Do not use as production source of truth |

## Production stack

- Cloudflare Pages + Workers Paid for the website and API.
- Cloudflare D1 binding `URBAN_PROCURE_DB` for native users, companies, RFQs, quotations, awards, and audit logs.
- Cloudflare R2 bindings `URBAN_PROCURE_RFQ_DOCUMENTS` and `URBAN_PROCURE_QUOTE_DOCUMENTS` for private RFQ and quotation documents.
- Zoho Mail for account verification, password reset, and reviewed outreach.
- Turnstile for public unauthenticated request intake.
- Supabase remains configured for legacy desk APIs until the native frontend cutover is complete.

## Required Cloudflare bindings

In Workers & Pages -> urban-procure -> Settings -> Bindings:

- D1 database binding: `URBAN_PROCURE_DB` -> `urban-procure-db` (`15f861d6-4a86-445e-b56a-66d1b3bc04ba`)
- R2 bucket binding: `URBAN_PROCURE_RFQ_DOCUMENTS` -> `urban-procure-rfq-documents`
- R2 bucket binding: `URBAN_PROCURE_QUOTE_DOCUMENTS` -> `urban-procure-quote-documents`

## Required variables and secrets

Set these in Cloudflare Production and Preview as appropriate. Never commit secret values.

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`
- `PLATFORM_BILLING_MODE=free`
- `TURNSTILE_SECRET`
- `ZOHO_CLIENT_ID`
- `ZOHO_CLIENT_SECRET`
- `ZOHO_REFRESH_TOKEN`
- `ZOHO_ACCOUNT_ID`
- `ZOHO_FROM_EMAIL`
- Optional: `ZOHO_DC` when the account is not on zoho.com
- Optional: `ZOHO_VERIFIED_DAILY_LIMIT` for reviewed outreach sending

Do not set `PROCUREMENT_TEST_AUTH` in production. If test auth is ever needed locally, use `PROCUREMENT_TEST_AUTH=1` only on localhost, `.local`, or `.test`, or pair it with `ALLOW_TEST_AUTH=1` in an isolated preview.

## D1 migration

Run migrations before cutting traffic to the native API:

```sh
npx wrangler d1 migrations apply urban-procure-db --remote
npx wrangler d1 migrations list urban-procure-db --remote
```

The migrations create the native schema, seed an active vendor agreement version, add public request upload tokens, and add a guard trigger so manual user verification also verifies the owned company profile.

## R2 verification

Confirm the buckets exist before document upload testing:

```sh
npx wrangler r2 bucket list
```

Expected buckets:

- `urban-procure-rfq-documents`
- `urban-procure-quote-documents`

## Health checks

```sh
curl -s https://urban-procure.pages.dev/api/health
curl -s https://urban-procure.pages.dev/api/native/health
curl -s -I https://urban-procure.pages.dev/build-stamp.json
```

Expected:

- `/api/health` returns `ok: true` and `supabaseConfigured: true` while legacy APIs remain enabled.
- `/api/native/health` returns `ok: true`, `database: true`, and `emailConfigured: true` after D1 and Zoho are configured.
- `/build-stamp.json` returns `Cache-Control: no-store`.

## Native cutover note

The Cloudflare-native API is mounted at `/api/native/*`. Keep Supabase legacy APIs enabled until the deployed frontend has been verified to call the native auth, public request, workspace, document, RFQ, quotation, and award flows end to end.
