import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError, parse, route } from '../lib/http.js';

// Address search and reverse geocoding, proxied to a Nominatim-compatible server
// (OpenStreetMap by default, set GEOCODER_URL to use your own). Proxying keeps the
// upstream's usage rules (User-Agent, rate limits) in one place instead of every client.
const router = Router();

const searchSchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(20).default(10),
  // Optional point to prefer results near (e.g. the map center).
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  lang: z.string().max(20).optional(),
});

const reverseSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  lang: z.string().max(20).optional(),
});

async function callGeocoder(path, params, lang) {
  const url = new URL(path, config.geocoderUrl);
  for (const [k, v] of Object.entries({ format: 'jsonv2', addressdetails: '1', ...params })) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  let response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': config.geocoderUserAgent, 'Accept-Language': lang || 'uz,en' },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new HttpError(502, 'geocoder_unavailable', 'Address search is temporarily unavailable');
  }
  if (!response.ok) {
    throw new HttpError(502, 'geocoder_unavailable', 'Address search is temporarily unavailable');
  }
  return response.json();
}

function serializeResult(r) {
  return {
    name: r.name || r.display_name?.split(',')[0] || '',
    displayName: r.display_name,
    lat: Number(r.lat),
    lng: Number(r.lon),
    category: r.category ?? r.class ?? null,
    type: r.type ?? null,
  };
}

router.get(
  '/search',
  route(async (req, res) => {
    const q = parse(searchSchema, req.query);
    const params = { q: q.q, limit: q.limit };
    if (q.lat !== undefined && q.lng !== undefined) {
      // A ~50 km box around the point; results inside rank higher but others still show.
      params.viewbox = [q.lng - 0.5, q.lat + 0.5, q.lng + 0.5, q.lat - 0.5].join(',');
    }
    const results = await callGeocoder('/search', params, q.lang);
    res.json({ results: Array.isArray(results) ? results.map(serializeResult) : [] });
  }),
);

router.get(
  '/reverse',
  route(async (req, res) => {
    const q = parse(reverseSchema, req.query);
    const result = await callGeocoder('/reverse', { lat: q.lat, lon: q.lng }, q.lang);
    res.json({ result: result && !result.error ? serializeResult(result) : null });
  }),
);

export default router;
