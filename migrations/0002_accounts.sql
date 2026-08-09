-- Local accounts (optional — anonymous play still works everywhere else)
-- plus the friend/group/invite system built on top of them.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  username_lower TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- One row per direction. A mutual request (B already asked A) is detected
-- and auto-accepted in application code rather than modeled here.
CREATE TABLE friend_requests (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES users (id),
  recipient_id TEXT NOT NULL REFERENCES users (id),
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted' | 'declined'
  created_at INTEGER NOT NULL,
  responded_at INTEGER,
  UNIQUE (requester_id, recipient_id)
);
CREATE INDEX idx_friend_requests_recipient ON friend_requests (recipient_id, status);
CREATE INDEX idx_friend_requests_requester ON friend_requests (requester_id, status);

-- Accepted friendships, written both directions on accept for an O(1)
-- "my friends" lookup (same pattern as the standalone friend-code worker).
CREATE TABLE friendships (
  user_id TEXT NOT NULL REFERENCES users (id),
  friend_id TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);
CREATE INDEX idx_friendships_user ON friendships (user_id);

CREATE TABLE friend_groups (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users (id),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_friend_groups_owner ON friend_groups (owner_id);

CREATE TABLE friend_group_members (
  group_id TEXT NOT NULL REFERENCES friend_groups (id),
  friend_id TEXT NOT NULL REFERENCES users (id),
  PRIMARY KEY (group_id, friend_id)
);

-- A game/puzzle invite. Inviting a group fans out to one row per member —
-- there's no separate "group invite" concept at the data layer.
CREATE TABLE game_invites (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,          -- 'guess' | 'puzzle'
  session_id TEXT NOT NULL,    -- gameId or puzzleId
  inviter_id TEXT NOT NULL REFERENCES users (id),
  recipient_id TEXT NOT NULL REFERENCES users (id),
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted' | 'declined'
  created_at INTEGER NOT NULL,
  responded_at INTEGER
);
CREATE INDEX idx_game_invites_recipient ON game_invites (recipient_id, status);
