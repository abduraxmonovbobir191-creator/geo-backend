import { Router } from 'express';
import { z } from 'zod';
import { many } from '../db.js';
import { bump, promotionsFor, ratingsFor } from '../lib/business.js';
import { boundingBox } from '../lib/geo.js';
import { parse, route as handler } from '../lib/http.js';
import { distanceToLineM, route as computeRoute } from '../lib/routing.js';

// Directions on our own server, plus Waze's "add a stop": bought Top places along the way are offered, labelled as ads.
const router = Router();

const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const bodySchema = z.object({
  from: point,
  to: point,
  via: z.array(point).max(5).default([]),
  mode: z.enum(['drive', 'walk', 'bike']).default('drive'),
  lang: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default('en'),
  toPlaceId: z.string().uuid().optional(),   // the place the person is going to (counted for its owner)
  suggest: z.boolean().default(true),        // offers along the route
  category: z.string().max(30).optional(),   // e.g. only restaurants
});

const SUGGEST_NEAR_M = 300;

router.post(
  '/',
  handler(async (req, res) => {
    const input = parse(bodySchema, req.body);
    const result = await computeRoute(input);
    if (input.toPlaceId) bump([input.toPlaceId], 'route_start');
    let suggestions = [];
    if (input.suggest && input.mode !== 'walk') suggestions = await offersAlong(result.geometry, input.category);
    res.json({ ...result, suggestions });
  }),
);

// Bought Top places within a few hundred meters of the line, nearest to the start first, at most 5. Never an unpaid place
// pretending to be a tip: every item is `ad: true`.
async function offersAlong(line, category) {
  const lats = line.map((p) => p[0]);
  const lngs = line.map((p) => p[1]);
  const mid = [(Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lngs) + Math.max(...lngs)) / 2];
  const halfDiag = Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lngs) - Math.min(...lngs)) * 111_195;
  const box = boundingBox(mid[0], mid[1], halfDiag + SUGGEST_NEAR_M);
  const rows = await many(
    `SELECT p.id, p.name, p.category, p.address, p.lat, p.lng, p.phone, p.photos
     FROM places p JOIN promotions pr ON pr.place_id = p.id AND pr.kind = 'top' AND pr.status = 'active' AND pr.expires_at > NOW()
     WHERE p.lat BETWEEN $1 AND $2 AND p.lng BETWEEN $3 AND $4 AND ($5::text IS NULL OR p.category = $5)`,
    [box.minLat, box.maxLat, box.minLng, box.maxLng, category ?? null],
  );
  const picked = rows
    .map((r) => ({ r, off: distanceToLineM(r.lat, r.lng, line) }))
    .filter((x) => x.off <= SUGGEST_NEAR_M)
    .map((x) => ({ ...x, at: line.findIndex((p) => Math.hypot(p[0] - x.r.lat, p[1] - x.r.lng) === Math.min(...line.map((q) => Math.hypot(q[0] - x.r.lat, q[1] - x.r.lng)))) }))
    .sort((a, b) => a.at - b.at)
    .slice(0, 5);
  const ids = picked.map((x) => x.r.id);
  const [promos, ratings] = await Promise.all([promotionsFor(ids), ratingsFor(ids)]);
  bump(ids, 'impression');
  return picked.map(({ r, off }) => ({
    id: r.id, name: r.name, category: r.category, address: r.address, lat: r.lat, lng: r.lng, phone: r.phone, photos: r.photos,
    offRouteM: Math.round(off), ad: true, topTier: promos.get(r.id)?.top ?? null, rating: ratings.get(r.id)?.rating ?? null,
  }));
}

export default router;
