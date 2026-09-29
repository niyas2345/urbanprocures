# Frontend version reconciliation

Source checked: Netlify production deploy `6a8e9491a49d10fa5c340c2d` for site `urbanprocures` on 2026-08-28.

The deploy is a drop deployment (`commit_ref: null`) containing a single generated `index.html`. It is not byte-identical to the Vite frontend on `develop/ai-procurement` at `510180cec5fdf828fa7fb5d35dc097b341d4a7c6`.

The Netlify artifact contains the newer/full-desk presentation layer: grouped public/desks/growth navigation; client and vendor registration screens; client, vendor, admin, comparison, document, notification, matching, WhatsApp, LinkedIn and owner screens; a product tour; IndexedDB-backed local file staging; richer attachment visibility controls; award/disclosure views; masked comparison tables; and the full-desk landing/FAQ/footer content.

The GitHub frontend contains the authoritative procurement/security integration: Vite source, server-backed RFQ document upload, server-backed terms/vendor persistence, and the AI procurement backend and tests. The Netlify artifact's upload and repository code are demo/local-only (IndexedDB and local state), and its production page has no application functions or server integration. Replacing the secure Vite entry with that artifact would regress the persistent Supabase ingestion path.

The deployed artifact is preserved as a sanitized source snapshot under `frontend/netlify-production/index.html` for reconciliation. Its full-desk markup and styling are now the active Vite entry point; local-only registration, owner-PIN access, and document persistence are disabled or replaced with secure-server/pending states.
