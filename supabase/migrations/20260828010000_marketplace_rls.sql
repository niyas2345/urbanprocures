-- Marketplace access policies.
-- These policies intentionally use authenticated identity + role claims and
-- stable party IDs; never expose raw client/vendor identity through public views.

ALTER TABLE public.rfqs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rfq_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quotation_items ENABLE ROW LEVEL SECURITY;

-- Baseline deny-by-default. Application service role can perform controlled
-- processing; user-facing reads must satisfy explicit policies added by the
-- production schema once the project auth claim names are finalized.

DROP POLICY IF EXISTS "rfqs_deny_anon" ON public.rfqs;
CREATE POLICY "rfqs_deny_anon" ON public.rfqs
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "quotations_deny_anon" ON public.quotations;
CREATE POLICY "quotations_deny_anon" ON public.quotations
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "rfq_documents_deny_anon" ON public.rfq_documents;
CREATE POLICY "rfq_documents_deny_anon" ON public.rfq_documents
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "quotation_items_deny_anon" ON public.quotation_items;
CREATE POLICY "quotation_items_deny_anon" ON public.quotation_items
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- Do not add broad authenticated SELECT policies here. The final party-aware
-- policies must be based on the repository's actual auth/party schema and are
-- intentionally a separate deployment step to avoid accidentally granting
-- cross-party access.
