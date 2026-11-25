import { Router } from 'express';
import { z } from 'zod';
import { many, one } from '../db.js';
import { badRequest, idParam, notFound, parse, route } from '../lib/http.js';
import { trackStats } from '../lib/geo.js';
import { emitToUsers, publicUser } from '../lib/social.js';

const router = Router();

export const ACTIVITY_TYPES = ['run', 'ride', 'walk', 'hike'];
const VISIBILITIES = ['public', 'friends', 'private'];
const MAX_POINTS = 50_000;
const PREVIEW_POINTS = 100;
const DEFAULT_TITLES = { run: 'Run', ride: 'Ride', walk: 'Walk', hike: 'Hike' };

const timestamp = z.union([
  z.number().int().positive(),
  z.string().datetime({ offset: true }).transform((s) => Date.parse(s)),
]);

const pointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  t: timestamp,
  ele: z.number().min(-500).max(9_000).nullish(),
});

const createSchema = z.object({
  type: z.enum(ACTIVITY_TYPES),
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2_000).default(''),
  visibility: z.enum(VISIBILITIES).default('friends'),
  points: z.array(pointSchema).min(2).max(MAX_POINTS),
});

const updateSchema = z
  .object({
    type: z.enum(ACTIVITY_TYPES),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2_000),
    visibility: z.enum(VISIBILITIES),
  })
  .partial()
  .strict();

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  // Cursor: only activities that started before this time (use the last item's startedAt).
  before: z.string().datetime({ offset: true }).optional(),
});

function downsample(points, max) {
  if (points.length <= max) return points.map((p) => [p.lat, p.lng]);
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => {
    const p = points[Math.round(i * step)];
    return [p.lat, p.lng];
  });
}

// SQL condition for "the viewer ($1) may see activity a".
const VISIBLE_TO_VIEWER = `(
  a.user_id = $1
  OR a.visibility = 'public'
  OR (a.visibility = 'friends' AND EXISTS (
    SELECT 1 FROM friendships f
    WHERE f.status = 'accepted'
      AND LEAST(f.requester_id, f.addressee_id) = LEAST(a.user_id, $1::uuid)
      AND GREATEST(f.requester_id, f.addressee_id) = GREATEST(a.user_id, $1::uuid)
  ))
)`;

const SUMMARY_COLUMNS = `
  a.id, a.user_id, a.type, a.title, a.description, a.visibility, a.started_at, a.ended_at,
  a.distance_m, a.duration_s, a.moving_time_s, a.elevation_gain_m, a.avg_speed_mps, a.max_speed_mps,
  a.preview, a.created_at,
  u.username, u.name, u.bio, u.avatar_url, u.created_at AS user_created_at,
  (SELECT COUNT(*) FROM kudos k WHERE k.activity_id = a.id) AS kudos_count,
  EXISTS (SELECT 1 FROM kudos k WHERE k.activity_id = a.id AND k.user_id = $1) AS has_kudos`;

function serializeActivity(r, { points } = {}) {
  const activity = {
    id: r.id,
    user: publicUser({ ...r, id: r.user_id, created_at: r.user_created_at }),
    type: r.type,
    title: r.title,
    description: r.description,
    visibility: r.visibility,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    distanceM: r.distance_m,
    durationS: r.duration_s,
    movingTimeS: r.moving_time_s,
    elevationGainM: r.elevation_gain_m,
    avgSpeedMps: r.avg_speed_mps,
    maxSpeedMps: r.max_speed_mps,
    // Seconds per kilometer, the usual way runners read speed.
    avgPaceSPerKm: r.avg_speed_mps > 0 ? Math.round(1000 / r.avg_speed_mps) : null,
    preview: r.preview,
    kudosCount: r.kudos_count,
    hasKudos: r.has_kudos,
    createdAt: r.created_at,
  };
  if (points) {
    activity.points = points.map(([lat, lng, t, ele]) => ({ lat, lng, t: new Date(t).toISOString(), ele }));
  }
  return activity;
}

async function loadVisible(viewerId, id, { withPoints = false } = {}) {
  const row = await one(
    `SELECT ${SUMMARY_COLUMNS} ${withPoints ? ', a.points' : ''}
     FROM activities a JOIN users u ON u.id = a.user_id
     WHERE a.id = $2 AND ${VISIBLE_TO_VIEWER}`,
    [viewerId, id],
  );
  if (!row) throw notFound('Activity');
  return row;
}

