import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.js';
import { many, one } from '../db.js';
import { conflict, parse, route, unauthorized } from '../lib/http.js';
import { refreshPlan } from '../lib/plans.js';
import { emitToUsers, friendIds } from '../lib/social.js';
import { MODES, STILL_RADIUS_M, distanceM, viewsForFriends } from '../lib/privacy.js';
import { sessionOnly } from '../middleware/auth.js';

const router = Router();

export function serializeMe(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    name: row.name,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    ghostMode: row.ghost_mode,
    createdAt: row.created_at,
    // Nex ID account (shared with Nexly and Nexgram) and Nex Premium.
    nexid: row.nexid_sub ? { verificationLevel: row.verification_level } : null,
    plan: row.plan,
    perks: row.perks,
    // Nex ID perks plus Nex Map purchases: what this account can use in Nex Map.
    entitlements: row.entitlements ?? row.perks,
    premiumUrl: config.nexid.premiumUrl,
  };
}

export function serializeLocation(row) {
  return {
    userId: row.user_id,
    lat: row.lat,
    lng: row.lng,
    accuracy: row.accuracy,
    speed: row.speed,
    heading: row.heading,
    battery: row.battery,
    activity: row.activity ?? null,
    isCharging: row.is_charging ?? null,
    stepsToday: row.steps_today ?? null,
    updatedAt: row.updated_at,
  };
}

router.get(
  '/',
  route(async (req, res) => {
    const user = await refreshPlan(await one('SELECT * FROM users WHERE id = $1', [req.auth.userId]));
    res.json(serializeMe(user));
  }),
);

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    username: z
      .string()
      .trim()
      .min(3)
      .max(30)
      .regex(/^[a-zA-Z0-9_.]+$/, 'Only letters, digits, "_" and "."'),
    bio: z.string().trim().max(300),
    avatarUrl: z.string().url().max(500).nullable(),
    ghostMode: z.boolean(),
  })
  .partial()
  .strict();

const columns = { name: 'name', username: 'username', bio: 'bio', avatarUrl: 'avatar_url', ghostMode: 'ghost_mode' };

router.patch(
  '/',
  route(async (req, res) => {
    const input = parse(updateSchema, req.body);
    const keys = Object.keys(input);
    let user;
    if (keys.length === 0) {
      user = await one('SELECT * FROM users WHERE id = $1', [req.auth.userId]);
    } else {
      const sets = keys.map((k, i) => `${columns[k]} = $${i + 2}`).join(', ');
      try {
        user = await one(`UPDATE users SET ${sets} WHERE id = $1 RETURNING *`, [
          req.auth.userId,
          ...keys.map((k) => input[k]),
        ]);
      } catch (err) {
        if (err.code === '23505') throw conflict('Username is taken');
        throw err;
      }
    }
    if ('ghostMode' in input) {
      emitToUsers(await friendIds(req.auth.userId), 'friend:ghost', {
        userId: req.auth.userId,
        ghostMode: input.ghostMode,
      });
    }
    res.json(serializeMe(user));
  }),
);

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});

router.put(
  '/password',
  sessionOnly,
  route(async (req, res) => {
    const input = parse(passwordSchema, req.body);
    const user = await one('SELECT password_hash FROM users WHERE id = $1', [req.auth.userId]);
    if (!user.password_hash || !(await bcrypt.compare(input.currentPassword, user.password_hash))) {
      throw unauthorized('Current password is wrong');
    }
    await one('UPDATE users SET password_hash = $2 WHERE id = $1', [
      req.auth.userId,
      await bcrypt.hash(input.newPassword, 10),
    ]);
    res.status(204).end();
  }),
);

// How you appear to friends by default, and which sensitive extras (movement, charging, steps) they may see.
const sharingSchema = z
  .object({ defaultMode: z.enum(MODES), activity: z.boolean(), steps: z.boolean() })
  .partial()
  .strict();

router.get(
  '/sharing',
  route(async (req, res) => {
    const u = await one('SELECT share_mode, share_activity, share_steps, ghost_mode FROM users WHERE id = $1', [req.auth.userId]);
    res.json({ defaultMode: u.share_mode, activity: u.share_activity, steps: u.share_steps, ghostMode: u.ghost_mode });
  }),
);

router.put(
  '/sharing',
  route(async (req, res) => {
    const input = parse(sharingSchema, req.body);
    const u = await one(
      `UPDATE users SET share_mode = COALESCE($2, share_mode), share_activity = COALESCE($3, share_activity),
         share_steps = COALESCE($4, share_steps) WHERE id = $1 RETURNING share_mode, share_activity, share_steps, ghost_mode`,
      [req.auth.userId, input.defaultMode ?? null, input.activity ?? null, input.steps ?? null],
    );
    res.json({ defaultMode: u.share_mode, activity: u.share_activity, steps: u.share_steps, ghostMode: u.ghost_mode });
  }),
);

