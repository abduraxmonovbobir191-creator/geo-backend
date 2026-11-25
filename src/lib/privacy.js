// What a friend may see of someone's location. The server decides, never the client: a blurred or frozen
// friend never receives the precise point, and a hidden one receives nothing at all.
import { many, one } from '../db.js';
import { haversine } from './geo.js';

export const MODES = ['precise', 'blurred', 'frozen', 'hidden'];
const BLUR_STEP_DEG = 0.01; // about 1.1 km
export const BLUR_RADIUS_M = 700;
export const STILL_RADIUS_M = 80;

export function blurPoint(lat, lng) {
  const latStep = BLUR_STEP_DEG;
  const lngStep = BLUR_STEP_DEG / Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  return {
    lat: (Math.floor(lat / latStep) + 0.5) * latStep,
    lng: (Math.floor(lng / lngStep) + 0.5) * lngStep,
  };
}

// The friend's view of `loc` (a locations row joined with the owner's flags), or null.
// `mode` is the effective mode for that friend; `frozen` the snapshot for "frozen".
export function viewOf({ mode, frozen, owner, loc, now = Date.now() }) {
  if (!loc || mode === 'hidden') return null;
  const status = owner.status_text && (!owner.status_until || new Date(owner.status_until) > now) ? owner.status_text : null;
  const base = { userId: loc.user_id, mode, status };
  if (mode === 'frozen') {
    if (frozen?.frozen_lat == null) return null;
    return { ...base, lat: frozen.frozen_lat, lng: frozen.frozen_lng, frozen: true, updatedAt: frozen.frozen_at };
  }
  const point = mode === 'blurred' ? blurPoint(loc.lat, loc.lng) : { lat: loc.lat, lng: loc.lng };
  const out = {
    ...base,
    ...point,
    ...(mode === 'blurred' ? { blurred: true, radiusM: BLUR_RADIUS_M } : { accuracy: loc.accuracy, speed: loc.speed, heading: loc.heading }),
    battery: loc.battery,
    updatedAt: loc.updated_at,
  };
  // Extras are opt-in, and a blurred friend gets none that could give the exact place away.
  if (owner.share_activity) {
    out.activity = loc.activity ?? null;
    if (mode === 'precise' && loc.anchor_since) out.stillForS = Math.max(0, Math.round((now - new Date(loc.anchor_since).getTime()) / 1000));
    out.isCharging = loc.is_charging ?? null;
  }
  if (owner.share_steps) out.stepsToday = loc.steps_today ?? null;
  return out;
}

// For one owner: how each friend sees them -> [{ friendId, view }]. Used by the live push after a location update.
export async function viewsForFriends(ownerId) {
  const [owner, loc, rows] = await Promise.all([
    one('SELECT * FROM users WHERE id = $1', [ownerId]),
    one('SELECT * FROM locations WHERE user_id = $1', [ownerId]),
    many(
      `SELECT CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END AS friend_id,
              s.mode, s.frozen_lat, s.frozen_lng, s.frozen_at
       FROM friendships f
       LEFT JOIN location_sharing s ON s.owner_id = $1
         AND s.friend_id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
       WHERE f.status = 'accepted' AND (f.requester_id = $1 OR f.addressee_id = $1)`,
      [ownerId],
    ),
  ]);
  return rows.map((r) => ({ friendId: r.friend_id, view: viewOf({ mode: r.mode ?? owner.share_mode, frozen: r, owner, loc }) }));
}

export const distanceM = haversine;