router.post(
  '/',
  route(async (req, res) => {
    const input = parse(createSchema, req.body);
    const points = [...input.points].sort((a, b) => a.t - b.t);
    const startedAt = points[0].t;
    const endedAt = points[points.length - 1].t;
    if (endedAt <= startedAt) throw badRequest('Points must span a period of time');
    if (endedAt > Date.now() + 5 * 60_000) throw badRequest('Points cannot be in the future');

    const stats = trackStats(points);
    const row = await one(
      `INSERT INTO activities (
         user_id, type, title, description, visibility, started_at, ended_at,
         distance_m, duration_s, moving_time_s, elevation_gain_m, avg_speed_mps, max_speed_mps, points, preview)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0),
               $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        req.auth.userId,
        input.type,
        input.title ?? DEFAULT_TITLES[input.type],
        input.description,
        input.visibility,
        startedAt,
        endedAt,
        stats.distanceM,
        stats.durationS,
        stats.movingTimeS,
        stats.elevationGainM,
        stats.avgSpeedMps,
        stats.maxSpeedMps,
        JSON.stringify(points.map((p) => [p.lat, p.lng, p.t, p.ele ?? null])),
        JSON.stringify(downsample(points, PREVIEW_POINTS)),
      ],
    );
    const created = await loadVisible(req.auth.userId, row.id);
    res.status(201).json(serializeActivity(created));
  }),
);

// Feed: the caller's own activities plus those of friends they are allowed to see.
router.get(
  '/',
  route(async (req, res) => {
    const { limit, before } = parse(listSchema, req.query);
    const rows = await many(
      `SELECT ${SUMMARY_COLUMNS}
       FROM activities a JOIN users u ON u.id = a.user_id
       WHERE (a.user_id = $1 OR (a.visibility IN ('public', 'friends') AND EXISTS (
           SELECT 1 FROM friendships f
           WHERE f.status = 'accepted'
             AND LEAST(f.requester_id, f.addressee_id) = LEAST(a.user_id, $1::uuid)
             AND GREATEST(f.requester_id, f.addressee_id) = GREATEST(a.user_id, $1::uuid))))
         AND ($2::timestamptz IS NULL OR a.started_at < $2::timestamptz)
       ORDER BY a.started_at DESC
       LIMIT $3`,
      [req.auth.userId, before ?? null, limit],
    );
    res.json({ activities: rows.map((r) => serializeActivity(r)) });
  }),
);

export async function listUserActivities(req, res) {
  const userId = idParam(req.params.id, 'User');
  const { limit, before } = parse(listSchema, req.query);
  const rows = await many(
    `SELECT ${SUMMARY_COLUMNS}
     FROM activities a JOIN users u ON u.id = a.user_id
     WHERE a.user_id = $2 AND ${VISIBLE_TO_VIEWER}
       AND ($3::timestamptz IS NULL OR a.started_at < $3::timestamptz)
     ORDER BY a.started_at DESC
     LIMIT $4`,
    [req.auth.userId, userId, before ?? null, limit],
  );
  res.json({ activities: rows.map((r) => serializeActivity(r)) });
}

router.get(
  '/:id',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Activity');
    const row = await loadVisible(req.auth.userId, id, { withPoints: true });
    res.json(serializeActivity(row, { points: row.points }));
  }),
);

router.patch(
  '/:id',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Activity');
    const input = parse(updateSchema, req.body);
    const keys = Object.keys(input);
    if (keys.length > 0) {
      const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
      const row = await one(`UPDATE activities SET ${sets} WHERE id = $1 AND user_id = $2 RETURNING id`, [
        id,
        req.auth.userId,
        ...keys.map((k) => input[k]),
      ]);
      if (!row) throw notFound('Activity');
    }
    const row = await loadVisible(req.auth.userId, id);
    if (row.user_id !== req.auth.userId) throw notFound('Activity');
    res.json(serializeActivity(row));
  }),
);

router.delete(
  '/:id',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Activity');
    const row = await one('DELETE FROM activities WHERE id = $1 AND user_id = $2 RETURNING id', [
      id,
      req.auth.userId,
    ]);
    if (!row) throw notFound('Activity');
    res.status(204).end();
  }),
);

router.post(
  '/:id/kudos',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Activity');
    const activity = await loadVisible(req.auth.userId, id);
    if (activity.user_id === req.auth.userId) throw badRequest('You cannot give kudos to your own activity');
    const inserted = await one(
      'INSERT INTO kudos (activity_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING activity_id',
      [id, req.auth.userId],
    );
    if (inserted) {
      emitToUsers([activity.user_id], 'activity:kudos', { activityId: id, userId: req.auth.userId });
    }
    const { count } = await one('SELECT COUNT(*) AS count FROM kudos WHERE activity_id = $1', [id]);
    res.json({ kudosCount: count, hasKudos: true });
  }),
);

router.delete(
  '/:id/kudos',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Activity');
    await loadVisible(req.auth.userId, id);
    await one('DELETE FROM kudos WHERE activity_id = $1 AND user_id = $2', [id, req.auth.userId]);
    const { count } = await one('SELECT COUNT(*) AS count FROM kudos WHERE activity_id = $1', [id]);
    res.json({ kudosCount: count, hasKudos: false });
  }),
);

export default router;
