-- Simplified auth: no more external OpenAuth issuer. An account is just a
-- username plus a server-generated 6-digit login code (hashed at rest).
-- Sessions are opaque tokens stored server-side rather than JWTs, so login
-- state can be revoked by deleting a row. Dropping and recreating `users`
-- again — this is still pre-launch, no accounts worth preserving, and the
-- id scheme changes (locally generated instead of issuer-assigned).

-- Old rows would reference user ids that are about to stop existing — clear
-- them *before* dropping `users`, not after: these all carry a `REFERENCES
-- users (id)` FK, so with FKs enforced, DROP TABLE users performs an
-- implicit delete of its own rows, which fails if any child table still
-- has rows pointing at them.
DELETE FROM friend_requests;
DELETE FROM friendships;
DELETE FROM friend_group_members;
DELETE FROM friend_groups;
DELETE FROM game_invites;

DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL,
  code_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
