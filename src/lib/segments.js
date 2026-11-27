import { many, query } from '../db.js';
import { haversine } from './geo.js';

const END_NEAR_M = 30;
const PATH_NEAR_M = 60;

// Does a recorded track ride this segment? It must pass near the start and then near the end, and follow the line between (so a shortcut
// that touches both ends does not count). Returns the elapsed seconds or null. points: [[lat, lng, tMillis, ele], ...] sorted by time.
export function matchSegment(points, seg) {
  const start = seg.points[0];
  const end = seg.points[seg.points.length - 1];
  const i = points.findIndex((p) => haversine(p[0], p[1], start[0], start[1]) <= END_NEAR_M);
  if (i < 0) return null;
  let j = -1;
  for (let k = i + 1; k < points.length; k++) {
    if (haversine(points[k][0], points[k][1], end[0], end[1]) <= END_NEAR_M) { j = k; break; }
  }
  if (j < 0) return null;
  for (let s = 1; s <= 4; s++) {
    const want = seg.points[Math.floor((seg.points.length - 1) * (s / 5))];
    let ok = false;
    for (let k = i; k <= j && !ok; k++) ok = haversine(points[k][0], points[k][1], want[0], want[1]) <= PATH_NEAR_M;
    if (!ok) return null;
  }
  const elapsed = Math.round((points[j][2] - points[i][2]) / 1000);
  return elapsed > 0 ? elapsed : null;
}

// After an activity is saved: every segment of the same type whose box the track touches gets an effort if the track rode it.
export async function recordEfforts({ activityId, userId, type, points }) {
  const lats = points.map((p) => p[0]);
  const lngs = points.map((p) => p[1]);
  const segs = await many(
    `SELECT * FROM segments WHERE type = $1 AND max_lat >= $2 AND min_lat <= $3 AND max_lng >= $4 AND min_lng <= $5 LIMIT 200`,
    [type, Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)],
  );
  let n = 0;
  for (const seg of segs) {
    const elapsed = matchSegment(points, seg);
    if (!elapsed) continue;
    await query(
      `INSERT INTO segment_efforts (segment_id, user_id, activity_id, elapsed_s, started_at) SELECT $1, $2, $3, $4, started_at FROM activities WHERE id = $3 ON CONFLICT DO NOTHING`,
      [seg.id, userId, activityId, elapsed],
    );
    n += 1;
  }
  return n;
}
