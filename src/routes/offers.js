import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { many, one, query } from '../db.js';
import { bump } from '../lib/business.js';
import { HttpError, forbidden, idParam, notFound, parse, route } from '../lib/http.js';
import * as wallet from '../lib/wallet.js';
import { sessionOnly } from '../middleware/auth.js';

// Offers and coupons (Snap Map / Yandex): a venue posts a discount, people take a coupon, the venue marks it used at the till and pays a
// small lead fee in Stars for each used coupon (0 = free offer). The fee is charged to the owner at Nex ID's wallet once per coupon.
export const publicOffers = Router();   // mounted under /v1/places
export const offerRoutes = Router();    // mounted under /v1/offers
export const businessOffers = Router(); // mounted under /v1/business

const me = (req) => one('SELECT * FROM users WHERE id = $1', [req.auth.userId]);
const serialize = (o) => ({ id: o.id, placeId: o.place_id, title: o.title, details: o.details, leadFee: o.lead_fee, quota: o.quota, claimed: o.claimed, endsAt: o.ends_at });
const live = "o.active AND o.starts_at <= NOW() AND o.ends_at > NOW() AND (o.quota IS NULL OR o.claimed < o.quota)";

publicOffers.get(
  '/:id/offers',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Place');
    const rows = await many(`SELECT o.* FROM offers o WHERE o.place_id = $1 AND ${live} ORDER BY o.ends_at`, [id]);
    res.json({ offers: rows.map(serialize) });
  }),
);

offerRoutes.post(
  '/:id/claim',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Offer');
    const o = await one('SELECT o.* FROM offers o WHERE o.id = $1 AND o.active AND o.starts_at <= NOW() AND o.ends_at > NOW()', [id]);
    if (!o) throw notFound('Offer');
    const have = await one('SELECT * FROM coupons WHERE offer_id = $1 AND user_id = $2', [id, req.auth.userId]);
    if (have) return res.json({ id: have.id, code: have.code, status: have.status, offer: serialize(o) });
    const code = crypto.randomBytes(5).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8).toUpperCase();
    // the quota is taken in the same statement, so two people cannot take the last coupon together
    const taken = await one('UPDATE offers SET claimed = claimed + 1 WHERE id = $1 AND (quota IS NULL OR claimed < quota) RETURNING id', [id]);
    if (!taken) throw new HttpError(409, 'offer_full', 'No coupons left');
    const c = await one('INSERT INTO coupons (offer_id, user_id, code) VALUES ($1, $2, $3) RETURNING *', [id, req.auth.userId, code]);
    bump([o.place_id], 'coupon_claim');
    res.status(201).json({ id: c.id, code: c.code, status: c.status, offer: serialize(o) });
  }),
);

offerRoutes.get(
  '/mine',
  route(async (req, res) => {
    const rows = await many(
      `SELECT c.id, c.code, c.status, c.created_at, o.title, o.details, o.ends_at, o.place_id, p.name AS place_name
       FROM coupons c JOIN offers o ON o.id = c.offer_id JOIN places p ON p.id = o.place_id WHERE c.user_id = $1 ORDER BY c.created_at DESC LIMIT 100`,
      [req.auth.userId],
    );
    res.json({ coupons: rows.map((r) => ({ id: r.id, code: r.code, status: r.status, title: r.title, details: r.details, endsAt: r.ends_at, place: { id: r.place_id, name: r.place_name } })) });
  }),
);

// ---- the venue's side ----
const createSchema = z.object({
  placeId: z.string().uuid(),
  title: z.string().trim().min(1).max(80),
  details: z.string().trim().max(300).default(''),
  leadFee: z.number().int().min(0).max(1000).default(0),
  quota: z.number().int().min(1).max(100_000).nullable().default(null),
  days: z.number().int().min(1).max(90).default(14),
});

businessOffers.post(
  '/offers',
  sessionOnly,
  route(async (req, res) => {
    const b = parse(createSchema, req.body);
    const place = await one('SELECT owner_id FROM places WHERE id = $1', [b.placeId]);
    if (!place) throw notFound('Place');
    if (place.owner_id !== req.auth.userId) throw forbidden('This is not your place');
    const o = await one(
      `INSERT INTO offers (place_id, title, details, lead_fee, quota, ends_at) VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(days => $6)) RETURNING *`,
      [b.placeId, b.title, b.details, b.leadFee, b.quota, b.days],
    );
    res.status(201).json(serialize(o));
  }),
);

businessOffers.delete(
  '/offers/:id',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Offer');
    const row = await one('UPDATE offers o SET active = FALSE FROM places p WHERE o.id = $1 AND p.id = o.place_id AND p.owner_id = $2 RETURNING o.id', [id, req.auth.userId]);
    if (!row) throw notFound('Offer');
    res.status(204).end();
  }),
);

// At the till: the owner enters the coupon code. The lead fee is charged to the owner once per coupon (Nex ID wallet, `ref` per coupon),
// then the coupon is used. A venue without the Stars cannot redeem (402) and the coupon stays valid.
businessOffers.post(
  '/redeem',
  sessionOnly,
  route(async (req, res) => {
    const { code } = parse(z.object({ code: z.string().trim().toUpperCase().min(4).max(12) }), req.body);
    const c = await one(
      `SELECT c.*, o.lead_fee, o.title, o.place_id, o.ends_at, p.owner_id FROM coupons c JOIN offers o ON o.id = c.offer_id JOIN places p ON p.id = o.place_id WHERE c.code = $1`,
      [code],
    );
    if (!c || c.owner_id !== req.auth.userId) throw notFound('Coupon');
    if (c.status === 'redeemed') throw new HttpError(409, 'coupon_used', 'This coupon was already used');
    if (new Date(c.ends_at) < new Date()) throw new HttpError(409, 'offer_ended', 'This offer has ended');
    const owner = await me(req);
    if (c.lead_fee > 0) {
      if (!owner.nexid_sub) throw new HttpError(403, 'nexid_required', 'Sign in with Nex ID');
      await wallet.charge(owner.nexid_sub, c.lead_fee, `nexmap:lead:${c.id}`, `Nex Map: ${c.title}`);
    }
    const done = await one("UPDATE coupons SET status = 'redeemed', redeemed_at = NOW() WHERE id = $1 AND status = 'active' RETURNING id", [c.id]);
    if (!done) {
      if (c.lead_fee > 0) await wallet.refund(`nexmap:lead:${c.id}`).catch(() => {}); // used by someone else at the same moment: give the fee back
      throw new HttpError(409, 'coupon_used', 'This coupon was already used');
    }
    bump([c.place_id], 'coupon_redeem');
    res.json({ redeemed: true, title: c.title, leadFee: c.lead_fee });
  }),
);
