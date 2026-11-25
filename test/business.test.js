import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXID_ISSUER = 'https://id.test';
process.env.NEXID_CLIENT_ID = 'nexmap';
process.env.NEXID_CLIENT_SECRET = 'secret';
const { app, pool, request, resetDatabase } = await import('./helpers.js');
const { transport } = await import('../src/lib/nexid.js');
const { endExpiredPromotions } = await import('../src/routes/business.js');

let coins = 10_000;
const charged = new Map();
const levels = { 'sub-biz': 2, 'sub-biz2': 2, 'sub-newbie': 0, 'sub-fan': 1 };
transport.call = async (url, init) => {
  if (url.endsWith('/oauth/token')) return { status: 200, data: { access_token: `at-${JSON.parse(JSON.stringify({ c: new URLSearchParams(init.body).get('code') })).c}`, refresh_token: 'rt' } };
  if (url.endsWith('/oauth/userinfo')) {
    const sub = init.headers.authorization.slice('Bearer at-'.length);
    return { status: 200, data: { sub, name: sub, telegram_username: sub.replace('-', '_'), verification_level: levels[sub] } };
  }
  if (url.endsWith('/api/partner/plan')) return { status: 200, data: { found: true, plan: 'free', perks: [] } };
  const body = JSON.parse(init.body || '{}');
  if (url.endsWith('/wallet/charge')) {
    if (charged.has(body.ref)) return { status: 200, data: {} };
    if (body.amount > coins) return { status: 402, data: { error: 'insufficient_funds' } };
    coins -= body.amount; charged.set(body.ref, body.amount);
    return { status: 200, data: {} };
  }
  if (url.endsWith('/wallet/refund')) { coins += charged.get(body.ref) ?? 0; charged.delete(body.ref); return { status: 200, data: {} }; }
  if (url.endsWith('/wallet/balance')) return { status: 200, data: { balance: coins } };
  return { status: 404, data: {} };
};

const signIn = async (sub) => {
  const res = await request(app).post('/v1/auth/nexid').send({ code: sub, codeVerifier: 'v'.repeat(50), redirectUri: 'nexmap://auth' });
  return { auth: { Authorization: `Bearer ${res.body.token}` }, user: res.body.user };
};
const near = '/v1/places/nearby?lat=41.311&lng=69.279&radius=3000';

