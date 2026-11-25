import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.ROUTING_URL = 'http://valhalla.test';
process.env.NEXID_ISSUER = 'https://id.test';
process.env.NEXID_CLIENT_ID = 'nexmap';
process.env.NEXID_CLIENT_SECRET = 'secret';
const { app, pool, request, resetDatabase, signUp } = await import('./helpers.js');
const { transport, decodePolyline6, distanceToLineM, thin } = await import('../src/lib/routing.js');
const nexid = await import('../src/lib/nexid.js');

// Encode with the same algorithm to build a fixture: a line going north through Tashkent.
function encode(points) {
  let out = '';
  let pl = 0;
  let pg = 0;
  const put = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    out += String.fromCharCode(v + 63);
  };
  for (const [lat, lng] of points) {
    const la = Math.round(lat * 1e6);
    const ln = Math.round(lng * 1e6);
    put(la - pl); put(ln - pg); pl = la; pg = ln;
  }
  return out;
}
const line = Array.from({ length: 11 }, (_, i) => [41.30 + i * 0.002, 69.28]);

describe('routing', () => {
  before(resetDatabase);
  after(() => pool.end());

  it('decodes Valhalla shapes and measures the distance to a line', () => {
    const back = decodePolyline6(encode(line));
    assert.equal(back.length, line.length);
    assert.ok(Math.abs(back[5][0] - line[5][0]) < 1e-6);
    assert.ok(distanceToLineM(41.31, 69.2829, line) < 260 && distanceToLineM(41.31, 69.2829, line) > 220); // ~250 m east of the line
    assert.equal(thin(Array.from({ length: 5000 }, (_, i) => [i, i]), 100).length, 100);
  });

  it('answers a route from our own server and offers bought Top places along it as ads', async () => {
    const calls = [];
    transport.call = async (url, body) => {
      calls.push([url, body]);
      return { status: 200, data: { trip: { summary: { length: 2.2, time: 300 }, legs: [{ shape: encode(line), maneuvers: [{ instruction: 'Go north', length: 2.2, time: 300, type: 1 }] }] } } };
    };
    const owner = await signUp();
    const user = await signUp();
    const near = (await request(app).post('/v1/places').set(owner.auth).send({ name: 'On the way', category: 'cafe', lat: 41.31, lng: 69.2815 })).body; // ~110 m off
    const far = (await request(app).post('/v1/places').set(owner.auth).send({ name: 'Far', category: 'cafe', lat: 41.31, lng: 69.30 })).body;
    await pool.query(`UPDATE places SET owner_id = $1 WHERE id = ANY($2)`, [owner.user.id, [near.id, far.id]]);
    for (const [place, tier, cell] of [[near, 1, 'a'], [far, 2, 'a']]) {
      await pool.query(
        `INSERT INTO promotions (place_id, plan_code, kind, tier, category, cell, price, ref, expires_at) VALUES ($1, 'top1_week', 'top', $2, 'cafe', $3, 1, $4, NOW() + INTERVAL '1 day')`,
        [place.id, tier, cell, `r-${place.id}`],
      );
    }
    const res = await request(app).post('/v1/route').set(user.auth)
      .send({ from: { lat: 41.30, lng: 69.28 }, to: { lat: 41.32, lng: 69.28 }, via: [{ lat: 41.31, lng: 69.28 }], mode: 'drive', toPlaceId: near.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.distanceM, 2200);
    assert.equal(res.body.geometry.length, 11);
    assert.deepEqual(res.body.suggestions.map((s) => s.name), ['On the way']);
    assert.equal(res.body.suggestions[0].ad, true);
    assert.ok(res.body.suggestions[0].offRouteM < 200);
    const [url, body] = calls[0];
    assert.equal(url, 'http://valhalla.test/route');
    assert.equal(body.costing, 'auto');
    assert.equal(body.locations.length, 3);
    assert.equal(body.locations[1].type, 'through');
    // no offers while walking, and none when the caller does not want them
    const walk = await request(app).post('/v1/route').set(user.auth).send({ from: { lat: 41.30, lng: 69.28 }, to: { lat: 41.32, lng: 69.28 }, mode: 'walk' });
    assert.deepEqual(walk.body.suggestions, []);
  });

  it('answers no_route and routing_unavailable', async () => {
    const user = await signUp();
    transport.call = async () => ({ status: 400, data: { error_code: 442 } });
    const none = await request(app).post('/v1/route').set(user.auth).send({ from: { lat: 41.3, lng: 69.2 }, to: { lat: 0, lng: 0 } });
    assert.equal(none.status, 404);
    assert.equal(none.body.error.code, 'no_route');
    transport.call = async () => { throw new Error('down'); };
    const down = await request(app).post('/v1/route').set(user.auth).send({ from: { lat: 41.3, lng: 69.2 }, to: { lat: 41.4, lng: 69.3 } });
    assert.equal(down.status, 503);
    assert.equal(down.body.error.code, 'routing_unavailable');
  });
});
