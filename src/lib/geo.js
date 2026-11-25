const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg) => (deg * Math.PI) / 180;

// Great-circle distance in meters between two lat/lng points.
export function haversine(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Lat/lng box that contains every point within radiusM of the center. Used to pre-filter with
// an index before the exact haversine check.
export function boundingBox(lat, lng, radiusM) {
  const dLat = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const cosLat = Math.cos(toRad(lat));
  const dLng = cosLat < 1e-9 ? 180 : Math.min(180, dLat / cosLat);
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

// Segments faster than this are treated as GPS glitches and ignored (about 360 km/h).
const MAX_PLAUSIBLE_SPEED_MPS = 100;
// Below this speed a segment counts as standing still, not moving time.
const MIN_MOVING_SPEED_MPS = 0.5;
// Elevation has to climb at least this much before it counts, to ignore GPS altitude noise.
const ELEVATION_NOISE_M = 2;

/**
 * Computes activity statistics from GPS points sorted by time.
 * @param {{lat:number,lng:number,t:number,ele?:number|null}[]} points  t is unix milliseconds
 */
export function trackStats(points) {
  let distance = 0;
  let moving = 0;
  let maxSpeed = 0;
  let gain = 0;
  let refEle = null;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.ele != null) {
      if (refEle == null || p.ele < refEle) {
        refEle = p.ele;
      } else if (p.ele - refEle >= ELEVATION_NOISE_M) {
        gain += p.ele - refEle;
        refEle = p.ele;
      }
    }
    if (i === 0) continue;

    const prev = points[i - 1];
    const dt = (p.t - prev.t) / 1000;
    if (dt <= 0) continue;
    const d = haversine(prev.lat, prev.lng, p.lat, p.lng);
    const speed = d / dt;
    if (speed > MAX_PLAUSIBLE_SPEED_MPS) continue;

    distance += d;
    if (speed >= MIN_MOVING_SPEED_MPS) {
      moving += dt;
      if (speed > maxSpeed) maxSpeed = speed;
    }
  }

  const durationS = points.length > 1 ? (points[points.length - 1].t - points[0].t) / 1000 : 0;
  return {
    distanceM: round(distance, 1),
    durationS: Math.round(durationS),
    movingTimeS: Math.round(moving),
    elevationGainM: round(gain, 1),
    avgSpeedMps: moving > 0 ? round(distance / moving, 3) : 0,
    maxSpeedMps: round(maxSpeed, 3),
  };
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
