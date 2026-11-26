-- Nex Map's "Plus" is a 30-day pass the person extends with one tap (no automatic renewal: store rules). A retry of the same tap adds the days once.
CREATE TABLE purchase_extensions (
  ref         TEXT PRIMARY KEY,                       -- the Nex ID wallet ref of this extension
  purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  days        INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
UPDATE shop_items SET description = '90-day history, more API keys, all themes and pins, GPX export. A 30-day pass: extend with one tap.' WHERE sku = 'plus';
