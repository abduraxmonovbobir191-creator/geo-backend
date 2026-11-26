-- Waze-style live alerts with points, coupons that pay the venue's lead fee in Stars, footprints and "bump" (two friends meet).
ALTER TABLE users ADD COLUMN points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0);

CREATE TABLE map_alerts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       TEXT NOT NULL CHECK (kind IN ('traffic', 'accident', 'roadwork', 'camera', 'police', 'queue', 'closed', 'hazard', 'pothole')),
  lat        DOUBLE PRECISION NOT NULL,
  lng        DOUBLE PRECISION NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  ups        INTEGER NOT NULL DEFAULT 0,
  downs      INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'gone'))
);
CREATE INDEX map_alerts_geo_idx ON map_alerts (lat, lng) WHERE status = 'active';
CREATE TABLE map_alert_votes (
  alert_id UUID NOT NULL REFERENCES map_alerts(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  still    BOOLEAN NOT NULL,
  PRIMARY KEY (alert_id, user_id)
);

CREATE TABLE offers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id   UUID NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  details    TEXT NOT NULL DEFAULT '',
  lead_fee   INTEGER NOT NULL CHECK (lead_fee >= 0),   -- Stars the venue pays for each coupon that is used (0 = free offer)
  quota      INTEGER CHECK (quota > 0),                -- null = unlimited
  claimed    INTEGER NOT NULL DEFAULT 0,
  starts_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at    TIMESTAMPTZ NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX offers_place_idx ON offers (place_id) WHERE active;
CREATE TABLE coupons (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id    UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code        TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'redeemed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  redeemed_at TIMESTAMPTZ,
  UNIQUE (offer_id, user_id)
);

ALTER TABLE place_stats_daily DROP CONSTRAINT IF EXISTS place_stats_daily_kind_check;
ALTER TABLE place_stats_daily ADD CONSTRAINT place_stats_daily_kind_check
  CHECK (kind IN ('impression', 'card_open', 'pin_click', 'route_start', 'call', 'coupon_claim', 'coupon_redeem'));

-- Where a person has been (about 1 km cells), private to them.
CREATE TABLE footprints (
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cell     TEXT NOT NULL,
  first_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, cell)
);

-- A pair of friends who met: one bump per pair per 30 minutes.
CREATE TABLE bumps (
  a  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  b  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
