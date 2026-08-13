-- Records who created each catalog entry, for the "created by friends"
-- browse filter and the creator name shown alongside each entry.
--
-- `created_by` is the creating user's account id, used only to test
-- friendship membership -- NULL for anonymous hosts (who never resolve to
-- a `users` row) and for entries created before this column existed.
-- `creator_name`/`creator_color` are a snapshot of the host's display
-- name/color taken at creation time, same snapshot pattern `theme` already
-- uses, rather than a live join back to `users`: an anonymous host has no
-- persisted `users` row to join against, so the snapshot is what makes
-- their chosen name/color displayable at all. All three are nullable and
-- backfill as NULL for pre-existing rows -- there's no creator to recover
-- for those after the fact.
ALTER TABLE catalog ADD COLUMN created_by TEXT;
ALTER TABLE catalog ADD COLUMN creator_name TEXT;
ALTER TABLE catalog ADD COLUMN creator_color TEXT;

CREATE INDEX idx_catalog_created_by ON catalog (created_by);
