-- Every user gets a display color, generated once at registration (see
-- generateColor() in apps/accounts/src/account.service.ts) and stored
-- forever after — not derived on the fly, so it stays stable across
-- requests and services can just SELECT it alongside username.
-- Default only backfills any pre-existing rows; new INSERTs always pass an
-- explicit generated color.
ALTER TABLE users ADD COLUMN color TEXT NOT NULL DEFAULT '#888888';
