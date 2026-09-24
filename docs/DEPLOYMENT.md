# Urban Procures — deployment runbook

Last reviewed: 2026-09-01.

## Live targets

| Host | Role | Notes |
|---|---|---|
| https://urban-procure.pages.dev | Cloudflare public desk (chosen path) | Needs Supabase env or `/api/health` stays `supabaseConfigured: false` |
| https://deploy-preview-5--urbanprocures.netlify.app | Working Netlify preview | Shared desk already proven: health true, stamp `2026-09-01-prod-harden` |
| https://urbanprocures.netlify.app | Old public Netlify URL | Frozen on 26 Aug build while Ironman production credits are paused |

There is no Urban Procures site at `urbanprocures.ae`.

## Chosen stack (soft launch)

- Cloudflare Pages + Workers Paid ($5) — website + API
- Cloudflare R2 (10 GB free) — drawings / BOQs
- Supabase Free — login + RFQ/quote rows + masking data
- `PLATFORM_BILLING_MODE=free` — no vendor service fee

Product rules:

- Client RFQ is stored on the server, not in the phone browser
- Vendors signed in on any device/IP see the same open RFQs
- Client and vendor identities stay masked until award
- Other clients do not see each other’s RFQs

Worker soft-launch caps (in `wrangler.jsonc`):

- RFQs: warn 100 / hard 250 (was 15 / 20)
- Files: warn 8 GB / hard 10 GB to match R2 free tier

## Cloudflare dashboard (owner must do — no Grok connector)

1. Pay **Workers Paid $5/month** on the Cloudflare account that owns `urban-procure`.
2. Open **Workers & Pages → urban-procure → Settings → Variables and secrets**.
3. Add for Production (and Preview):
   - `SUPABASE_URL` = the existing project URL (`https://vdlrwekoyvvspxuyzgrx.supabase.co`)
   - `SUPABASE_ANON_KEY` = same publishable key already on Netlify
   - `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` = same secret already on Netlify
   - `PLATFORM_BILLING_MODE` = `free`
4. Confirm R2 buckets exist and stay bound:
   - `urban-procure-rfq-documents`
   - `urban-procure-quote-documents`
5. Retry deploy / wait for GitHub `main` to rebuild Pages.
6. Check:

```sh
curl -s https://urban-procure.pages.dev/api/health
# expect { "ok": true, "supabaseConfigured": true }
```

Do not paste service-role keys into GitHub.

## Confirm a desk is the shared one

```sh
curl -s https://urban-procure.pages.dev/api/health
curl -s https://urban-procure.pages.dev/build-stamp.json
curl -s https://deploy-preview-5--urbanprocures.netlify.app/api/health
```

Healthy: `{ "ok": true, "supabaseConfigured": true }` and stamp `2026-09-01-prod-harden` (or later).
