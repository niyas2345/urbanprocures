UPDATE agreement_versions SET active=0 WHERE kind='vendor';
INSERT OR IGNORE INTO agreement_versions(kind,version,agreement_hash,active) VALUES ('vendor','1.0.1','69e5ec5746e8e5deb1d4ffe64630af429e61fe7c825a65c5153f39bbe06a7f27',1);
UPDATE agreement_versions SET active=1 WHERE kind='vendor' AND version='1.0.1';
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_agreement ON agreement_versions(kind) WHERE active=1;
