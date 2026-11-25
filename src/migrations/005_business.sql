-- Business places (Yandex / Snap Map): a card, paid Top positions, a branded pin, reviews and statistics.
-- Money lives at Nex ID (Nex Coins); Nex Map keeps the orders. Paid positions are always labelled `ad`; ratings and reviews never depend on them.
ALTER TABLE places
  ADD COLUMN owner_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN description    TEXT NOT NULL DEFAULT '',
  ADD COLUMN phone          TEXT,
  ADD COLUMN website        TEXT,
  ADD COLUMN hours          JSONB,                       -- {"mon": [["09:00","23:00"]], ...}; a missing day = closed
  ADD COLUMN utc_offset_min SMALLINT NOT NULL DEFAULT 300,
  ADD COLUMN photos         TEXT[] NOT NULL DEFAULT '{}', -- https image links
  ADD COLUMN price_level    SMALLINT CHECK (price_level BETWEEN 1 AND 4),
  ADD COLUMN pin_logo_url   TEXT,                         -- shown only while a branded-pin promotion is active
  ADD COLUMN pin_model_url  TEXT;                         -- the 3D building / logo model of the branded pin
CREATE INDEX places_owner_idx ON places (owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX places_name_idx ON places (LOWER(name));

CREATE TABLE promo_plans (
  code    TEXT PRIMARY KEY,
  kind    TEXT NOT NULL CHECK (kind IN ('top', 'branded_pin')),
  tier    SMALLINT CHECK (tier BETWEEN 1 AND 3),          -- top only: 1 = first place
  title   TEXT NOT NULL,
  price   INTEGER NOT NULL CHECK (price > 0),             -- Nex Coins; the admin may change it
  days    INTEGER NOT NULL CHECK (days > 0),
  active  BOOLEAN NOT NULL DEFAULT TRUE,
  sort    INTEGER NOT NULL DEFAULT 0
);
INSERT INTO promo_plans (code, kind, tier, title, price, days, sort) VALUES
  ('top1_week',  'top', 1, 'Top 1, 7 days',   700, 7, 1),
  ('top1_month', 'top', 1, 'Top 1, 30 days', 2400, 30, 2),
  ('top2_week',  'top', 2, 'Top 2, 7 days',   450, 7, 3),
  ('top2_month', 'top', 2, 'Top 2, 30 days', 1500, 30, 4),
  ('top3_week',  'top', 3, 'Top 3, 7 days',   250, 7, 5),
  ('top3_month', 'top', 3, 'Top 3, 30 days',  800, 30, 6),
  ('pin_month',  'branded_pin', NULL, 'Branded 3D pin, 30 days', 600, 30, 7);

CREATE TABLE promotions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id   UUID NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  plan_code  TEXT NOT NULL REFERENCES promo_plans(code),
  kind       TEXT NOT NULL,
  tier       SMALLINT,
  category   TEXT NOT NULL,                                -- the place's category when bought: a slot is per category and area
  cell       TEXT NOT NULL,                                -- about 5 km area (lat/lng rounded to 0.05 degrees)
  price      INTEGER NOT NULL,
  ref        TEXT NOT NULL UNIQUE,                         -- the Nex ID wallet ref: a retry never pays twice
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'refunded')),
  starts_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  bought_by  UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX promotions_active_idx ON promotions (category, cell, kind) WHERE status = 'active';
-- One holder per Top position, category and area, so a position can be taken but not shared.
CREATE UNIQUE INDEX promotions_top_slot_idx ON promotions (category, cell, tier) WHERE status = 'active' AND kind = 'top';
CREATE UNIQUE INDEX promotions_pin_idx ON promotions (place_id) WHERE status = 'active' AND kind = 'branded_pin';

CREATE TABLE place_reviews (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id   UUID NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating     SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (place_id, user_id)
);

-- Counts only: who looked is never stored.
CREATE TABLE place_stats_daily (
  place_id UUID NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  day      DATE NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('impression', 'card_open', 'pin_click', 'route_start', 'call')),
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (place_id, day, kind)
);

INSERT INTO shop_items (sku, kind, title, description, price, period_days, perks, sort) VALUES
  ('biz_stats', 'subscription', 'Business statistics', 'Views, card opens, pin taps and routes for your places', 200, 30, ARRAY['nexmap.business_stats'], 8);

-- A place holds at most one Top position at a time.
CREATE UNIQUE INDEX promotions_place_top_idx ON promotions (place_id) WHERE status = 'active' AND kind = 'top';
