-- Auth moved to a separate OpenAuth issuer Worker (auth-worker), which owns
-- credentials entirely (its own D1 + KV). This project's `users` table is
-- now just a local cache of {id, username}, upserted from the verified
-- token on every request — id is the issuer's user id, not locally
-- generated. Dropping and recreating rather than migrating columns: no
-- existing accounts are worth preserving.

DROP TABLE IF EXISTS users;
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Old rows would reference user ids that no longer resolve to anything.
DELETE FROM friend_requests;
DELETE FROM friendships;
DELETE FROM friend_group_members;
DELETE FROM friend_groups;
DELETE FROM game_invites;
