-- Money lives only at Nex ID (the wallet, Nex Coins). Nex Map keeps the catalog and what a person owns.
-- Purchases work only inside Nex Map: they are entitlements here, never Nex ID perks.
CREATE TABLE shop_items (
  sku          TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('subscription', 'item')),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  price        INTEGER NOT NULL CHECK (price > 0),   -- Nex Coins; the admin may change it, buyers send it back (409 price_changed)
  period_days  INTEGER,                              -- subscriptions only
  perks        TEXT[] NOT NULL DEFAULT '{}',
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE purchases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sku         TEXT NOT NULL REFERENCES shop_items(sku),
  price       INTEGER NOT NULL,
  ref         TEXT NOT NULL UNIQUE,                  -- the Nex ID wallet ref: a retry never pays twice
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled', 'ended', 'refunded')),
  source      TEXT NOT NULL DEFAULT 'map',           -- map | nexly | nexgramm: which app showed the button
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  renews_at   TIMESTAMPTZ                            -- subscriptions: paid until (active) / access until (canceled)
);
CREATE INDEX purchases_user_idx ON purchases (user_id, status);
CREATE INDEX purchases_renew_idx ON purchases (renews_at) WHERE renews_at IS NOT NULL AND status IN ('active', 'canceled');

INSERT INTO shop_items (sku, kind, title, description, price, period_days, perks, sort) VALUES
  ('plus',         'subscription', 'Nex Map Plus',   '90-day history, more API keys, all themes and pins, GPX export', 300, 30,
     ARRAY['nexmap.plus', 'nexmap.api_keys', 'nexmap.themes', 'nexmap.pins', 'nexmap.export'], 1),
  ('themes',       'item', 'Map themes',     'Night, Satellite-style and Gold map themes',     120, NULL, ARRAY['nexmap.themes'], 2),
  ('pins',         'item', 'Pin styles',     'Animated pins and avatar frames on the map',      80, NULL, ARRAY['nexmap.pins'], 3),
  ('export',       'item', 'GPX export',     'Export every activity as GPX',                   150, NULL, ARRAY['nexmap.export'], 4),
  ('api_keys',     'item', 'More API keys',  'Up to 50 developer API keys',                    200, NULL, ARRAY['nexmap.api_keys'], 5);

-- One owned copy per person and item; a subscription renews the same row.
CREATE UNIQUE INDEX purchases_owned_idx ON purchases (user_id, sku) WHERE status IN ('active', 'canceled');
