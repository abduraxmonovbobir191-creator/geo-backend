-- Live status and a privacy mode for every friend (Blink / Snap Map): precise | blurred | frozen | hidden.
-- Sensitive extras (movement, charging, steps) stay off until the person turns them on.
ALTER TABLE users
  ADD COLUMN share_mode      TEXT NOT NULL DEFAULT 'precise' CHECK (share_mode IN ('precise', 'blurred', 'frozen', 'hidden')),
  ADD COLUMN share_activity  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN share_steps     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN status_text     TEXT,
  ADD COLUMN status_until    TIMESTAMPTZ;

ALTER TABLE locations
  ADD COLUMN activity     TEXT CHECK (activity IN ('still', 'walking', 'vehicle', 'sleeping')),
  ADD COLUMN is_charging  BOOLEAN,
  ADD COLUMN steps_today  INTEGER,
  ADD COLUMN anchor_lat   DOUBLE PRECISION,   -- where the person has been standing (still-for timer)
  ADD COLUMN anchor_lng   DOUBLE PRECISION,
  ADD COLUMN anchor_since TIMESTAMPTZ;

-- How `owner_id` shows themselves to one friend. No row = the owner's default (users.share_mode).
-- frozen_*: the point the friend keeps seeing while the mode is "frozen" (taken when it was set).
CREATE TABLE location_sharing (
  owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode       TEXT NOT NULL CHECK (mode IN ('precise', 'blurred', 'frozen', 'hidden')),
  frozen_lat DOUBLE PRECISION,
  frozen_lng DOUBLE PRECISION,
  frozen_at  TIMESTAMPTZ,
  PRIMARY KEY (owner_id, friend_id)
);
