// Shared setup for integration tests: a fresh schema in a separate test database.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/nexmap_test';
process.env.RATE_LIMIT_AUTH_MAX ??= '10000';
process.env.RATE_LIMIT_DEFAULT_MAX ??= '100000';

const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/app.js');
const { default: request } = await import('supertest');

export { pool, request };

export async function resetDatabase() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ log: () => {} });
}

export const app = createApp();

let counter = 0;
export async function signUp(overrides = {}) {
  counter += 1;
  const username = overrides.username ?? `user${counter}_${Date.now() % 100000}`;
  const res = await request(app)
    .post('/v1/auth/register')
    .send({ name: `User ${counter}`, username, email: `${username}@example.com`, password: 'password123', ...overrides });
  if (res.status !== 201) throw new Error(`signUp failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.token, user: res.body.user, auth: { Authorization: `Bearer ${res.body.token}` } };
}

export async function makeFriends(a, b) {
  const sent = await request(app).post('/v1/friends/requests').set(a.auth).send({ userId: b.user.id });
  await request(app).post(`/v1/friends/requests/${sent.body.id}/accept`).set(b.auth).send();
}

// A straight track heading north at a steady pace: `count` points, `stepM` meters and `stepS` seconds apart.
export function straightTrack({ count = 11, stepM = 100, stepS = 30, start = Date.now() - 3_600_000, ele } = {}) {
  const dLat = stepM / 111_195; // meters per degree of latitude on a sphere of radius 6,371,008.8 m
  return Array.from({ length: count }, (_, i) => ({
    lat: 41.3 + i * dLat,
    lng: 69.24,
    t: start + i * stepS * 1000,
    ...(ele ? { ele: ele(i) } : {}),
  }));
}
