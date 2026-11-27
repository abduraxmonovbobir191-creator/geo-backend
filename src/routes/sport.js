import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { many, one, query } from '../db.js';
import { HttpError, conflict, forbidden, idParam, notFound, parse, route } from '../lib/http.js';
import { boundingBox, haversine } from '../lib/geo.js';

// Strava's social side: segments with leaderboards (KOM / QOM), clubs and challenges (also backed by a venue, always labelled an ad),
// and a heatmap of where people move. Only what a person chose to share counts: private activities never reach a board or the heatmap.
export const segmentRoutes = Router();
export const clubRoutes = Router();
export const challengeRoutes = Router();
export const heatmapRoutes = Router();

const TYPE = z.enum(['run', 'ride', 'walk', 'hike']);
const FRIEND = (a, b) => `EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'accepted'
  AND LEAST(f.requester_id, f.addressee_id) = LEAST(${a}::uuid, ${b}::uuid) AND GREATEST(f.requester_id, f.addressee_id) = GREATEST(${a}::uuid, ${b}::uuid))`;
const sees = (viewer) => `(a.user_id = ${viewer} OR a.visibility = 'public' OR (a.visibility = 'friends' AND ${FRIEND('a.user_id', viewer)}))`;

// ---------------- segments ----------------
function thin(points, max = 200) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, k) => points[Math.round(k * step)]);
}
const lengthOf = (pts) => pts.slice(1).reduce((sum, p, i) => sum + haversine(pts[i][0], pts[i][1], p[0], p[1]), 0);

