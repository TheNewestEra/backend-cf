-- Index of every generated game/puzzle, across all users, for the browse
-- page and post-session ratings. The Durable Objects (GameDO/PuzzleDO)
-- remain the source of truth for live gameplay; this is purely discovery.

CREATE TABLE catalog (
  id TEXT PRIMARY KEY,               -- same id as the GameDO/PuzzleDO instance
  kind TEXT NOT NULL,                -- 'guess' | 'puzzle'
  theme TEXT,
  status TEXT NOT NULL DEFAULT 'generating', -- 'generating' | 'ready' | 'error'
  thumbnail_key TEXT,                -- R2 key, set once generation succeeds
  rating_sum INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_catalog_created ON catalog (created_at DESC);
CREATE INDEX idx_catalog_kind_created ON catalog (kind, created_at DESC);

CREATE TABLE ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  catalog_id TEXT NOT NULL REFERENCES catalog (id),
  rater TEXT,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_ratings_catalog ON ratings (catalog_id);
