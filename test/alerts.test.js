import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXID_ISSUER = 'https://id.test';
process.env.NEXID_CLIENT_ID = 'nexmap';
process.env.NEXID_CLIENT_SECRET = 'secret';
process.env.ALERT_DISABLED_KINDS = 'camera';
const { app, makeFriends, pool, request, resetDatabase, signUp } = await import('./helpers.js');
const { transport } = await import('../src/lib/nexid.js');

let coins = 100;
const charged = new Map();
transport.call = async (url, init) => {
  const body = JSON.parse(init?.body || '{}');
  if (url.endsWith('/wallet/charge')) {
    if (charged.has(body.ref)) return { status: 200, data: {} };
    if (body.amount > coins) return { status: 402, data: { error: 'insufficient_funds' } };
    coins -= body.amount; charged.set(body.ref, body.amount);
    return { status: 200, data: {} };
  }
  if (url.endsWith('/wallet/refund')) { coins += charged.get(body.ref) ?? 0; charged.delete(body.ref); return { status: 200, data: {} }; }
  return { status: 404, data: {} };
};

const near = '/v1/alerts/nearby?lat=41.311&lng=69.279&radius=2000';

describe('live alerts and points', () => {
  let a, b, c, d;
  before(async () => { await resetDatabase(); [a, b, c, d] = [await signUp(), await signUp(), await signUp(), await signUp()]; });

  it('marks an alert, merges a second report of the same thing and rewards honest reporting', async () => {
    const r = await request(app).post('/v1/alerts').set(a.auth).send({ kind: 'traffic', lat: 41.311, lng: 69.279, note: 'slow' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const again = await request(app).post('/v1/alerts').set(b.auth).send({ kind: 'traffic', lat: 41.3112, lng: 69.2792 });
    assert.equal(again.status, 200);
    assert.equal(again.body.merged, true);
    assert.equal(again.body.id, r.body.id);
    const list = (await request(app).get(near).set(c.auth)).body.alerts;
    assert.equal(list.length, 1);
    assert.equal(list[0].ups, 1);
    assert.equal((await request(app).get('/v1/me').set(a.auth)).body.points, 10);
    assert.equal((await request(app).get('/v1/me').set(b.auth)).body.points, 2);
  });

  it('confirms once, not your own, and removes an alert after three "gone" votes', async () => {
    const id = (await request(app).get(near).set(c.auth)).body.alerts[0].id;
    assert.equal((await request(app).post(`/v1/alerts/${id}/confirm`).set(a.auth).send({ still: true })).body.error.code, 'own_alert');
    assert.equal((await request(app).post(`/v1/alerts/${id}/confirm`).set(c.auth).send({ still: true })).status, 200);
    assert.equal((await request(app).post(`/v1/alerts/${id}/confirm`).set(c.auth).send({ still: false })).body.error.code, 'already_voted');
    const lone = (await request(app).post('/v1/alerts').set(d.auth).send({ kind: 'queue', lat: 41.32, lng: 69.29 })).body.id;
    for (const u of [a, b, c]) assert.equal((await request(app).post(`/v1/alerts/${lone}/confirm`).set(u.auth).send({ still: false })).status, 200);
    const left = (await request(app).get('/v1/alerts/nearby?lat=41.32&lng=69.29&radius=300').set(a.auth)).body.alerts;
    assert.equal(left.length, 0);
    assert.ok((await request(app).get('/v1/me').set(d.auth)).body.points < 10); // wrong reports lose points
  });

  it('switches a kind off where the law says so, and shows levels', async () => {
    const r = await request(app).post('/v1/alerts').set(a.auth).send({ kind: 'camera', lat: 41.3, lng: 69.2 });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'alert_kind_disabled');
    assert.equal((await request(app).get('/v1/me').set(a.auth)).body.level, 'rookie');
    await pool.query('UPDATE users SET points = 260 WHERE id = $1', [a.user.id]);
    assert.equal((await request(app).get('/v1/me').set(a.auth)).body.level, 'driver');
  });
});

describe('coupons, footprints, bump and stickers', () => {
  let owner, fan, other, pf;
  before(async () => {
    await resetDatabase();
    [owner, fan, other] = [await signUp(), await signUp(), await signUp()];
    pf = (await request(app).post('/v1/places').set(owner.auth).send({ name: 'Plov', category: 'restaurant', lat: 41.3, lng: 69.2 })).body;
    await pool.query('UPDATE places SET owner_id = $1 WHERE id = $2', [owner.user.id, pf.id]);
    await pool.query("UPDATE users SET nexid_sub = 'sub-owner' WHERE id = $1", [owner.user.id]);
  });

  it('an offer, a coupon once per person, the quota, and the lead fee charged once at the till', async () => {
    assert.equal((await request(app).post('/v1/business/offers').set(fan.auth).send({ placeId: pf.id, title: 'x' })).status, 403);
    const o = await request(app).post('/v1/business/offers').set(owner.auth).send({ placeId: pf.id, title: '10% off', leadFee: 5, quota: 1 });
    assert.equal(o.status, 201, JSON.stringify(o.body));
    assert.equal((await request(app).get(`/v1/places/${pf.id}/offers`).set(fan.auth)).body.offers.length, 1);
    const c1 = await request(app).post(`/v1/offers/${o.body.id}/claim`).set(fan.auth);
    assert.equal(c1.status, 201);
    assert.equal((await request(app).post(`/v1/offers/${o.body.id}/claim`).set(fan.auth)).body.code, c1.body.code); // the same coupon again
    assert.equal((await request(app).post(`/v1/offers/${o.body.id}/claim`).set(other.auth)).body.error.code, 'offer_full');
    assert.equal((await request(app).get(`/v1/places/${pf.id}/offers`).set(fan.auth)).body.offers.length, 0); // quota used up
    // at the till: only the owner, the fee once
    assert.equal((await request(app).post('/v1/business/redeem').set(fan.auth).send({ code: c1.body.code })).status, 404);
    const before = coins;
    const used = await request(app).post('/v1/business/redeem').set(owner.auth).send({ code: c1.body.code });
    assert.equal(used.status, 200, JSON.stringify(used.body));
    assert.equal(coins, before - 5);
    assert.equal((await request(app).post('/v1/business/redeem').set(owner.auth).send({ code: c1.body.code })).body.error.code, 'coupon_used');
    assert.equal(coins, before - 5);
    assert.equal((await request(app).get('/v1/offers/mine').set(fan.auth)).body.coupons[0].status, 'redeemed');
  });

  it('a venue without Stars cannot redeem and the coupon stays valid', async () => {
    const o = (await request(app).post('/v1/business/offers').set(owner.auth).send({ placeId: pf.id, title: '2 for 1', leadFee: 500 })).body;
    const c = (await request(app).post(`/v1/offers/${o.id}/claim`).set(other.auth)).body;
    const poor = await request(app).post('/v1/business/redeem').set(owner.auth).send({ code: c.code });
    assert.equal(poor.status, 402);
    assert.equal((await request(app).get('/v1/offers/mine').set(other.auth)).body.coupons[0].status, 'active');
  });

  it('footprints are private cells, bump needs both to show the exact place, stickers need a friend', async () => {
    await request(app).put('/v1/me/location').set(fan.auth).send({ lat: 41.3, lng: 69.2 });
    await request(app).put('/v1/me/location').set(fan.auth).send({ lat: 41.35, lng: 69.25 });
    await new Promise((r) => setTimeout(r, 100));
    const fp = (await request(app).get('/v1/me/footprints').set(fan.auth)).body;
    assert.equal(fp.count, 2);
    assert.equal((await request(app).get('/v1/me/footprints').set(owner.auth)).body.count, 0); // nobody else's
    await makeFriends(fan, owner);
    assert.equal((await request(app).post(`/v1/friends/${owner.user.id}/poke`).set(fan.auth).send({ emoji: '🔥', count: 30 })).status, 204);
    assert.equal((await request(app).post(`/v1/friends/${other.user.id}/poke`).set(fan.auth).send({ emoji: '🔥' })).status, 404);
    assert.equal((await request(app).post(`/v1/friends/${owner.user.id}/poke`).set(fan.auth).send({ emoji: '🔥', count: 99 })).status, 400);
    // a bump: both within 50 m and both exact -> one row; blur one side -> none
    await request(app).put('/v1/me/location').set(owner.auth).send({ lat: 41.35, lng: 69.25 });
    await request(app).put('/v1/me/location').set(fan.auth).send({ lat: 41.35001, lng: 69.25001 });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM bumps')).rows[0].n, 1);
    await pool.query('DELETE FROM bumps');
    await request(app).put(`/v1/friends/${fan.user.id}/sharing`).set(owner.auth).send({ mode: 'blurred' });
    await request(app).put('/v1/me/location').set(fan.auth).send({ lat: 41.35002, lng: 69.25002 });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM bumps')).rows[0].n, 0);
  });
});

after(() => pool.end());
