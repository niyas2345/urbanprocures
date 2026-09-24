# Cloudflare staging

The `cloudflare-staging` branch is built at `urbanprocures-dev.pages.dev` with `PREVIEW_ONLY=1`. Its Wrangler configuration omits production D1 and R2 bindings. The build command points the browser at a placeholder Supabase endpoint, so account and procurement mutations are disabled during visual and route checks.

The `main` branch retains the production resource configuration for a future reviewed release. Do not use staging HTTP status checks as proof of authenticated workflows.