// A short status ("Coffee"), shown on the map next to the avatar; it ends by itself (hours, default 8, up to 48).
router.put(
  '/status',
  route(async (req, res) => {
    const { text, hours } = parse(z.object({ text: z.string().trim().max(60), hours: z.number().int().min(1).max(48).default(8) }), req.body);
    await one(
      'UPDATE users SET status_text = $2, status_until = $3 WHERE id = $1 RETURNING id',
      [req.auth.userId, text || null, text ? new Date(Date.now() + hours * 3_600_000) : null],
    );
    res.json({ text: text || null });
  }),
);

export const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100_000).nullish(),
  speed: z.number().min(0).max(1_000).nullish(),
  heading: z.number().min(0).max(360).nullish(),
  battery: z.number().int().min(0).max(100).nullish(),
  // Sensitive extras: stored always, shown to friends only when the owner turned the matching switch on.
  activity: z.enum(['still', 'walking', 'vehicle', 'sleeping']).nullish(),
  isCharging: z.boolean().nullish(),
  stepsToday: z.number().int().min(0).max(1_000_000).nullish(),
});

/**
 * Stores the caller's location and pushes it to online friends. In ghost mode nothing is
 * stored or sent, so friends keep seeing the last position from before ghost mode.
 * Returns { shared, location }.
 */
export async function updateLocation(userId, input) {
  const user = await one('SELECT ghost_mode FROM users WHERE id = $1', [userId]);
  if (!user || user.ghost_mode) return { shared: false, location: null };

  // "Here for N minutes": the anchor moves only when the person leaves a small circle around it.
  const before = await one('SELECT anchor_lat, anchor_lng, anchor_since FROM locations WHERE user_id = $1', [userId]);
  const stays = before?.anchor_since && distanceM(before.anchor_lat, before.anchor_lng, input.lat, input.lng) <= STILL_RADIUS_M;
  const anchor = stays ? [before.anchor_lat, before.anchor_lng, before.anchor_since] : [input.lat, input.lng, new Date()];

  const row = await one(
    `INSERT INTO locations (user_id, lat, lng, accuracy, speed, heading, battery, activity, is_charging, steps_today,
                            anchor_lat, anchor_lng, anchor_since, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       lat = EXCLUDED.lat, lng = EXCLUDED.lng, accuracy = EXCLUDED.accuracy, speed = EXCLUDED.speed,
       heading = EXCLUDED.heading, battery = EXCLUDED.battery, activity = EXCLUDED.activity,
       is_charging = EXCLUDED.is_charging, steps_today = EXCLUDED.steps_today,
       anchor_lat = EXCLUDED.anchor_lat, anchor_lng = EXCLUDED.anchor_lng, anchor_since = EXCLUDED.anchor_since,
       updated_at = NOW()
     RETURNING *`,
    [userId, input.lat, input.lng, input.accuracy ?? null, input.speed ?? null, input.heading ?? null, input.battery ?? null,
      input.activity ?? null, input.isCharging ?? null, input.stepsToday ?? null, ...anchor],
  );
  // Each friend gets their own view of the point (precise, blurred, frozen or nothing).
  for (const { friendId, view } of await viewsForFriends(userId)) {
    if (view) emitToUsers([friendId], 'friend:location', view);
  }
  return { shared: true, location: serializeLocation(row) };
}

router.put(
  '/location',
  route(async (req, res) => {
    const input = parse(locationSchema, req.body);
    res.json(await updateLocation(req.auth.userId, input));
  }),
);

router.get(
  '/stats',
  route(async (req, res) => {
    const rows = await many(
      `SELECT type,
              period,
              COUNT(*)                   AS count,
              COALESCE(SUM(distance_m), 0)       AS distance_m,
              COALESCE(SUM(moving_time_s), 0)    AS moving_time_s,
              COALESCE(SUM(elevation_gain_m), 0) AS elevation_gain_m
       FROM activities
       CROSS JOIN LATERAL (VALUES
         ('week',  started_at >= NOW() - INTERVAL '7 days'),
         ('month', started_at >= NOW() - INTERVAL '28 days'),
         ('all',   TRUE)
       ) AS p(period, included)
       WHERE user_id = $1 AND included
       GROUP BY type, period`,
      [req.auth.userId],
    );
    const empty = () => ({ count: 0, distanceM: 0, movingTimeS: 0, elevationGainM: 0 });
    const stats = { week: empty(), month: empty(), all: empty(), byType: {} };
    for (const r of rows) {
      const add = (target) => {
        target.count += r.count;
        target.distanceM += r.distance_m;
        target.movingTimeS += r.moving_time_s;
        target.elevationGainM += r.elevation_gain_m;
      };
      add(stats[r.period]);
      stats.byType[r.type] ??= { week: empty(), month: empty(), all: empty() };
      add(stats.byType[r.type][r.period]);
    }
    res.json(stats);
  }),
);

export default router;
