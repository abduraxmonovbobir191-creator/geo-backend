-- Strava-like segments with leaderboards, clubs and challenges, and offers shown to people near the venue (paid by radius).
CREATE TABLE segments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('run', 'ride', 'walk', 'hike')),
  points     JSONB NOT NULL,                 -- [[lat, lng], ...] at most 200
  distance_m DOUBLE PRECISION NOT NULL,
  min_lat DOUBLE PRECISION NOT NULL, max_lat DOUBLE PRECISION NOT NULL,
  min_lng DOUBLE PRECISION NOT NULL, max_lng DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX segments_box_idx ON segments (type, min_lat, max_lat);
CREATE TABLE segment_efforts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id  UUID NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_id UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  elapsed_s   INTEGER NOT NULL CHECK (elapsed_s > 0),
  started_at  TIMESTAMPTZ NOT NULL,
  UNIQUE (segment_id, activity_id)
);
CREATE INDEX segment_efforts_board_idx ON segment_efforts (segment_id, elapsed_s);

CREATE TABLE clubs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX clubs_name_idx ON clubs (LOWER(name));
CREATE TABLE club_members (
  club_id   UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (club_id, user_id)
);
CREATE TABLE challenges (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id          UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  metric           TEXT NOT NULL CHECK (metric IN ('distance', 'time', 'count')),
  type             TEXT CHECK (type IN ('run', 'ride', 'walk', 'hike')),
  starts_at        TIMESTAMPTZ NOT NULL,
  ends_at          TIMESTAMPTZ NOT NULL CHECK (ends_at > starts_at),
  sponsor_place_id UUID REFERENCES places(id) ON DELETE SET NULL,  -- a venue that backs it (always shown as an ad)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE offers ADD COLUMN radius_m INTEGER CHECK (radius_m BETWEEN 500 AND 5000);
