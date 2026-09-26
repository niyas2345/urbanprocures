PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO agreement_versions(kind, version, agreement_hash, active)
VALUES ('vendor', '1.0.0', 'vendor_terms_v1_2026_09_seeded_replace_with_signed_hash', 1);

DROP TRIGGER IF EXISTS trg_verified_user_company;
CREATE TRIGGER trg_verified_user_company
AFTER UPDATE OF verified_at ON users
WHEN NEW.verified_at IS NOT NULL
BEGIN
  UPDATE companies
  SET verification_status = 'verified', verified_at = NEW.verified_at
  WHERE owner_user_id = NEW.id AND verification_status != 'verified';
END;
