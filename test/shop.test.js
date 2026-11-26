import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXID_ISSUER = 'https://id.test';
process.env.NEXID_CLIENT_ID = 'nexmap';
process.env.NEXID_CLIENT_SECRET = 'secret';
process.env.SERVICE_KEYS = 'nexly:nexly-key';
const { app, pool, request, resetDatabase } = await import('./helpers.js');
const { transport } = await import('../src/lib/nexid.js');
const { endExpired, endingSoon } = await import('../src/lib/shop.js');

let coins = 1000;
const charged = new Map(); // ref -> amount (Nex ID dedupes by ref)
const refunded = [];
transport.call = async (url, init) => {
  if (url.endsWith('/oauth/token')) return { status: 200, data: { access_token: 'at-a', refresh_token: 'rt' } };
  if (url.endsWith('/oauth/userinfo')) return { status: 200, data: { sub: 'sub-a', name: 'Ali', telegram_username: 'ali' } };
  if (url.endsWith('/api/partner/plan')) return { status: 200, data: { found: true, plan: 'free', perks: [] } };
  const body = JSON.parse(init.body || '{}');
  if (url.endsWith('/wallet/balance')) return { status: 200, data: { balance: coins } };
  if (url.endsWith('/wallet/charge')) {
    if (charged.has(body.ref)) return { status: 200, data: { ok: true } };
    if (body.amount > coins) return { status: 402, data: { error: 'insufficient_funds' } };
    coins -= body.amount;
    charged.set(body.ref, body.amount);
    return { status: 200, data: { ok: true } };
  }
  if (url.endsWith('/wallet/refund')) { refunded.push(body.ref); coins += charged.get(body.ref) ?? 0; return { status: 200, data: {} }; }
  return { status: 404, data: {} };
};

describe('Nex Map shop', () => {
  let auth;
  before(async () => {
    await resetDatabase();
    const res = await request(app).post('/v1/auth/nexid').send({ code: 'a', codeVerifier: 'v'.repeat(50), redirectUri: 'nexmap://auth' });
    auth = { Authorization: `Bearer ${res.body.token}` };
  });
  after(() => pool.end());

  it('lists the catalog with the Nex ID balance and wallet link', async () => {
    const res = await request(app).get('/v1/shop').set(auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.balance, 1000);
    assert.match(res.body.walletUrl, /account\/wallet/);
    assert.ok(res.body.items.find((i) => i.sku === 'plus' && i.kind === 'subscription'));
  });

  it('buys in one tap, pays once on a retry and unlocks only Nex Map entitlements', async () => {
    const body = { sku: 'pins', price: 80, key: 'tap-0001-abc' };
    const first = await request(app).post('/v1/shop/buy').set(auth).send(body);
    assert.equal(first.status, 201);
    assert.equal(first.body.balance, 920);
    const retry = await request(app).post('/v1/shop/buy').set(auth).send(body);
    assert.equal(retry.status, 201);
    assert.equal(coins, 920);
    const me = await request(app).get('/v1/me').set(auth);
    assert.ok(me.body.entitlements.includes('nexmap.pins'));
    assert.deepEqual(me.body.perks, []); // not a Nex ID perk
    assert.equal((await request(app).post('/v1/shop/buy').set(auth).send({ sku: 'pins' })).body.error.code, 'already_owned');
  });

  it('answers price_changed and insufficient_funds', async () => {
    const changed = await request(app).post('/v1/shop/buy').set(auth).send({ sku: 'themes', price: 1 });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, 'price_changed');
    coins = 10;
    const poor = await request(app).post('/v1/shop/buy').set(auth).send({ sku: 'themes', price: 120 });
    assert.equal(poor.status, 402);
    assert.match(poor.body.error.details.walletUrl, /wallet/);
    coins = 1000;
  });

  it('does not let an API key spend coins', async () => {
    const key = await request(app).post('/v1/api-keys').set(auth).send({ name: 'bot', scopes: ['read', 'write'] });
    const res = await request(app).post('/v1/shop/buy').set('X-API-Key', key.body.key).send({ sku: 'export' });
    assert.equal(res.status, 403);
  });

  it('sells a 30-day pass: one tap extends it, a retry adds the days once, an expired pass ends and can be bought again', async () => {
    const days = (p) => Math.round((new Date(p).getTime() - Date.now()) / 86_400_000);
    const first = await request(app).post('/v1/shop/buy').set(auth).send({ sku: 'plus', price: 300, key: 'plus-key-001' });
    assert.equal(first.status, 201);
    assert.ok((await request(app).get('/v1/me').set(auth)).body.entitlements.includes('nexmap.plus'));
    assert.equal(days(first.body.purchase.renewsAt), 30);
    // extend while it runs: the days add up (30 + 30)
    const before = coins;
    const second = await request(app).post('/v1/shop/buy').set(auth).send({ sku: 'plus', key: 'plus-key-002' });
    assert.equal(second.status, 201);
    assert.equal(days(second.body.purchase.renewsAt), 60);
    assert.equal(coins, before - 300);
    // the same tap again (a retry): charged once, days added once
    const retry = await request(app).post('/v1/shop/buy').set(auth).send({ sku: 'plus', key: 'plus-key-002' });
    assert.equal(retry.status, 201);
    assert.equal(coins, before - 300);
    assert.equal(days((await pool.query("SELECT renews_at FROM purchases WHERE sku = 'plus'")).rows[0].renews_at), 60);
    // nothing renews by itself: when the days are over it ends
    await pool.query("UPDATE purchases SET renews_at = NOW() + INTERVAL '2 days' WHERE sku = 'plus'");
    assert.equal((await endingSoon(first.body.purchase.userId ?? (await pool.query('SELECT id FROM users LIMIT 1')).rows[0].id)).length, 1);
    await pool.query("UPDATE purchases SET renews_at = NOW() - INTERVAL '1 minute' WHERE sku = 'plus'");
    const kept = coins;
    assert.equal(await endExpired(), 1);
    assert.equal(coins, kept); // no automatic charge
    assert.ok(!(await request(app).get('/v1/me').set(auth)).body.entitlements.includes('nexmap.plus'));
    // a new pass after it ended
    assert.equal((await request(app).post('/v1/shop/buy').set(auth).send({ sku: 'plus', key: 'plus-key-003' })).status, 201);
    assert.ok((await request(app).get('/v1/me').set(auth)).body.entitlements.includes('nexmap.plus'));
  });

  it('lets Nexly sell it with the service key and records where it was bought', async () => {
    coins = 1000;
    const svc = { 'X-Service-Key': 'nexly-key', 'X-Nexid-Sub': 'sub-a' };
    assert.equal((await request(app).get('/internal/v1/shop').set({ 'X-Nexid-Sub': 'sub-a' })).status, 401);
    const res = await request(app).post('/internal/v1/shop/buy').set(svc).send({ sku: 'export', price: 150, key: 'nexly-tap-01' });
    assert.equal(res.status, 201);
    const row = await pool.query("SELECT source FROM purchases WHERE sku = 'export'");
    assert.equal(row.rows[0].source, 'nexly');
  });
});
