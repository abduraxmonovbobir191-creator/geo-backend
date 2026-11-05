import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Two fake Nominatim servers: "local" knows only Tashkent, "public" knows everything.
function fakeGeocoder(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    calls.push(url.pathname + url.search);
    const body = handler(url);
    if (body === 'down') {
      res.writeHead(503).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, calls, url: `http://localhost:${server.address().port}` })));
}

let localDown = false;
const local = await fakeGeocoder((url) => {
  if (localDown) return 'down';
  if (url.pathname === '/search') {
    return url.searchParams.get('q') === 'Toshkent' ? [{ name: 'Toshkent', display_name: 'Toshkent, Uzbekistan', lat: '41.31', lon: '69.28' }] : [];
  }
  return { error: 'Unable to geocode' };
});
const fallback = await fakeGeocoder((url) =>
  url.pathname === '/search'
    ? [{ name: 'Paris', display_name: 'Paris, France', lat: '48.85', lon: '2.35' }]
    : { name: 'Rue de Rivoli', display_name: 'Rue de Rivoli, Paris', lat: '48.86', lon: '2.34' },
);

process.env.GEOCODER_URL = local.url;
process.env.GEOCODER_FALLBACK_URL = fallback.url;
const { app, pool, request, resetDatabase, signUp } = await import('./helpers.js');

let user;
before(async () => {
  await resetDatabase();
  user = await signUp();
});
after(async () => {
  local.server.close();
  fallback.server.close();
  await pool.end();
});

test('uses the local geocoder when it has results', async () => {
  fallback.calls.length = 0;
  const res = await request(app).get('/v1/geocode/search?q=Toshkent').set(user.auth);
  assert.equal(res.body.results[0].name, 'Toshkent');
  assert.equal(fallback.calls.length, 0);
});

test('falls back when the local geocoder finds nothing', async () => {
  const res = await request(app).get('/v1/geocode/search?q=Paris').set(user.auth);
  assert.equal(res.body.results[0].name, 'Paris');
  const reverse = await request(app).get('/v1/geocode/reverse?lat=48.86&lng=2.34').set(user.auth);
  assert.equal(reverse.body.result.name, 'Rue de Rivoli');
});

test('falls back when the local geocoder is down', async () => {
  localDown = true;
  try {
    const res = await request(app).get('/v1/geocode/search?q=Toshkent').set(user.auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.results[0].name, 'Paris');
  } finally {
    localDown = false;
  }
});
