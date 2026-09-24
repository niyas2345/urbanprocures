# Urban Procures

This source is a reconstructed frontend and targeted Worker security/routing update based on the supplied ZIP snapshot. It is **not** verified as the current production commit. Read [`docs/RECONSTRUCTION-AUDIT.md`](docs/RECONSTRUCTION-AUDIT.md) before merging or deploying.

## Local checks

```sh
npm ci
npm test
npm run build
node scripts/preview-worker.mjs
```

The preview serves built Worker routes and public pages without privileged credentials. It will show unavailable states for authenticated workflows until a properly configured isolated staging backend is attached. `npm run test:e2e` uses local preview by default and requires Chromium; account-creating tests additionally require an isolated staging backend and `RUN_MUTATING_E2E=1`.

## Architecture

The Vite multi-page frontend talks to the same-origin Worker. Supabase Auth supplies sessions; server role and admin membership checks protect Worker endpoints. Supabase stores procurement records; the existing private document buckets hold RFQ and quotation originals. No schema migrations are included in this reconstruction.

Cloudflare Pages production is currently deployed from `niyas2345/urban-procure` on `main`. Merge this source into a reviewed branch **after comparing it to the current production commit**, then validate a preview deployment before promotion. Do not apply `supabase/schema.sql` to an existing production database.
