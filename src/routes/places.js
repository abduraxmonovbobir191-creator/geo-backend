import { Router } from 'express';
import { z } from 'zod';
import { many, one } from '../db.js';
import { idParam, notFound, parse, route } from '../lib/http.js';
import { boundingBox, haversine } from '../lib/geo.js';
import { isOpenNow, promotionsFor, ratingsFor, bump } from '../lib/business.js';
import { emitToUsers, friendIds } from '../lib/social.js';

const router = Router();

export const PLACE_CATEGORIES = [
  'restaurant', 'cafe', 'pharmacy', 'fuel', 'auto_service', 'shop', 'hotel', 'bank', 'park', 'gym', 'sport', 'school', 'work', 'home', 'other',
];

const lat = z.coerce.number().min(-90).max(90);
const lng = z.coerce.number().min(-180).max(180);

const nearbySchema = z.object({
  lat,
  lng,
  radius: z.coerce.number().min(1).max(50_000).default(1_000),
  category: z.enum(PLACE_CATEGORIES).optional(),
  q: z.string().trim().min(1).max(80).optional(),
  openNow: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.enum(PLACE_CATEGORIES).default('other'),
  address: z.string().trim().max(300).default(''),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

function serializePlace(r, origin, extra = {}) {
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
    // Business card (Yandex): everything is optional until the owner fills it in.
    verifiedBusiness: Boolean(r.owner_id),
    description: r.description ?? '',
    phone: r.phone ?? null,
    website: r.website ?? null,
    photos: r.photos ?? [],
    priceLevel: r.price_level ?? null,
    hours: r.hours ?? null,
    open: isOpenNow(r.hours, r.utc_offset_min),
    rating: extra.rating?.rating ?? null,
    reviewCount: extra.rating?.count ?? 0,
  };
  // Paid positions are always labelled: `ad` is true for a bought Top place, never hidden from the reader.
  if (extra.promo?.top) Object.assign(place, { ad: true, sponsored: true, topTier: extra.promo.top });
  // A branded pin shows only while its promotion runs.
  if (extra.promo?.pin) place.brandedPin = { logoUrl: r.pin_logo_url, modelUrl: r.pin_model_url };
  if (origin) place.distanceM = Math.round(haversine(origin.lat, origin.lng, r.lat, r.lng));
  return place;
}

const PLACE_COLUMNS = `p.*, (SELECT COUNT(*) FROM checkins c WHERE c.place_id = p.id) AS checkin_count`;

router.get('/categories', (_req, res) => res.json({ categories: PLACE_CATEGORIES.filter((c) => !['home', 'work'].includes(c)) }));

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
         AND ($5::text IS NULL OR p.category = $5)
         AND ($6::text IS NULL OR p.name ILIKE '%' || $6 || '%')`,
      [box.minLat, box.maxLat, box.minLng, box.maxLng, q.category ?? null, q.q ? q.q.replace(/[%_\\]/g, '') : null],
    );
    const ids = rows.map((r) => r.id);
    const [promos, ratings] = await Promise.all([promotionsFor(ids), ratingsFor(ids)]);
    let places = rows
      .map((r) => serializePlace(r, q, { promo: promos.get(r.id), rating: ratings.get(r.id) }))
      .filter((p) => p.distanceM <= q.radius && (q.openNow === undefined || p.open === (q.openNow === 'true')));
    // Bought Top places first (tier 1, 2, 3, at most three, labelled `ad`), then everyone by distance. A paid place never
    // outranks the others after those three, and its rating is its own.
    const top = places.filter((p) => p.sponsored).sort((a, b) => a.topTier - b.topTier || a.distanceM - b.distanceM).slice(0, 3);
    const rest = places.filter((p) => !top.includes(p)).sort((a, b) => a.distanceM - b.distanceM);
    places = [...top.map((p) => p), ...rest.map(({ sponsored, ad, topTier, ...p }) => p)].slice(0, q.limit);
    bump(places.map((p) => p.id), 'impression');
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
    const [promos, ratings] = await Promise.all([promotionsFor([id]), ratingsFor([id])]);
    bump([id], 'card_open');
    res.json(serializePlace(row, null, { promo: promos.get(id), rating: ratings.get(id) }));
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
