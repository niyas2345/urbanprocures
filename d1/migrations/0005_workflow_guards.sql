-- Email ownership and company approval are independent decisions.
DROP TRIGGER IF EXISTS trg_verified_user_company;

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_user_role ON companies(owner_user_id,role);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_rfq_public_request ON rfqs(public_request_id) WHERE public_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rfq_status_created ON rfqs(status,created_at,id);
CREATE INDEX IF NOT EXISTS idx_invitation_vendor ON rfq_invitations(vendor_company_id,rfq_id);
CREATE INDEX IF NOT EXISTS idx_quote_vendor ON quotations(vendor_company_id,created_at,id);
CREATE INDEX IF NOT EXISTS idx_document_owner ON documents(owner_kind,owner_id,created_at,id);
CREATE INDEX IF NOT EXISTS idx_clarification_rfq ON clarifications(rfq_id,created_at,id);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(kind,status,next_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_kind,entity_id,created_at);
CREATE INDEX IF NOT EXISTS idx_public_request_status ON public_requests(status,created_at,id);
CREATE INDEX IF NOT EXISTS idx_owner_expiry ON public_owners(expires_at);

CREATE TABLE IF NOT EXISTS operations_alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','resolved')),
  last_seen_at TEXT NOT NULL,
  notified_at TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);

CREATE TRIGGER IF NOT EXISTS trg_quotation_manpower_insert
BEFORE INSERT ON quotations
WHEN EXISTS(SELECT 1 FROM rfqs WHERE id=NEW.rfq_id AND (lower(category) LIKE '%manpower%' OR lower(category) LIKE '%labour supply%' OR lower(category) LIKE '%labor supply%'))
AND (NEW.labourer_count IS NULL OR NEW.labourer_count<1 OR typeof(NEW.labourer_count)!='integer' OR NEW.hours_per_labourer IS NULL OR NEW.hours_per_labourer<=0 OR NEW.hours_per_labourer>100000)
BEGIN SELECT RAISE(ABORT,'Valid manpower quantities required'); END;

CREATE TRIGGER IF NOT EXISTS trg_award_quote_guard
BEFORE INSERT ON awards
WHEN NOT EXISTS(SELECT 1 FROM quotations q JOIN rfqs r ON r.id=q.rfq_id WHERE q.id=NEW.quotation_id AND r.id=NEW.rfq_id AND r.status='quoting' AND q.vendor_company_id=NEW.vendor_company_id AND q.amount_fils=NEW.awarded_amount_fils)
BEGIN SELECT RAISE(ABORT,'Award must reference an eligible quotation'); END;
