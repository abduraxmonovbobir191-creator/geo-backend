import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { app, makeFriends, pool, request, resetDatabase, signUp } from './helpers.js';

const at = { lat: 41.311158, lng: 69.279737, battery: 80 };

describe('live status and per-friend privacy', () => {
  let a, b, c;
  before(async () => {
    await resetDatabase();
    [a, b, c] = [await signUp(), await signUp(), await signUp()];
    await makeFriends(a, b);
    await makeFriends(a, c);
    await request(app).put('/v1/me/location').set(a.auth).send({ ...at, activity: 'walking', isCharging: true, stepsToday: 4200 });
  });
  after(() => pool.end());

  const seenBy = async (viewer) => (await request(app).get('/v1/friends').set(viewer.auth)).body.friends.find((f) => f.id === a.user.id);

  it('shows the precise point by default, without sensitive extras', async () => {
    const f = await seenBy(b);
    assert.equal(f.location.lat, at.lat);
    assert.equal(f.location.battery, 80);
    assert.equal(f.location.activity, undefined);
    assert.equal(f.location.stepsToday, undefined);
    assert.equal(f.sharing, 'default');
  });

  it('gives extras only after the owner turns them on', async () => {
    await request(app).put('/v1/me/sharing').set(a.auth).send({ activity: true });
    await request(app).put('/v1/me/location').set(a.auth).send({ ...at, activity: 'walking', isCharging: true, stepsToday: 4200 });
    const f = await seenBy(b);
    assert.equal(f.location.activity, 'walking');
    assert.equal(f.location.isCharging, true);
    assert.equal(typeof f.location.stillForS, 'number');
    assert.equal(f.location.stepsToday, undefined); // steps are a separate switch
  });

  it('blurs for one friend only, on the server', async () => {
    const res = await request(app).put(`/v1/friends/${b.user.id}/sharing`).set(a.auth).send({ mode: 'blurred' });
    assert.equal(res.status, 200);
    const blurred = (await seenBy(b)).location;
    assert.equal(blurred.blurred, true);
    assert.notEqual(blurred.lat, at.lat);
    assert.ok(Math.abs(blurred.lat - at.lat) < 0.01 && Math.abs(blurred.lng - at.lng) < 0.02);
    assert.equal(blurred.speed, undefined);
    assert.equal(blurred.stillForS, undefined); // the still timer could give the exact place away
    assert.equal((await seenBy(c)).location.lat, at.lat); // another friend is unchanged
  });

  it('freezes at the moment it was set and keeps that point after the owner moves', async () => {
    await request(app).put(`/v1/friends/${c.user.id}/sharing`).set(a.auth).send({ mode: 'frozen' });
    await request(app).put('/v1/me/location').set(a.auth).send({ lat: 41.4, lng: 69.4 });
    const frozen = (await seenBy(c)).location;
    assert.equal(frozen.frozen, true);
    assert.equal(frozen.lat, at.lat);
    assert.equal((await seenBy(b)).location.blurred, true); // still follows, but blurred
  });

  it('hides completely and returns to the default', async () => {
    await request(app).put(`/v1/friends/${b.user.id}/sharing`).set(a.auth).send({ mode: 'hidden' });
    assert.equal((await seenBy(b)).location, null);
    await request(app).put(`/v1/friends/${b.user.id}/sharing`).set(a.auth).send({ mode: 'default' });
    assert.equal((await seenBy(b)).location.lat, 41.4);
  });

  it('refuses strangers and bad modes', async () => {
    const stranger = await signUp();
    assert.equal((await request(app).put(`/v1/friends/${stranger.user.id}/sharing`).set(a.auth).send({ mode: 'hidden' })).status, 404);
    assert.equal((await request(app).put(`/v1/friends/${b.user.id}/sharing`).set(a.auth).send({ mode: 'nope' })).status, 400);
  });

  it('sets a status that ends and counts the time spent in one place', async () => {
    await request(app).put('/v1/me/status').set(a.auth).send({ text: 'Coffee', hours: 1 });
    assert.equal((await seenBy(b)).location.status, 'Coffee');
    await pool.query("UPDATE users SET status_until = NOW() - INTERVAL '1 minute' WHERE id = $1", [a.user.id]);
    assert.equal((await seenBy(b)).location.status, null);
    await pool.query("UPDATE locations SET anchor_since = NOW() - INTERVAL '42 minutes' WHERE user_id = $1", [a.user.id]);
    await request(app).put('/v1/me/location').set(a.auth).send({ lat: 41.4, lng: 69.4, activity: 'still' }); // same spot: the timer keeps running
    const f = await seenBy(b);
    assert.ok(f.location.stillForS >= 42 * 60 - 5, `stillForS ${f.location.stillForS}`);
  });
});
