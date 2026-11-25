import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { many, one, query } from '../db.js';
import { bump, cellOf } from '../lib/business.js';
import { HttpError, forbidden, idParam, notFound, parse, route } from '../lib/http.js';
import { entitlementsOf } from '../lib/shop.js';
import * as wallet from '../lib/wallet.js';
import { sessionOnly } from '../middleware/auth.js';
import { PLACE_CATEGORIES } from './places.js';

// Businesses on the map: claim a place, fill its card, buy a Top position or a branded pin with Nex Coins (Nex ID wallet),
// read the statistics. Paid positions are always labelled as ads (see places.js); reviews are independent of them.
const router = Router();
const me = (req) => one('SELECT * FROM users WHERE id = $1', [req.auth.userId]);

async function ownedPlace(req) {
  const id = idParam(req.params.id, 'Place');
  const place = await one('SELECT * FROM places WHERE id = $1', [id]);
  if (!place) throw notFound('Place');
  if (place.owner_id !== req.auth.userId) throw forbidden('This is not your place');
  return place;
}

router.get(
  '/plans',
  route(async (_req, res) => {
    const rows = await many('SELECT * FROM promo_plans WHERE active ORDER BY sort');
    res.json({ plans: rows.map((p) => ({ code: p.code, kind: p.kind, tier: p.tier, title: p.title, price: p.price, days: p.days })) });
  }),
);

router.get(
  '/places',
  route(async (req, res) => {
    const rows = await many('SELECT id, name, category, address, lat, lng FROM places WHERE owner_id = $1 ORDER BY name', [req.auth.userId]);
    res.json({ places: rows });
  }),
);

// Claim an unclaimed place. Needs a Nex ID identity check (level 1+); the first claim wins and a dispute goes to the staff.
router.post(
  '/places/:id/claim',
  sessionOnly,
  route(async (req, res) => {
    const user = await me(req);
    if (user.verification_level < 1) throw new HttpError(403, 'verification_required', 'Verify your identity at Nex ID first');
    const id = idParam(req.params.id, 'Place');
    const row = await one('UPDATE places SET owner_id = $2 WHERE id = $1 AND owner_id IS NULL RETURNING id', [id, user.id]);
    if (!row) throw (await one('SELECT 1 FROM places WHERE id = $1', [id])) ? new HttpError(409, 'already_claimed', 'This place has an owner') : notFound('Place');
    res.json({ id: row.id, owner: true });
  }),
);

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const day = z.array(z.tuple([hhmm, hhmm])).max(4);
const httpsUrl = z.string().url().max(500).refine((u) => u.startsWith('https://'), 'https only');
const editSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    category: z.enum(PLACE_CATEGORIES),
    address: z.string().trim().max(300),
    description: z.string().trim().max(1000),
    phone: z.string().trim().regex(/^\+?[0-9 ()-]{5,20}$/).nullable(),
    website: httpsUrl.nullable(),
    hours: z.object({ mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day }).partial().nullable(),
    utcOffsetMin: z.number().int().min(-720).max(840),
    photos: z.array(httpsUrl).max(10),
    priceLevel: z.number().int().min(1).max(4).nullable(),
    pinLogoUrl: httpsUrl.nullable(),
    pinModelUrl: httpsUrl.nullable(),
  })
  .partial()
  .strict();
const COLS = {
  name: 'name', category: 'category', address: 'address', description: 'description', phone: 'phone', website: 'website',
  hours: 'hours', utcOffsetMin: 'utc_offset_min', photos: 'photos', priceLevel: 'price_level', pinLogoUrl: 'pin_logo_url', pinModelUrl: 'pin_model_url',
};

router.patch(
  '/places/:id',
  route(async (req, res) => {
    const place = await ownedPlace(req);
    const input = parse(editSchema, req.body);
    const keys = Object.keys(input);
    if (!keys.length) return res.json({ id: place.id });
    // A new category moves the place to another slot area: a running Top position would no longer match it.
    if (input.category && input.category !== place.category && (await one("SELECT 1 FROM promotions WHERE place_id = $1 AND status = 'active'", [place.id]))) {
      throw new HttpError(409, 'promotion_active', 'End the promotion before changing the category');
    }
    const sets = keys.map((k, i) => `${COLS[k]} = $${i + 2}`).join(', ');
    await query(`UPDATE places SET ${sets} WHERE id = $1`, [place.id, ...keys.map((k) => (k === 'hours' && input[k] ? JSON.stringify(input[k]) : input[k]))]);
    res.json({ id: place.id });
  }),
);

async function endExpired() {
  await query("UPDATE promotions SET status = 'ended' WHERE status = 'active' AND expires_at <= NOW()");
}
export { endExpired as endExpiredPromotions };

const buySchema = z.object({
  plan: z.string().min(1).max(40),
  price: z.number().int().positive().optional(),
  key: z.string().min(8).max(64).optional(),
});