segmentRoutes.post(
  '/',
  route(async (req, res) => {
    const b = parse(z.object({ name: z.string().trim().min(2).max(80), activityId: z.string().uuid(), from: z.number().int().min(0), to: z.number().int().min(1) }), req.body);
    const a = await one('SELECT type, points FROM activities WHERE id = $1 AND user_id = $2', [b.activityId, req.auth.userId]);
    if (!a) throw notFound('Activity');
    if (b.to <= b.from || b.to >= a.points.length) throw new HttpError(400, 'bad_range', 'Pick a part of the track');
    const pts = thin(a.points.slice(b.from, b.to + 1).map((p) => [p[0], p[1]]));
    const distance = lengthOf(pts);
    if (distance < 200 || distance > 50_000) throw new HttpError(400, 'bad_length', 'A segment is between 200 m and 50 km');
    const lats = pts.map((p) => p[0]);
    const lngs = pts.map((p) => p[1]);
    const row = await one(
      `INSERT INTO segments (created_by, name, type, points, distance_m, min_lat, max_lat, min_lng, max_lng) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.auth.userId, b.name, a.type, JSON.stringify(pts), distance, Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)],
    );
    res.status(201).json(serializeSegment(row));
  }),
);

const serializeSegment = (r) => ({ id: r.id, name: r.name, type: r.type, distanceM: Math.round(r.distance_m), start: r.points[0], end: r.points.at(-1) });

segmentRoutes.get(
  '/nearby',
  route(async (req, res) => {
    const q = parse(z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180), radius: z.coerce.number().min(100).max(20_000).default(3000), type: TYPE.optional() }), req.query);
    const box = boundingBox(q.lat, q.lng, q.radius);
    const rows = await many(
      `SELECT * FROM segments WHERE max_lat >= $1 AND min_lat <= $2 AND max_lng >= $3 AND min_lng <= $4 AND ($5::text IS NULL OR type = $5) LIMIT 100`,
      [box.minLat, box.maxLat, box.minLng, box.maxLng, q.type ?? null],
    );
    res.json({ segments: rows.map((r) => ({ ...serializeSegment(r), distanceFromYouM: Math.round(haversine(q.lat, q.lng, r.points[0][0], r.points[0][1])) })).sort((x, y) => x.distanceFromYouM - y.distanceFromYouM) });
  }),
);

// The board: each person's best time on what the viewer may see; the top is the KOM / QOM. `me`: your best and your place.
segmentRoutes.get(
  '/:id',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Segment');
    const seg = await one('SELECT * FROM segments WHERE id = $1', [id]);
    if (!seg) throw notFound('Segment');
    const viewer = req.auth.userId;
    const rows = await many(
      `WITH best AS (
         SELECT DISTINCT ON (e.user_id) e.user_id, e.elapsed_s, e.started_at, e.activity_id
         FROM segment_efforts e JOIN activities a ON a.id = e.activity_id
         WHERE e.segment_id = $1 AND ${sees('$2')}
         ORDER BY e.user_id, e.elapsed_s)
       SELECT b.*, u.username, u.name, u.avatar_url, RANK() OVER (ORDER BY b.elapsed_s) AS place FROM best b JOIN users u ON u.id = b.user_id ORDER BY b.elapsed_s LIMIT 200`,
      [id, viewer],
    );
    const board = rows.slice(0, 20).map((r) => ({ place: Number(r.place), user: { id: r.user_id, username: r.username, name: r.name, avatarUrl: r.avatar_url }, elapsedS: r.elapsed_s, at: r.started_at }));
    const mine = rows.find((r) => r.user_id === viewer);
    res.json({ segment: serializeSegment(seg), efforts: rows.length, kom: board[0] ?? null, board, me: mine ? { place: Number(mine.place), elapsedS: mine.elapsed_s } : null });
  }),
);

// ---------------- clubs and challenges ----------------
const serializeClub = (r, mine) => ({ id: r.id, name: r.name, description: r.description, members: r.members ?? undefined, owner: r.owner_id, ...(mine !== undefined ? { joined: mine } : {}) });

clubRoutes.post(
  '/',
  route(async (req, res) => {
    const b = parse(z.object({ name: z.string().trim().min(3).max(60), description: z.string().trim().max(300).default('') }), req.body);
    let club;
    try {
      club = await one('INSERT INTO clubs (name, description, owner_id) VALUES ($1, $2, $3) RETURNING *', [b.name, b.description, req.auth.userId]);
    } catch (err) {
      if (err.code === '23505') throw conflict('A club with this name exists');
      throw err;
    }
    await query('INSERT INTO club_members (club_id, user_id) VALUES ($1, $2)', [club.id, req.auth.userId]);
    res.status(201).json(serializeClub(club, true));
  }),
);

clubRoutes.get(
  '/',
  route(async (req, res) => {
    const { q } = parse(z.object({ q: z.string().trim().max(60).optional() }), req.query);
    const rows = await many(
      `SELECT c.*, (SELECT COUNT(*) FROM club_members m WHERE m.club_id = c.id) AS members,
              EXISTS (SELECT 1 FROM club_members m WHERE m.club_id = c.id AND m.user_id = $1) AS mine
       FROM clubs c WHERE ($2::text IS NULL OR c.name ILIKE '%' || $2 || '%') ORDER BY members DESC, c.created_at DESC LIMIT 50`,
      [req.auth.userId, q ? q.replace(/[%_\\]/g, '') : null],
    );
    res.json({ clubs: rows.map((r) => serializeClub(r, r.mine)) });
  }),
);

clubRoutes.get(
  '/:id',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Club');
    const c = await one(
      `SELECT c.*, (SELECT COUNT(*) FROM club_members m WHERE m.club_id = c.id) AS members,
              EXISTS (SELECT 1 FROM club_members m WHERE m.club_id = c.id AND m.user_id = $2) AS mine FROM clubs c WHERE c.id = $1`,
      [id, req.auth.userId],
    );
    if (!c) throw notFound('Club');
    const ch = await many(
      `SELECT ch.*, p.name AS sponsor_name FROM challenges ch LEFT JOIN places p ON p.id = ch.sponsor_place_id WHERE ch.club_id = $1 ORDER BY ch.ends_at DESC LIMIT 20`,
      [id],
    );
    res.json({ ...serializeClub(c, c.mine), challenges: ch.map(serializeChallenge) });
  }),
);

clubRoutes.post('/:id/join', route(async (req, res) => {
  const id = idParam(req.params.id, 'Club');
  if (!(await one('SELECT 1 FROM clubs WHERE id = $1', [id]))) throw notFound('Club');
  await query('INSERT INTO club_members (club_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, req.auth.userId]);
  res.status(204).end();
}));

clubRoutes.delete('/:id/leave', route(async (req, res) => {
  const id = idParam(req.params.id, 'Club');
  const c = await one('SELECT owner_id FROM clubs WHERE id = $1', [id]);
  if (!c) throw notFound('Club');
  if (c.owner_id === req.auth.userId) throw forbidden('The owner cannot leave; delete the club instead');
  await query('DELETE FROM club_members WHERE club_id = $1 AND user_id = $2', [id, req.auth.userId]);
  res.status(204).end();
}));

const serializeChallenge = (r) => ({
  id: r.id, clubId: r.club_id, title: r.title, metric: r.metric, type: r.type, startsAt: r.starts_at, endsAt: r.ends_at,
  ...(r.sponsor_place_id ? { ad: true, sponsor: { id: r.sponsor_place_id, name: r.sponsor_name } } : {}),
});

clubRoutes.post(
  '/:id/challenges',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Club');
    const b = parse(z.object({ title: z.string().trim().min(3).max(80), metric: z.enum(['distance', 'time', 'count']), type: TYPE.nullable().default(null), days: z.number().int().min(1).max(90).default(30), sponsorPlaceId: z.string().uuid().nullable().default(null) }), req.body);
    const c = await one('SELECT owner_id FROM clubs WHERE id = $1', [id]);
    if (!c) throw notFound('Club');
    if (c.owner_id !== req.auth.userId) throw forbidden('Only the club owner starts a challenge');
    if (b.sponsorPlaceId && !(await one('SELECT 1 FROM places WHERE id = $1 AND owner_id = $2', [b.sponsorPlaceId, req.auth.userId]))) {
      throw forbidden('A sponsor must be your own business place'); // brands back a challenge through their own verified place
    }
    const row = await one(
      `INSERT INTO challenges (club_id, title, metric, type, starts_at, ends_at, sponsor_place_id) VALUES ($1, $2, $3, $4, NOW(), NOW() + make_interval(days => $5), $6) RETURNING *`,
      [id, b.title, b.metric, b.type, b.days, b.sponsorPlaceId],
    );
    res.status(201).json(serializeChallenge(row));
  }),
);

// Progress of club members in the period: distance, time or number of activities. Only activities a member did not keep private count;
// the board shows totals, never routes.
challengeRoutes.get(
  '/:id',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Challenge');
    const ch = await one('SELECT ch.*, p.name AS sponsor_name FROM challenges ch LEFT JOIN places p ON p.id = ch.sponsor_place_id WHERE ch.id = $1', [id]);
    if (!ch) throw notFound('Challenge');
    const value = ch.metric === 'distance' ? 'SUM(a.distance_m)' : ch.metric === 'time' ? 'SUM(a.moving_time_s)' : 'COUNT(*)';
    const rows = await many(
      `SELECT m.user_id, u.username, u.name, u.avatar_url, COALESCE(${value}, 0) AS total
       FROM club_members m JOIN users u ON u.id = m.user_id
       LEFT JOIN activities a ON a.user_id = m.user_id AND a.visibility <> 'private' AND a.started_at >= $2 AND a.started_at < $3 AND ($4::text IS NULL OR a.type = $4)
       WHERE m.club_id = $1 GROUP BY m.user_id, u.username, u.name, u.avatar_url ORDER BY total DESC, u.username LIMIT 50`,
      [ch.club_id, ch.starts_at, ch.ends_at, ch.type],
    );
    res.json({ challenge: serializeChallenge(ch), board: rows.map((r, i) => ({ place: i + 1, user: { id: r.user_id, username: r.username, name: r.name, avatarUrl: r.avatar_url }, total: Math.round(Number(r.total)) })) });
  }),
);

// ---------------- heatmap ----------------
// Cells of about 100 m where at least HEAT_MIN_USERS different people moved in public activities. A busy place is never one person's route.
heatmapRoutes.get(
  '/',
  route(async (req, res) => {
    const q = parse(z.object({
      minLat: z.coerce.number().min(-90).max(90), maxLat: z.coerce.number().min(-90).max(90), minLng: z.coerce.number().min(-180).max(180), maxLng: z.coerce.number().min(-180).max(180), type: TYPE.optional(),
    }), req.query);
    if (q.maxLat - q.minLat > 0.3 || q.maxLng - q.minLng > 0.3 || q.maxLat <= q.minLat || q.maxLng <= q.minLng) throw new HttpError(400, 'bad_box', 'Ask for an area up to about 30 km');
    const rows = await many(
      `SELECT FLOOR((p->>0)::float / 0.001) AS la, FLOOR((p->>1)::float / 0.001) AS ln, COUNT(DISTINCT a.user_id) AS users, COUNT(*) AS n
       FROM activities a, jsonb_array_elements(a.preview) AS p
       WHERE a.visibility = 'public' AND ($5::text IS NULL OR a.type = $5)
         AND (p->>0)::float BETWEEN $1 AND $2 AND (p->>1)::float BETWEEN $3 AND $4
       GROUP BY la, ln HAVING COUNT(DISTINCT a.user_id) >= $6 ORDER BY n DESC LIMIT 3000`,
      [q.minLat, q.maxLat, q.minLng, q.maxLng, q.type ?? null, config.heatMinUsers],
    );
    res.json({ size: 0.001, cells: rows.map((r) => ({ lat: Number(r.la) * 0.001, lng: Number(r.ln) * 0.001, weight: Number(r.n) })) });
  }),
);
