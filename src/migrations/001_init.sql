-- Nex Map initial schema. gen_random_uuid() is built into PostgreSQL 13+.

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  avatar_url    TEXT,
  ghost_mode    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX users_username_lower_idx ON users (LOWER(username));
CREATE UNIQUE INDEX users_email_lower_idx ON users (LOWER(email));

-- Last location each user shares with friends. Not updated while ghost mode is on,
-- so friends keep seeing the position from the moment ghost mode was enabled.
CREATE TABLE locations (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lat        DOUBLE PRECISION NOT NULL,
  lng        DOUBLE PRECISION NOT NULL,
  accuracy   REAL,
  speed      REAL,
  heading    REAL,
  battery    SMALLINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE friendships (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at  TIMESTAMPTZ,
  CHECK (requester_id <> addressee_id)
);
-- One friendship row per pair, whichever side asked first.
CREATE UNIQUE INDEX friendships_pair_idx
  ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));
CREATE INDEX friendships_addressee_idx ON friendships (addressee_id, status);

CREATE TABLE activities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type             TEXT NOT NULL CHECK (type IN ('run', 'ride', 'walk', 'hike')),
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  visibility       TEXT NOT NULL DEFAULT 'friends' CHECK (visibility IN ('public', 'friends', 'private')),
  started_at       TIMESTAMPTZ NOT NULL,
  ended_at         TIMESTAMPTZ NOT NULL,
  distance_m       DOUBLE PRECISION NOT NULL,
  duration_s       INTEGER NOT NULL,
  moving_time_s    INTEGER NOT NULL,
  elevation_gain_m DOUBLE PRECISION NOT NULL DEFAULT 0,
  avg_speed_mps    DOUBLE PRECISION NOT NULL,
  max_speed_mps    DOUBLE PRECISION NOT NULL,
  -- [[lat, lng, unixMillis, elevation|null], ...]
  points           JSONB NOT NULL,
  -- At most 100 [lat, lng] pairs, for drawing the route in lists without loading every point.
  preview          JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX activities_user_idx ON activities (user_id, started_at DESC);

CREATE TABLE kudos (
  activity_id UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (activity_id, user_id)
);

CREATE TABLE places (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'other',
  address    TEXT NOT NULL DEFAULT '',
  lat        DOUBLE PRECISION NOT NULL,
  lng        DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX places_lat_lng_idx ON places (lat, lng);

CREATE TABLE checkins (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  place_id   UUID NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX checkins_user_idx ON checkins (user_id, created_at DESC);

CREATE TABLE messages (
  id           BIGSERIAL PRIMARY KEY,
  sender_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at      TIMESTAMPTZ
);
CREATE INDEX messages_pair_idx ON messages (
  LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id), id DESC
);
CREATE INDEX messages_recipient_unread_idx ON messages (recipient_id) WHERE read_at IS NULL;

-- Keys for third-party developers. Only a SHA-256 hash of the key is stored.
CREATE TABLE api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  scopes       TEXT[] NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX api_keys_user_idx ON api_keys (user_id);
