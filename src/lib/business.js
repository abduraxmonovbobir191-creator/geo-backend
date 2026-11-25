import { many, query } from '../db.js';

export const cellOf = (lat, lng) => `${Math.floor(lat / 0.05)}:${Math.floor(lng / 0.05)}`;

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// true / false from the opening hours in the place's own time zone, null when it has none.
export function isOpenNow(hours, utcOffsetMin = 300, now = Date.now()) {
  if (!hours || typeof hours !== 'object') return null;
  const local = new Date(now + utcOffsetMin * 60_000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const spans = hours[DAYS[local.getUTCDay()]] ?? [];
  const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return spans.some(([from, to]) => {
    const a = toMin(from);
    const b = toMin(to);
    return b > a ? minutes >= a && minutes < b : minutes >= a || minutes < b; // 22:00-02:00 runs past midnight
  });
}

// Counts only, never who looked. Fire and forget: a failed count must not fail the request.
export function bump(placeIds, kind, by = 1) {
  const ids = [...new Set(placeIds)];
  if (!ids.length) return Promise.resolve();
  return query(
    `INSERT INTO place_stats_daily (place_id, day, kind, count)
     SELECT id, CURRENT_DATE, $2, $3 FROM unnest($1::uuid[]) AS id
     ON CONFLICT (place_id, day, kind) DO UPDATE SET count = place_stats_daily.count + EXCLUDED.count`,
    [ids, kind, by],
  ).catch(() => {});
}

// Active promotions for these places: { placeId: { top: tier|null, pin: bool } }.
export async function promotionsFor(placeIds) {
  if (!placeIds.length) return new Map();
  const rows = await many(
    `SELECT place_id, kind, tier, expires_at FROM promotions WHERE place_id = ANY($1) AND status = 'active' AND expires_at > NOW()`,
    [placeIds],
  );
  const map = new Map();
  for (const r of rows) {
    const p = map.get(r.place_id) ?? { top: null, pin: false };
    if (r.kind === 'top') p.top = r.tier;
    else p.pin = true;
    map.set(r.place_id, p);
  }
  return map;
}

export async function ratingsFor(placeIds) {
  if (!placeIds.length) return new Map();
  const rows = await many(
    'SELECT place_id, ROUND(AVG(rating)::numeric, 1) AS rating, COUNT(*) AS count FROM place_reviews WHERE place_id = ANY($1) GROUP BY place_id',
    [placeIds],
  );
  return new Map(rows.map((r) => [r.place_id, { rating: Number(r.rating), count: r.count }]));
}
