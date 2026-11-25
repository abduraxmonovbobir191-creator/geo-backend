import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXID_ISSUER = 'https://id.test';
process.env.NEXID_CLIENT_ID = 'nexmap';
process.env.NEXID_CLIENT_SECRET = 'secret';
process.env.SERVICE_KEYS = 'nexly:nexly-key,nexgramm:gram-key';
process.env.LEGACY_PASSWORD_LOGIN = '0';
const { app, pool, request, resetDatabase } = await import('./helpers.js');
const { transport } = await import('../src/lib/nexid.js');

const users = {
  a: { sub: 'sub-a', name: 'Ali', telegram_username: 'ali_runner', telegram_id: 11, verification_level: 2 },
  b: { sub: 'sub-b', name: 'Vali', telegram_username: 'vali', verification_level: 0 },
};
let plan = { found: true, plan: 'premium', perks: ['nexmap.api_keys'] };

transport.call = async (url, init) => {
  if (url.endsWith('/oauth/token')) {
    const code = new URLSearchParams(init.body).get('code');
    return code === 'bad' ? { status: 400, data: {} } : { status: 200, data: { access_token: `at-${code}`, refresh_token: `rt-${code}` } };
  }
  if (url.endsWith('/oauth/userinfo')) return { status: 200, data: users[init.headers.authorization.slice(-1)] };
  if (url.endsWith('/api/partner/plan')) return { status: 200, data: plan };
  if (url.endsWith('/oauth/revoke')) return { status: 200, data: {} };
  return { status: 404, data: {} };
};

const verifier = 'v'.repeat(50);
const login = (code) =>
  request(app).post('/v1/auth/nexid').send({ code, codeVerifier: verifier, redirectUri: 'nexmap://auth' });

describe('Nex ID', () => {
  before(resetDatabase);
  beforeEach(() => { plan = { found: true, plan: 'premium', perks: ['nexmap.api_keys'] }; });
  after(() => pool.end());

  it('signs in, creates the account once and reads the plan', async () => {
    const res = await login('a');
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'ali_runner');
    assert.equal(res.body.user.plan, 'premium');
    assert.equal(res.body.user.nexid.verificationLevel, 2);
    assert.match(res.body.logoutUrl, /oauth\/logout/);
    const again = await login('a');
    assert.equal(again.body.user.id, res.body.user.id);
  });

  it('refuses a bad code and a foreign redirect', async () => {
    assert.equal((await login('bad')).status, 401);
    const res = await request(app).post('/v1/auth/nexid').send({ code: 'a', codeVerifier: verifier, redirectUri: 'https://evil.test' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'nexid_invalid_redirect');
  });

  it('closes the password login', async () => {
    const res = await request(app).post('/v1/auth/login').send({ login: 'x', password: 'y' });
    assert.equal(res.status, 410);
  });

  it('keeps the cached plan when Nex ID is down', async () => {
    const { token } = (await login('a')).body;
    const old = transport.call;
    transport.call = async () => { throw new Error('down'); };
    await pool.query("UPDATE users SET plan_checked_at = NOW() - INTERVAL '1 day'");
    const me = await request(app).get('/v1/me').set('Authorization', `Bearer ${token}`);
    transport.call = old;
    assert.equal(me.body.plan, 'premium');
  });

  it('serves other Nex products only with a service key', async () => {
    const a = (await login('a')).body;
    const b = (await login('b')).body;
    assert.equal((await request(app).get('/internal/v1/users/me/profile').set('X-Nexid-Sub', 'sub-a')).status, 401);
    assert.equal((await request(app).get('/internal/v1/users/me/profile').set({ 'X-Service-Key': 'nope', 'X-Nexid-Sub': 'sub-a' })).status, 401);
    // A user token is never a service key.
    assert.equal((await request(app).get('/internal/v1/users/me/profile').set({ 'X-Service-Key': a.token, 'X-Nexid-Sub': 'sub-a' })).status, 401);
    const svc = { 'X-Service-Key': 'nexly-key', 'X-Nexid-Sub': 'sub-a' };
    const profile = await request(app).get('/internal/v1/users/me/profile').set(svc);
    assert.equal(profile.status, 200);
    assert.equal(profile.body.user.username, 'ali_runner');

    const resolved = await request(app).post('/internal/v1/users/resolve').set(svc).send({ subs: ['sub-b', 'nobody'] });
    assert.deepEqual(resolved.body.users.map((u) => u.sub), ['sub-b']);

    const sync = await request(app).post('/internal/v1/friends/sync').set(svc).send({ with: ['sub-b', 'nobody'] });
    assert.equal(sync.body.added, 1);
    assert.equal((await request(app).post('/internal/v1/friends/sync').set(svc).send({ with: ['sub-b'] })).body.added, 0);
    const friends = await request(app).get('/v1/friends').set('Authorization', `Bearer ${b.token}`);
    assert.equal(friends.body.friends.length, 1);
  });

  it('shares only public activities', async () => {
    const a = (await login('a')).body;
    const auth = { Authorization: `Bearer ${a.token}` };
    const { straightTrack } = await import('./helpers.js');
    const make = (visibility) =>
      request(app).post('/v1/activities').set(auth).send({ type: 'run', title: visibility, visibility, points: straightTrack() });
    const pub = await make('public');
    const priv = await make('private');
    assert.equal(pub.status, 201, JSON.stringify(pub.body));
    const svc = { 'X-Service-Key': 'nexgramm-nope' };
    assert.equal((await request(app).get(`/internal/v1/activities/${pub.body.id}/card`).set(svc)).status, 401);
    const key = { 'X-Service-Key': 'gram-key', 'X-Nexid-Sub': 'sub-a' };
    assert.equal((await request(app).get(`/internal/v1/activities/${pub.body.id}/card`).set(key)).body.title, 'public');
    assert.equal((await request(app).get(`/internal/v1/activities/${priv.body.id}/card`).set(key)).status, 404);
    const list = await request(app).get('/internal/v1/users/me/activities').set(key);
    assert.deepEqual(list.body.activities.map((x) => x.title), ['public']);
  });

  it('gives more API keys with the perk', async () => {
    const { token } = (await login('a')).body;
    const auth = { Authorization: `Bearer ${token}` };
    for (let i = 0; i < 11; i += 1) {
      const r = await request(app).post('/v1/api-keys').set(auth).send({ name: `k${i}` });
      assert.equal(r.status, 201, `key ${i}`);
    }
  });
});
