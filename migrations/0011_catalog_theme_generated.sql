-- Whether a catalog entry's `theme` was picked for it (a Flagship preset,
-- or the prompt model's own idea) rather than typed in by its creator --
-- see @game-worker/shared/rpc-types's `CatalogRpc.insertCatalogEntry`/
-- `updateCatalogTheme` doc comments for how/when it's set.
--
-- Defaults 0 (not generated) for every pre-existing row -- there's no way
-- to recover which of those, if any, started out themeless after the fact.
ALTER TABLE catalog ADD COLUMN theme_generated INTEGER NOT NULL DEFAULT 0;
