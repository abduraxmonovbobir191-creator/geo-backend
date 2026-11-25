-- Nex ID is the only account system of the Nex ecosystem: a user is keyed by its Nex ID `sub`.
-- Additive only: password columns stay (old accounts) but become optional.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users
  ADD COLUMN nexid_sub          TEXT,
  ADD COLUMN nexid_refresh      TEXT,
  ADD COLUMN verification_level SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN telegram_id        BIGINT,
  ADD COLUMN plan               TEXT NOT NULL DEFAULT 'free',
  ADD COLUMN perks              TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN plan_checked_at    TIMESTAMPTZ;
CREATE UNIQUE INDEX users_nexid_sub_idx ON users (nexid_sub) WHERE nexid_sub IS NOT NULL;
CREATE INDEX users_telegram_id_idx ON users (telegram_id) WHERE telegram_id IS NOT NULL;

-- Which ecosystem product a friendship or share came from (nexly | nexgramm | map).
ALTER TABLE friendships ADD COLUMN source TEXT NOT NULL DEFAULT 'map';