// One tap: the person sees the price, the wallet charges it, the position starts at once. A taken Top position answers 409 slot_taken.
router.post(
  '/places/:id/promotions',
  sessionOnly,
  route(async (req, res) => {
    const place = await ownedPlace(req);
    const input = parse(buySchema, req.body);
    const user = await me(req);
    if (!user.nexid_sub) throw new HttpError(403, 'nexid_required', 'Sign in with Nex ID to buy');
    const plan = await one('SELECT * FROM promo_plans WHERE code = $1 AND active', [input.plan]);
    if (!plan) throw notFound('Plan');
    if (input.price !== undefined && input.price !== plan.price) throw new HttpError(409, 'price_changed', 'The price changed', { price: plan.price });
    if (plan.kind === 'branded_pin' && !place.pin_logo_url && !place.pin_model_url) {
      throw new HttpError(422, 'pin_missing', 'Add a pin logo or a 3D model to the place first');
    }
    await endExpired();
    const ref = `nexmap:promo:${place.id}:${plan.code}:${input.key || crypto.randomUUID()}`;
    const again = await one('SELECT * FROM promotions WHERE ref = $1', [ref]);
    if (again) return res.status(201).json(again); // a retry of a paid order
    // Check the slot before taking money; the unique index below settles races.
    const cell = cellOf(place.lat, place.lng);
    const taken = await one(
      plan.kind === 'top'
        ? "SELECT 1 FROM promotions WHERE status = 'active' AND kind = 'top' AND (place_id = $1 OR (category = $2 AND cell = $3 AND tier = $4))"
        : "SELECT 1 FROM promotions WHERE status = 'active' AND kind = 'branded_pin' AND place_id = $1",
      plan.kind === 'top' ? [place.id, place.category, cell, plan.tier] : [place.id],
    );
    if (taken) throw new HttpError(409, 'slot_taken', 'This position is taken');

    await wallet.charge(user.nexid_sub, plan.price, ref, `Nex Map: ${plan.title}`);
    try {
      const row = await one(
        `INSERT INTO promotions (place_id, plan_code, kind, tier, category, cell, price, ref, expires_at, bought_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + make_interval(days => $9), $10) RETURNING *`,
        [place.id, plan.code, plan.kind, plan.tier, place.category, cell, plan.price, ref, plan.days, user.id],
      );
      res.status(201).json({ id: row.id, plan: plan.code, kind: row.kind, tier: row.tier, expiresAt: row.expires_at });
    } catch (err) {
      await wallet.refund(ref).catch(() => {}); // never keep coins without the position
      if (err.code === '23505') throw new HttpError(409, 'slot_taken', 'This position is taken');
      throw err;
    }
  }),
);

router.get(
  '/places/:id/promotions',
  route(async (req, res) => {
    const place = await ownedPlace(req);
    const rows = await many('SELECT * FROM promotions WHERE place_id = $1 ORDER BY starts_at DESC LIMIT 50', [place.id]);
    res.json({ promotions: rows.map((p) => ({ id: p.id, plan: p.plan_code, kind: p.kind, tier: p.tier, status: p.status, price: p.price, startsAt: p.starts_at, expiresAt: p.expires_at })) });
  }),
);

// Statistics are a paid add-on (`nexmap.business_stats`, bought in the shop).
router.get(
  '/places/:id/stats',
  route(async (req, res) => {
    const place = await ownedPlace(req);
    const user = await me(req);
    if (!(await entitlementsOf(user)).includes('nexmap.business_stats')) {
      throw new HttpError(402, 'plan_required', 'Business statistics are a paid add-on', { sku: 'biz_stats' });
    }
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(90).default(28) }), req.query);
    const rows = await many(
      `SELECT day, kind, count FROM place_stats_daily WHERE place_id = $1 AND day > CURRENT_DATE - $2::int ORDER BY day`,
      [place.id, days],
    );
    const totals = {};
    for (const r of rows) totals[r.kind] = (totals[r.kind] ?? 0) + r.count;
    res.json({ days, totals, daily: rows.map((r) => ({ day: r.day, kind: r.kind, count: r.count })) });
  }),
);

// ---- public side of a place: reviews and taps (these routes are mounted under /v1/places) ----
export const placeExtras = Router();

placeExtras.post(
  '/:id/events',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Place');
    const { kind } = parse(z.object({ kind: z.enum(['pin_click', 'route_start', 'call']) }), req.body);
    if (!(await one('SELECT 1 FROM places WHERE id = $1', [id]))) throw notFound('Place');
    await bump([id], kind);
    res.status(204).end();
  }),
);

placeExtras.get(
  '/:id/reviews',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Place');
    const rows = await many(
      `SELECT r.id, r.rating, r.body, r.created_at, u.id AS user_id, u.username, u.name, u.avatar_url
       FROM place_reviews r JOIN users u ON u.id = r.user_id WHERE r.place_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
      [id],
    );
    res.json({ reviews: rows.map((r) => ({ id: r.id, rating: r.rating, body: r.body, createdAt: r.created_at, user: { id: r.user_id, username: r.username, name: r.name, avatarUrl: r.avatar_url } })) });
  }),
);

// One review per person and place; the owner cannot rate their own place, and a purchase never changes a rating.
placeExtras.put(
  '/:id/reviews',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Place');
    const input = parse(z.object({ rating: z.number().int().min(1).max(5), body: z.string().trim().max(1000).default('') }), req.body);
    const place = await one('SELECT owner_id FROM places WHERE id = $1', [id]);
    if (!place) throw notFound('Place');
    if (place.owner_id === req.auth.userId) throw forbidden('You cannot review your own place');
    await query(
      `INSERT INTO place_reviews (place_id, user_id, rating, body) VALUES ($1, $2, $3, $4)
       ON CONFLICT (place_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, body = EXCLUDED.body`,
      [id, req.auth.userId, input.rating, input.body],
    );
    res.status(204).end();
  }),
);

export default router;
