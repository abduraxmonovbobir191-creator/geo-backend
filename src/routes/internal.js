import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { many, one } from '../db.js';
import { HttpError, idParam, notFound, parse, route } from '../lib/http.js';
import { publicUser } from '../lib/social.js';
import { buy, shopFor } from '../lib/shop.js';
import { buySchema } from './shop.js';
import geocodeRoutes from './geocode.js';

// Service API for the other Nex products (Nexly, Nexgram, Nex ID): one ecosystem, one account (the Nex ID `sub`).
// Auth is `X-Service-Key` (SERVICE_KEYS=nexly:<key>,...); the user is named by `X-Nexid-Sub`, never by a token.
// Never proxied publicly. Only public data leaves here: nothing of ghost mode, live locations or friends-only activities.
const router = Router();

function serviceFrom(req) {
  const given = Buffer.from(req.get('x-service-key') || '');
  for (const [name, key] of Object.entries(config.serviceKeys)) {
    const want = Buffer.from(key);
    if (given.length === want.length && crypto.timingSafeEqual(given, want)) return name;
  }
  return null;
}

router.use((req, _res, next) => {
  const service = serviceFrom(req);
  if (!service) return next(new HttpError(401, 'unauthorized', 'A valid service key is required'));
  req.service = service;
  next();
});

const userBySub = (sub) => one('SELECT * FROM users WHERE nexid_sub = $1', [sub]);

async function actingUser(req) {
  const sub = req.get('x-nexid-sub');
  if (!sub) throw new HttpError(400, 'bad_request', 'X-Nexid-Sub is required');
  const user = await userBySub(sub);
  if (!user) throw notFound('Nex Map user');
  return user;
}

// Address search for a post's place tag (Nexly posts.place) or a Nexgram location: same geocoder as the app.
router.use('/geocode', geocodeRoutes);

// Which of these Nex IDs already use Nex Map (for "people you know on Nex Map").
router.post(
  '/users/resolve',
  route(async (req, res) => {
    const { subs } = parse(z.object({ subs: z.array(z.string().max(64)).max(500) }), req.body);
    const rows = await many(
      'SELECT id, username, name, bio, avatar_url, created_at, nexid_sub FROM users WHERE nexid_sub = ANY($1)',
      [subs],
    );
    res.json({ users: rows.map((r) => ({ sub: r.nexid_sub, ...publicUser(r) })) });
  }),
);

// The profile card for a user's Nex Map tab: public numbers only.
router.get(
  '/users/me/profile',
  route(async (req, res) => {
    const user = await actingUser(req);
    const stats = await one(
      `SELECT COUNT(*) AS count, COALESCE(SUM(distance_m), 0) AS distance_m, COALESCE(SUM(moving_time_s), 0) AS moving_time_s
       FROM activities WHERE user_id = $1 AND visibility = 'public'`,
      [user.id],
    );
    res.json({
      user: publicUser(user),
      plan: user.plan,
      verificationLevel: user.verification_level,
      publicActivities: { count: stats.count, distanceM: stats.distance_m, movingTimeS: stats.moving_time_s },
    });
  }),
);

function card(r) {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    startedAt: r.started_at,
    distanceM: r.distance_m,
    durationS: r.duration_s,
    movingTimeS: r.moving_time_s,
    elevationGainM: r.elevation_gain_m,
    avgSpeedMps: r.avg_speed_mps,
    // Short [lat, lng] line for a small map in a post.
    preview: r.preview,
    owner: { sub: r.nexid_sub, username: r.username, name: r.name },
  };
}

const CARD_COLUMNS = `a.id, a.type, a.title, a.started_at, a.distance_m, a.duration_s, a.moving_time_s,
  a.elevation_gain_m, a.avg_speed_mps, a.preview, u.nexid_sub, u.username, u.name`;

// A user's public activities (for sharing to a Nexly post or story, or a Nexgram Lenta card).
router.get(
  '/users/me/activities',
  route(async (req, res) => {
    const user = await actingUser(req);
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }), req.query);
    const rows = await many(
      `SELECT ${CARD_COLUMNS} FROM activities a JOIN users u ON u.id = a.user_id
       WHERE a.user_id = $1 AND a.visibility = 'public' ORDER BY a.started_at DESC LIMIT $2`,
      [user.id, limit],
    );
    res.json({ activities: rows.map(card) });
  }),
);

// One public activity as a link card. Private and friends-only ones answer 404 (never reveal they exist).
router.get(
  '/activities/:id/card',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Activity');
    const row = await one(
      `SELECT ${CARD_COLUMNS} FROM activities a JOIN users u ON u.id = a.user_id WHERE a.id = $1 AND a.visibility = 'public'`,
      [id],
    );
    if (!row) throw notFound('Activity');
    res.json(card(row));
  }),
);

// Friends of Nexly / Nexgram (mutual follows, a Telegram contact) become Nex Map friends who already have an account.
// `with` is the caller's own list (it filters blocks and mutes first); a pending request between the two is accepted.
router.post(
  '/friends/sync',
  route(async (req, res) => {
    const user = await actingUser(req);
    const { with: subs } = parse(z.object({ with: z.array(z.string().max(64)).max(500) }), req.body);
    const others = await many('SELECT id FROM users WHERE nexid_sub = ANY($1) AND id <> $2', [subs, user.id]);
    let added = 0;
    for (const other of others) {
      const row = await one(
        `INSERT INTO friendships (requester_id, addressee_id, status, accepted_at, source)
         VALUES ($1, $2, 'accepted', NOW(), $3) ON CONFLICT DO NOTHING RETURNING id`,
        [user.id, other.id, req.service],
      );
      if (row) added += 1;
      else {
        // An earlier pending request between the two is accepted too.
        const up = await one(
          `UPDATE friendships SET status = 'accepted', accepted_at = NOW(), source = $3
           WHERE status = 'pending' AND LEAST(requester_id, addressee_id) = LEAST($1::uuid, $2::uuid)
             AND GREATEST(requester_id, addressee_id) = GREATEST($1::uuid, $2::uuid) RETURNING id`,
          [user.id, other.id, req.service],
        );
        if (up) added += 1;
      }
    }
    res.json({ added });
  }),
);

// Nexly and Nexgram show Nex Map's subscription and items with a buy button (1-2 taps, the person confirms in that app).
// The coins still come from the one Nex ID wallet and what is bought works only in Nex Map; `source` records the app.
router.get('/shop', route(async (req, res) => res.json(await shopFor(await actingUser(req)))));

router.post(
  '/shop/buy',
  route(async (req, res) => {
    const user = await actingUser(req);
    const p = await buy(user, { ...parse(buySchema, req.body), source: req.service });
    res.status(201).json({ purchase: { id: p.id, sku: p.sku, status: p.status, renewsAt: p.renews_at }, ...(await shopFor(user)) });
  }),
);

export default router;
