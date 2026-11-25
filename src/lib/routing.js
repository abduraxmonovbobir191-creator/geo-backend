// Routing on our own Valhalla server (planet tiles built by deploy/planet/build-world.sh). No external routing API.
import { config } from '../config.js';
import { HttpError } from './http.js';

export const transport = {
  async call(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  },
};

const COSTING = { drive: 'auto', walk: 'pedestrian', bike: 'bicycle', transit: 'bus' };

// Valhalla encodes shapes as polyline with 6 decimals.
export function decodePolyline6(str) {
  const points = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += next();
    lng += next();
    points.push([lat / 1e6, lng / 1e6]);
  }
  return points;
}

// Keeps the line light for phones: about `max` points, always the first and the last.
export function thin(points, max = 1500) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, k) => points[Math.round(k * step)]);
}

export async function route({ from, to, via = [], mode = 'drive', lang = 'en' }) {
  if (!config.routingUrl) throw new HttpError(503, 'routing_unavailable', 'Routing is not set up on this server');
  const locations = [from, ...via, to].map((p, i, all) => ({ lat: p.lat, lon: p.lng, type: i === 0 || i === all.length - 1 ? 'break' : 'through' }));
  let res;
  try {
    res = await transport.call(`${config.routingUrl}/route`, {
      locations, costing: COSTING[mode], directions_options: { units: 'kilometers', language: lang },
    });
  } catch {
    throw new HttpError(503, 'routing_unavailable', 'Routing is not reachable');
  }
  if (res.status === 400 || res.data?.error_code === 442) throw new HttpError(404, 'no_route', 'No route between these points');
  if (res.status >= 400 || !res.data?.trip) throw new HttpError(503, 'routing_unavailable', 'Routing is not reachable');
  const trip = res.data.trip;
  const geometry = trip.legs.flatMap((leg, k) => {
    const pts = decodePolyline6(leg.shape);
    return k ? pts.slice(1) : pts;
  });
  return {
    distanceM: Math.round(trip.summary.length * 1000),
    durationS: Math.round(trip.summary.time),
    geometry: thin(geometry),
    steps: trip.legs.flatMap((leg) => leg.maneuvers.map((m) => ({ text: m.instruction, distanceM: Math.round(m.length * 1000), durationS: Math.round(m.time), type: m.type }))),
  };
}

// Meters from a point to the nearest part of a line (a local flat approximation, exact enough for a few hundred meters).
export function distanceToLineM(lat, lng, line) {
  const kLat = 111_195;
  const kLng = 111_195 * Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i][1] - lng) * kLng;
    const ay = (line[i][0] - lat) * kLat;
    const bx = (line[i + 1][1] - lng) * kLng;
    const by = (line[i + 1][0] - lat) * kLat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return line.length === 1 ? Math.hypot((line[0][1] - lng) * kLng, (line[0][0] - lat) * kLat) : best;
}
