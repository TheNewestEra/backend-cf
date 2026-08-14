ALTER TABLE catalog ADD COLUMN replay_of TEXT;
ALTER TABLE catalog ADD COLUMN root_id TEXT;

CREATE INDEX idx_catalog_root_created ON catalog (root_id, created_at DESC);