import { Router } from 'express';
import { z } from 'zod';
import { many, one } from '../db.js';
import { idParam, notFound, parse, route } from '../lib/http.js';
import { boundingBox, haversine } from '../lib/geo.js';
import { emitToUsers, friendIds } from '../lib/social.js';

const router = Router();

export const PLACE_CATEGORIES = [
  'cafe', 'restaurant', 'park', 'gym', 'sport', 'shop', 'school', 'work', 'home', 'other',
];

const lat = z.coerce.number().min(-90).max(90);
const lng = z.coerce.number().min(-180).max(180);

const nearbySchema = z.object({
  lat,
  lng,
  radius: z.coerce.number().min(1).max(50_000).default(1_000),
  category: z.enum(PLACE_CATEGORIES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.enum(PLACE_CATEGORIES).default('other'),
  address: z.string().trim().max(300).default(''),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

function serializePlace(r, origin) {
  const place = {
    id: r.id,
    name: r.name,
    category: r.category,
    address: r.address,
    lat: r.lat,
    lng: r.lng,
    checkinCount: r.checkin_count ?? 0,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
  if (origin) place.distanceM = Math.round(haversine(origin.lat, origin.lng, r.lat, r.lng));
  return place;
}

const PLACE_COLUMNS = `p.*, (SELECT COUNT(*) FROM checkins c WHERE c.place_id = p.id) AS checkin_count`;

router.get(
  '/nearby',
  route(async (req, res) => {
    const q = parse(nearbySchema, req.query);
    const box = boundingBox(q.lat, q.lng, q.radius);
    // The box can cross the antimeridian (lng beyond +-180); then match both sides.
    const rows = await many(
      `SELECT ${PLACE_COLUMNS} FROM places p
       WHERE p.lat BETWEEN $1 AND $2
         AND (p.lng BETWEEN $3 AND $4 OR p.lng BETWEEN $3 + 360 AND $4 + 360 OR p.lng BETWEEN $3 - 360 AND $4 - 360)
         AND ($5::text IS NULL OR p.category = $5)`,
      [box.minLat, box.maxLat, box.minLng, box.maxLng, q.category ?? null],
    );
    const places = rows
      .map((r) => serializePlace(r, q))
      .filter((p) => p.distanceM <= q.radius)
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, q.limit);
    res.json({ places });
  }),
);

router.post(
  '/',
  route(async (req, res) => {
    const input = parse(createSchema, req.body);
    const row = await one(
      `INSERT INTO places (created_by, name, category, address, lat, lng)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.auth.userId, input.name, input.category, input.address, input.lat, input.lng],
    );
    res.status(201).json(serializePlace(row));
  }),
);

router.get(
  '/:id',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Place');
    const row = await one(`SELECT ${PLACE_COLUMNS} FROM places p WHERE p.id = $1`, [id]);
    if (!row) throw notFound('Place');
    res.json(serializePlace(row));
  }),
);

router.post(
  '/:id/checkins',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Place');
    const place = await one('SELECT id, name, lat, lng FROM places WHERE id = $1', [id]);
    if (!place) throw notFound('Place');
    const row = await one('INSERT INTO checkins (user_id, place_id) VALUES ($1, $2) RETURNING *', [
      req.auth.userId,
      id,
    ]);
    const checkin = {
      id: row.id,
      userId: row.user_id,
      place: { id: place.id, name: place.name, lat: place.lat, lng: place.lng },
      createdAt: row.created_at,
    };
    emitToUsers(await friendIds(req.auth.userId), 'friend:checkin', checkin);
    res.status(201).json(checkin);
  }),
);

export default router;