describe('business places', () => {
  let biz, biz2, newbie, fan, p1, p2, p3;
  before(async () => {
    await resetDatabase();
    [biz, biz2, newbie, fan] = [await signIn('sub-biz'), await signIn('sub-biz2'), await signIn('sub-newbie'), await signIn('sub-fan')];
    const mk = async (name, lat, category = 'restaurant') =>
      (await request(app).post('/v1/places').set(fan.auth).send({ name, category, lat, lng: 69.279 })).body;
    p1 = await mk('Plov Center', 41.3115);
    p2 = await mk('Osh Markazi', 41.3125);
    p3 = await mk('Cheap Eats', 41.3105);
  });
  after(() => pool.end());

  it('needs a Nex ID identity check to claim, and only one owner', async () => {
    assert.equal((await request(app).post(`/v1/business/places/${p1.id}/claim`).set(newbie.auth)).body.error.code, 'verification_required');
    assert.equal((await request(app).post(`/v1/business/places/${p1.id}/claim`).set(biz.auth)).status, 200);
    assert.equal((await request(app).post(`/v1/business/places/${p1.id}/claim`).set(biz2.auth)).body.error.code, 'already_claimed');
    assert.equal((await request(app).post(`/v1/business/places/${p2.id}/claim`).set(biz2.auth)).status, 200);
  });

  it('fills the business card with opening hours', async () => {
    const all = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]]));
    const res = await request(app).patch(`/v1/business/places/${p1.id}`).set(biz.auth)
      .send({ phone: '+998 71 123 45 67', website: 'https://plov.example', hours: all, priceLevel: 2, description: 'Best plov' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const card = (await request(app).get(`/v1/places/${p1.id}`).set(fan.auth)).body;
    assert.equal(card.open, true);
    assert.equal(card.verifiedBusiness, true);
    assert.equal((await request(app).patch(`/v1/business/places/${p1.id}`).set(biz2.auth).send({ phone: '+998 1 2 3 4 5' })).status, 403);
    assert.equal((await request(app).patch(`/v1/business/places/${p1.id}`).set(biz.auth).send({ website: 'http://insecure.example' })).status, 400);
  });

  it('puts a bought Top place first, labelled as an ad, once per position', async () => {
    assert.ok((await request(app).get(near).set(fan.auth)).body.places.every((p) => !p.ad)); // nothing is an ad before anyone pays
    const buy = await request(app).post(`/v1/business/places/${p1.id}/promotions`).set(biz.auth).send({ plan: 'top1_week', price: 700, key: 'key-top1-01' });
    assert.equal(buy.status, 201, JSON.stringify(buy.body));
    const list = (await request(app).get(near).set(fan.auth)).body.places;
    assert.equal(list[0].name, 'Plov Center');
    assert.equal(list[0].ad, true);
    assert.equal(list[0].topTier, 1);
    assert.ok(list.slice(1).every((p) => !p.ad));
    // The same position in the same area is taken; the money is not kept.
    const before2 = coins;
    const clash = await request(app).post(`/v1/business/places/${p2.id}/promotions`).set(biz2.auth).send({ plan: 'top1_week' });
    assert.equal(clash.body.error.code, 'slot_taken');
    assert.equal(coins, before2);
    assert.equal((await request(app).post(`/v1/business/places/${p2.id}/promotions`).set(biz2.auth).send({ plan: 'top2_week', price: 450 })).status, 201);
    const order = (await request(app).get(near).set(fan.auth)).body.places.slice(0, 2).map((p) => p.name);
    assert.deepEqual(order, ['Plov Center', 'Osh Markazi']);
  });

  it('charges once on a retry and answers price_changed and insufficient funds', async () => {
    const before = coins;
    const again = await request(app).post(`/v1/business/places/${p1.id}/promotions`).set(biz.auth).send({ plan: 'top1_week', key: 'key-top1-01' });
    assert.equal(again.status, 201);
    assert.equal(coins, before);
    assert.equal((await request(app).post(`/v1/business/places/${p2.id}/promotions`).set(biz2.auth).send({ plan: 'top3_week', price: 1 })).body.error.code, 'price_changed');
    await request(app).post(`/v1/business/places/${p3.id}/claim`).set(biz.auth);
    coins = 5;
    const poor = await request(app).post(`/v1/business/places/${p3.id}/promotions`).set(biz.auth).send({ plan: 'top3_week' });
    coins = 10_000;
    assert.equal(poor.status, 402);
  });

  it('shows a branded pin only while it runs and needs a logo first', async () => {
    assert.equal((await request(app).post(`/v1/business/places/${p1.id}/promotions`).set(biz.auth).send({ plan: 'pin_month' })).body.error.code, 'pin_missing');
    await request(app).patch(`/v1/business/places/${p1.id}`).set(biz.auth).send({ pinLogoUrl: 'https://plov.example/logo.png' });
    assert.equal((await request(app).get(`/v1/places/${p1.id}`).set(fan.auth)).body.brandedPin, undefined);
    assert.equal((await request(app).post(`/v1/business/places/${p1.id}/promotions`).set(biz.auth).send({ plan: 'pin_month', key: 'key-pin-001' })).status, 201);
    assert.equal((await request(app).get(`/v1/places/${p1.id}`).set(fan.auth)).body.brandedPin.logoUrl, 'https://plov.example/logo.png');
  });

  it('frees the position when the days are over', async () => {
    await pool.query("UPDATE promotions SET expires_at = NOW() - INTERVAL '1 minute' WHERE kind = 'top' AND tier = 1");
    await endExpiredPromotions();
    const list = (await request(app).get(near).set(fan.auth)).body.places;
    assert.ok(list.every((p) => p.topTier !== 1));
    assert.equal((await request(app).post(`/v1/business/places/${p2.id}/promotions`).set(biz2.auth).send({ plan: 'top1_week', key: 'key-top1-02' })).status, 409); // p2 already holds Top 2
  });

  it('keeps reviews independent of money and bars the owner', async () => {
    assert.equal((await request(app).put(`/v1/places/${p1.id}/reviews`).set(fan.auth).send({ rating: 2, body: 'meh' })).status, 204);
    assert.equal((await request(app).put(`/v1/places/${p1.id}/reviews`).set(biz.auth).send({ rating: 5 })).status, 403);
    const card = (await request(app).get(`/v1/places/${p1.id}`).set(fan.auth)).body;
    assert.equal(card.rating, 2);
    assert.equal(card.reviewCount, 1);
  });

  it('sells statistics as an add-on and counts without storing who looked', async () => {
    await request(app).post('/v1/places/' + p1.id + '/events').set(fan.auth).send({ kind: 'pin_click' });
    const locked = await request(app).get(`/v1/business/places/${p1.id}/stats`).set(biz.auth);
    assert.equal(locked.status, 402);
    assert.equal((await request(app).post('/v1/shop/buy').set(biz.auth).send({ sku: 'biz_stats', key: 'key-stats-001' })).status, 201);
    const stats = await request(app).get(`/v1/business/places/${p1.id}/stats`).set(biz.auth);
    assert.equal(stats.status, 200);
    assert.ok(stats.body.totals.impression >= 1);
    assert.equal(stats.body.totals.pin_click, 1);
    assert.equal((await request(app).get(`/v1/business/places/${p1.id}/stats`).set(biz2.auth)).status, 403);
  });
});
