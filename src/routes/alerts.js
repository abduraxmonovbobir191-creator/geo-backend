import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { many, one, query } from '../db.js';
import { boundingBox, haversine } from '../lib/geo.js';
import { HttpError, idParam, notFound, parse, route } from '../lib/http.js';

// Live alerts like Waze: people mark traffic, accidents, road works, queues and hazards; others confirm "still there" or "gone".
// Alerts end by themselves, three "gone" votes remove one, and honest reporting earns points and a level. Cameras and police posts
// are legal in some countries and banned in others: ALERT_DISABLED_KINDS switches those kinds off for this server.
const router = Router();

export const ALERT_KINDS = {
  traffic: 2, accident: 3, roadwork: 48, camera: 24 * 30, police: 2, queue: 2, closed: 24, hazard: 6, pothole: 24 * 7,
}; // hours an alert lives without confirmations
const HOUR = 3_600_000;
const SAME_PLACE_M = 150;
const PER_DAY = 40;
export const LEVELS = [[0, 'rookie'], [50, 'scout'], [200, 'driver'], [500, 'pro'], [1500, 'warrior'], [5000, 'legend']];
export const levelOf = (points) => LEVELS.filter(([min]) => points >= min).at(-1)[1];

const give = (userId, n) => query('UPDATE users SET points = points + $2 WHERE id = $1', [userId, n]);

const serialize = (r) => ({
  id: r.id, kind: r.kind, lat: r.lat, lng: r.lng, note: r.note, createdAt: r.created_at, expiresAt: r.expires_at, ups: r.ups, downs: r.downs,
  ...(r.distance_m != null ? { distanceM: Math.round(r.distance_m) } : {}),
});

router.get(
  '/nearby',
  route(async (req, res) => {
    const q = parse(
      z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180), radius: z.coerce.number().min(50).max(20_000).default(3000), kinds: z.string().max(200).optional() }),
      req.query,
    );
    const box = boundingBox(q.lat, q.lng, q.radius);
    const kinds = q.kinds ? q.kinds.split(',').filter((k) => k in ALERT_KINDS) : null;
    const rows = await many(
      `SELECT * FROM map_alerts WHERE status = 'active' AND expires_at > NOW() AND lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4
         AND ($5::text[] IS NULL OR kind = ANY($5))`,
      [box.minLat, box.maxLat, box.minLng, box.maxLng, kinds],
    );
    const alerts = rows
      .map((r) => ({ ...r, distance_m: haversine(q.lat, q.lng, r.lat, r.lng) }))
      .filter((r) => r.distance_m <= q.radius && !config.alertDisabledKinds.includes(r.kind))
      .sort((a, b) => a.distance_m - b.distance_m)
      .slice(0, 100);
    res.json({ alerts: alerts.map(serialize) });
  }),
);

router.post(
  '/',
  route(async (req, res) => {
    const b = parse(z.object({ kind: z.enum(Object.keys(ALERT_KINDS)), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), note: z.string().trim().max(140).default('') }), req.body);
    if (config.alertDisabledKinds.includes(b.kind)) throw new HttpError(403, 'alert_kind_disabled', 'This kind of alert is not allowed here');
    const day = await one("SELECT COUNT(*) AS n FROM map_alerts WHERE created_by = $1 AND created_at > NOW() - INTERVAL '1 day'", [req.auth.userId]);
    if (day.n >= PER_DAY) throw new HttpError(429, 'alert_limit', 'Too many alerts today');
    // the same kind already marked close by: this report counts as a confirmation of it, not a second pin
    const box = boundingBox(b.lat, b.lng, SAME_PLACE_M);
    const near = (await many(
      `SELECT * FROM map_alerts WHERE kind = $1 AND status = 'active' AND expires_at > NOW() AND lat BETWEEN $2 AND $3 AND lng BETWEEN $4 AND $5`,
      [b.kind, box.minLat, box.maxLat, box.minLng, box.maxLng],
    )).find((r) => haversine(b.lat, b.lng, r.lat, r.lng) <= SAME_PLACE_M);
    if (near) {
      const voted = await one('SELECT 1 FROM map_alert_votes WHERE alert_id = $1 AND user_id = $2', [near.id, req.auth.userId]);
      if (!voted && near.created_by !== req.auth.userId) {
        await query('INSERT INTO map_alert_votes (alert_id, user_id, still) VALUES ($1, $2, TRUE)', [near.id, req.auth.userId]);
        await query('UPDATE map_alerts SET ups = ups + 1, expires_at = LEAST(created_at + make_interval(hours => $2 * 2), expires_at + make_interval(hours => $2 / 2)) WHERE id = $1', [near.id, ALERT_KINDS[b.kind]]);
        await give(req.auth.userId, 2);
      }
      return res.status(200).json({ ...serialize(near), merged: true });
    }
    const row = await one(
      `INSERT INTO map_alerts (kind, lat, lng, note, created_by, expires_at) VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(hours => $6)) RETURNING *`,
      [b.kind, b.lat, b.lng, b.note, req.auth.userId, ALERT_KINDS[b.kind]],
    );
    await give(req.auth.userId, 10);
    res.status(201).json(serialize(row));
  }),
);

// "Still there" (extends it) or "gone" (three of them, more than the "still there" votes, remove it). One vote per person; not on your own.
router.post(
  '/:id/confirm',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Alert');
    const { still } = parse(z.object({ still: z.boolean() }), req.body);
    const alert = await one("SELECT * FROM map_alerts WHERE id = $1 AND status = 'active' AND expires_at > NOW()", [id]);
    if (!alert) throw notFound('Alert');
    if (alert.created_by === req.auth.userId) throw new HttpError(403, 'own_alert', 'You cannot vote on your own alert');
    const ins = await one('INSERT INTO map_alert_votes (alert_id, user_id, still) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING alert_id', [id, req.auth.userId, still]);
    if (!ins) throw new HttpError(409, 'already_voted', 'You already voted');
    const hours = ALERT_KINDS[alert.kind];
    const row = still
      ? await one('UPDATE map_alerts SET ups = ups + 1, expires_at = LEAST(created_at + make_interval(hours => $2 * 2), expires_at + make_interval(hours => $2 / 2)) WHERE id = $1 RETURNING *', [id, hours])
      : await one("UPDATE map_alerts SET downs = downs + 1, status = CASE WHEN downs + 1 >= 3 AND downs + 1 > ups THEN 'gone' ELSE status END WHERE id = $1 RETURNING *", [id]);
    await give(req.auth.userId, 2);
    // the reporter is rewarded when others confirm, and loses a little when it was wrong
    if (alert.created_by) await query('UPDATE users SET points = GREATEST(0, points + $2) WHERE id = $1', [alert.created_by, still ? 1 : -1]);
    res.json(serialize(row));
  }),
);

export default router;
