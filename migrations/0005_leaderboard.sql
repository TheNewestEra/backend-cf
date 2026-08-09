-- Leaderboard: one row per scoring event (a solved puzzle, a correctly
-- guessed round), so time-windowed queries ("top scores this week") can
-- filter on created_at directly instead of reconstructing history from a
-- running total. Accounts only — anonymous/guest play never writes here
-- (see leaderboard.service.ts), so every row has a real user to rank.

CREATE TABLE leaderboard_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  kind TEXT NOT NULL,          -- 'guess' | 'puzzle'
  session_id TEXT NOT NULL,    -- gameId or puzzleId this score came from
  score INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_leaderboard_kind_created ON leaderboard_entries (kind, created_at DESC);
CREATE INDEX idx_leaderboard_user ON leaderboard_entries (user_id);
