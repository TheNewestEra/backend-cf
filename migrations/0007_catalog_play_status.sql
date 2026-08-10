-- Tracks each catalog entry's live play status, separately from `status`
-- (which only ever reflects generation progress / thumbnail availability).
-- Lets GET /api/catalog answer "what can I join right now" and "what's in
-- progress right now" straight out of D1, without an RPC round trip to the
-- owning game's Durable Object per row.
--
-- 'joinable' — pre-start: still generating, or (Piece Puzzle only) sitting
--              in its waiting-room lobby. Matches each game's own join()
--              gate exactly (see GameDO.join/PuzzleDO.join).
-- 'active'   — started and playable/spectatable, but not joinable anymore.
-- 'finished' — Piece Puzzle only (solved/timeout); Guess the Prompt has no
--              terminal state, so its entries only ever move joinable ->
--              active and stay there.
--
-- Defaults to 'joinable' so `insertCatalogEntry` (unchanged) is already
-- correct for every kind at creation time.
ALTER TABLE catalog ADD COLUMN play_status TEXT NOT NULL DEFAULT 'joinable';

CREATE INDEX idx_catalog_play_status_created ON catalog (play_status, created_at DESC);
