import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { app, makeFriends, pool, request, resetDatabase, signUp, straightTrack } from './helpers.js';

before(resetDatabase);
after(() => pool.end());

describe('auth', () => {
  test('register, login with email or username, and read /me', async () => {
    const reg = await request(app)
      .post('/v1/auth/register')
      .send({ name: 'Ali', username: 'ali', email: 'Ali@Example.com', password: 'secret123' });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.email, 'ali@example.com');
    assert.equal(reg.body.user.password_hash, undefined);

    for (const login of ['ali@example.com', 'ALI']) {
      const res = await request(app).post('/v1/auth/login').send({ login, password: 'secret123' });
      assert.equal(res.status, 200, login);
      const me = await request(app).get('/v1/me').set('Authorization', `Bearer ${res.body.token}`);
      assert.equal(me.body.username, 'ali');
    }
  });

  test('rejects duplicates, bad passwords and missing tokens', async () => {
    const dup = await request(app)
      .post('/v1/auth/register')
      .send({ name: 'X', username: 'ALI', email: 'other@example.com', password: 'secret123' });
    assert.equal(dup.status, 409);

    const bad = await request(app).post('/v1/auth/login').send({ login: 'ali', password: 'wrong-password' });
    assert.equal(bad.status, 401);

    const anon = await request(app).get('/v1/me');
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error.code, 'unauthorized');

    const invalid = await request(app).post('/v1/auth/register').send({ name: '', username: 'a', email: 'x', password: '1' });
    assert.equal(invalid.status, 400);
    assert.ok(invalid.body.error.details.length >= 3);
  });
});

describe('friends and locations', () => {
  test('request, accept, see location; ghost mode freezes it', async () => {
    const a = await signUp();
    const b = await signUp();

    const sent = await request(app).post('/v1/friends/requests').set(a.auth).send({ userId: b.user.id });
    assert.equal(sent.status, 201);
    const again = await request(app).post('/v1/friends/requests').set(a.auth).send({ userId: b.user.id });
    assert.equal(again.status, 409);

    const requests = await request(app).get('/v1/friends/requests').set(b.auth);
    assert.equal(requests.body.incoming.length, 1);
    assert.equal(requests.body.incoming[0].user.id, a.user.id);

    // Only the recipient may accept.
    const wrong = await request(app).post(`/v1/friends/requests/${sent.body.id}/accept`).set(a.auth);
    assert.equal(wrong.status, 403);
    const accepted = await request(app).post(`/v1/friends/requests/${sent.body.id}/accept`).set(b.auth);
    assert.equal(accepted.body.status, 'accepted');

    const loc = await request(app).put('/v1/me/location').set(b.auth).send({ lat: 41.31, lng: 69.28, battery: 80 });
    assert.equal(loc.body.shared, true);

    let friends = await request(app).get('/v1/friends').set(a.auth);
    assert.equal(friends.body.friends.length, 1);
    assert.equal(friends.body.friends[0].location.lat, 41.31);
    assert.equal(friends.body.friends[0].location.battery, 80);

    await request(app).patch('/v1/me').set(b.auth).send({ ghostMode: true });
    const hidden = await request(app).put('/v1/me/location').set(b.auth).send({ lat: 40, lng: 70 });
    assert.equal(hidden.body.shared, false);
    friends = await request(app).get('/v1/friends').set(a.auth);
    assert.equal(friends.body.friends[0].location.lat, 41.31, 'friends still see the frozen position');

    const profile = await request(app).get(`/v1/users/${b.user.id}`).set(a.auth);
    assert.equal(profile.body.friendship, 'friends');

    const removed = await request(app).delete(`/v1/friends/${b.user.id}`).set(a.auth);
    assert.equal(removed.status, 204);
    friends = await request(app).get('/v1/friends').set(a.auth);
    assert.equal(friends.body.friends.length, 0);
  });

  test('a request back to someone who asked first accepts it', async () => {
    const a = await signUp();
    const b = await signUp();
    await request(app).post('/v1/friends/requests').set(a.auth).send({ userId: b.user.id });
    const back = await request(app).post('/v1/friends/requests').set(b.auth).send({ userId: a.user.id });
    assert.equal(back.status, 200);
    assert.equal(back.body.status, 'accepted');
  });

  test('user search and invalid ids', async () => {
    const a = await signUp({ username: 'searcher' });
    await signUp({ username: 'jasur_run', name: 'Jasur' });
    const res = await request(app).get('/v1/users/search?q=jasur').set(a.auth);
    assert.equal(res.body.users[0].username, 'jasur_run');
    const wildcard = await request(app).get('/v1/users/search?q=_').set(a.auth);
    assert.ok(wildcard.body.users.every((u) => u.username.includes('_')));

    const missing = await request(app).get('/v1/users/not-a-uuid').set(a.auth);
    assert.equal(missing.status, 404);
  });
});

describe('activities', () => {
  test('upload computes stats; visibility controls who sees it', async () => {
    const runner = await signUp();
    const friend = await signUp();
    const stranger = await signUp();
    await makeFriends(runner, friend);

    const points = straightTrack({ count: 21, stepM: 100, stepS: 30 }); // 2 km in 10 minutes
    const created = await request(app)
      .post('/v1/activities')
      .set(runner.auth)
      .send({ type: 'run', points: points.map((p) => ({ ...p, t: new Date(p.t).toISOString() })) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const act = created.body;
    assert.equal(act.title, 'Run');
    assert.equal(act.visibility, 'friends');
    assert.ok(Math.abs(act.distanceM - 2000) < 2);
    assert.equal(act.durationS, 600);
    assert.equal(act.avgPaceSPerKm, 300);
    assert.equal(act.preview.length, 21);

    const detail = await request(app).get(`/v1/activities/${act.id}`).set(friend.auth);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.points.length, 21);
    assert.equal((await request(app).get(`/v1/activities/${act.id}`).set(stranger.auth)).status, 404);

    const feed = await request(app).get('/v1/activities').set(friend.auth);
    assert.deepEqual(feed.body.activities.map((a) => a.id), [act.id]);
    const strangerFeed = await request(app).get('/v1/activities').set(stranger.auth);
    assert.equal(strangerFeed.body.activities.length, 0);

    // Public activities are visible to anyone, but only friends' show up in the feed.
    await request(app).patch(`/v1/activities/${act.id}`).set(runner.auth).send({ visibility: 'public', title: 'Morning run' });
    assert.equal((await request(app).get(`/v1/activities/${act.id}`).set(stranger.auth)).status, 200);
    assert.equal((await request(app).get('/v1/activities').set(stranger.auth)).body.activities.length, 0);
    const list = await request(app).get(`/v1/users/${runner.user.id}/activities`).set(stranger.auth);
    assert.equal(list.body.activities[0].title, 'Morning run');

    // Others cannot edit or delete it.
    assert.equal((await request(app).patch(`/v1/activities/${act.id}`).set(friend.auth).send({ title: 'x' })).status, 404);
    assert.equal((await request(app).delete(`/v1/activities/${act.id}`).set(friend.auth)).status, 404);

    const kudos = await request(app).post(`/v1/activities/${act.id}/kudos`).set(friend.auth);
    assert.deepEqual(kudos.body, { kudosCount: 1, hasKudos: true });
    await request(app).post(`/v1/activities/${act.id}/kudos`).set(friend.auth);
    const own = await request(app).post(`/v1/activities/${act.id}/kudos`).set(runner.auth);
    assert.equal(own.status, 400);
    const afterKudos = await request(app).get(`/v1/activities/${act.id}`).set(friend.auth);
    assert.equal(afterKudos.body.kudosCount, 1);
    assert.equal(afterKudos.body.hasKudos, true);

    const stats = await request(app).get('/v1/me/stats').set(runner.auth);
    assert.equal(stats.body.week.count, 1);
    assert.ok(Math.abs(stats.body.byType.run.all.distanceM - 2000) < 2);

    assert.equal((await request(app).delete(`/v1/activities/${act.id}`).set(runner.auth)).status, 204);
    assert.equal((await request(app).get(`/v1/activities/${act.id}`).set(runner.auth)).status, 404);
  });

  test('private activities are only visible to the owner', async () => {
    const a = await signUp();
    const b = await signUp();
    await makeFriends(a, b);
    const created = await request(app)
      .post('/v1/activities')
      .set(a.auth)
      .send({ type: 'walk', visibility: 'private', points: straightTrack() });
    assert.equal((await request(app).get(`/v1/activities/${created.body.id}`).set(b.auth)).status, 404);
    assert.equal((await request(app).get(`/v1/activities/${created.body.id}`).set(a.auth)).status, 200);
  });

  test('rejects bad tracks', async () => {
    const a = await signUp();
    const single = await request(app).post('/v1/activities').set(a.auth).send({ type: 'run', points: straightTrack({ count: 1 }) });
    assert.equal(single.status, 400);
    const future = await request(app)
      .post('/v1/activities')
      .set(a.auth)
      .send({ type: 'run', points: straightTrack({ start: Date.now() + 3_600_000 }) });
    assert.equal(future.status, 400);
    const sameTime = await request(app)
      .post('/v1/activities')
      .set(a.auth)
      .send({ type: 'run', points: straightTrack({ stepS: 0 }) });
    assert.equal(sameTime.status, 400);
  });
});

describe('places', () => {
  test('create, search nearby by distance and check in', async () => {
    const a = await signUp();
    const near = await request(app).post('/v1/places').set(a.auth).send({ name: 'Chorsu', category: 'shop', lat: 41.3264, lng: 69.2285 });
    assert.equal(near.status, 201);
    await request(app).post('/v1/places').set(a.auth).send({ name: 'Far away', lat: 39.65, lng: 66.96 });

    const res = await request(app).get('/v1/places/nearby?lat=41.32&lng=69.23&radius=2000').set(a.auth);
    assert.deepEqual(res.body.places.map((p) => p.name), ['Chorsu']);
    assert.ok(res.body.places[0].distanceM < 1000);

    const checkin = await request(app).post(`/v1/places/${near.body.id}/checkins`).set(a.auth);
    assert.equal(checkin.status, 201);
    const place = await request(app).get(`/v1/places/${near.body.id}`).set(a.auth);
    assert.equal(place.body.checkinCount, 1);

    const bad = await request(app).get('/v1/places/nearby?lat=100&lng=0').set(a.auth);
    assert.equal(bad.status, 400);
  });
});

describe('messages', () => {
  test('friends can chat; reading marks messages read', async () => {
    const a = await signUp();
    const b = await signUp();
    const stranger = await signUp();
    await makeFriends(a, b);

    const sent = await request(app).post(`/v1/messages/${b.user.id}`).set(a.auth).send({ body: 'Salom!' });
    assert.equal(sent.status, 201);
    await request(app).post(`/v1/messages/${b.user.id}`).set(a.auth).send({ body: 'Yugurishga chiqamizmi?' });

    let convos = await request(app).get('/v1/messages/conversations').set(b.auth);
    assert.equal(convos.body.conversations[0].unreadCount, 2);
    assert.equal(convos.body.conversations[0].lastMessage.body, 'Yugurishga chiqamizmi?');

    const history = await request(app).get(`/v1/messages/${a.user.id}`).set(b.auth);
    assert.deepEqual(history.body.messages.map((m) => m.body), ['Yugurishga chiqamizmi?', 'Salom!']);
    convos = await request(app).get('/v1/messages/conversations').set(b.auth);
    assert.equal(convos.body.conversations[0].unreadCount, 0);

    const older = await request(app).get(`/v1/messages/${a.user.id}?before=${history.body.messages[0].id}`).set(b.auth);
    assert.deepEqual(older.body.messages.map((m) => m.body), ['Salom!']);

    const blocked = await request(app).post(`/v1/messages/${a.user.id}`).set(stranger.auth).send({ body: 'hi' });
    assert.equal(blocked.status, 403);
  });
});

describe('API keys', () => {
  test('keys act as their owner, respect scopes, and can be revoked', async () => {
    const dev = await signUp();
    const created = await request(app).post('/v1/api-keys').set(dev.auth).send({ name: 'My bot' });
    assert.equal(created.status, 201);
    assert.ok(created.body.key.startsWith('nex_'));
    assert.deepEqual(created.body.scopes, ['read']);
    const readKey = created.body.key;

    const me = await request(app).get('/v1/me').set('X-API-Key', readKey);
    assert.equal(me.body.id, dev.user.id);
    const bearer = await request(app).get('/v1/me').set('Authorization', `Bearer ${readKey}`);
    assert.equal(bearer.status, 200);
    assert.ok(me.headers['ratelimit'] || me.headers['ratelimit-policy'], 'rate limit headers are present');

    const write = await request(app).put('/v1/me/location').set('X-API-Key', readKey).send({ lat: 1, lng: 1 });
    assert.equal(write.status, 403);

    // Keys can never manage keys, even with the write scope.
    const rw = await request(app).post('/v1/api-keys').set(dev.auth).send({ name: 'rw', scopes: ['read', 'write'] });
    const ok = await request(app).put('/v1/me/location').set('X-API-Key', rw.body.key).send({ lat: 1, lng: 1 });
    assert.equal(ok.status, 200);
    assert.equal((await request(app).get('/v1/api-keys').set('X-API-Key', rw.body.key)).status, 403);
    assert.equal((await request(app).put('/v1/me/password').set('X-API-Key', rw.body.key).send({})).status, 403);

    const list = await request(app).get('/v1/api-keys').set(dev.auth);
    assert.equal(list.body.apiKeys.length, 2);
    assert.equal(list.body.apiKeys[0].key, undefined, 'the full key is never listed');

    assert.equal((await request(app).delete(`/v1/api-keys/${created.body.id}`).set(dev.auth)).status, 204);
    assert.equal((await request(app).get('/v1/me').set('X-API-Key', readKey)).status, 401);
  });
});

describe('docs and errors', () => {
  test('serves the OpenAPI spec and Swagger UI', async () => {
    const spec = await request(app).get('/openapi.json');
    assert.equal(spec.body.openapi, '3.1.0');
    assert.ok(spec.body.paths['/v1/activities']);
    const docs = await request(app).get('/docs/');
    assert.equal(docs.status, 200);
    assert.match(docs.text, /swagger/i);
  });

  test('unknown routes and malformed JSON return JSON errors', async () => {
    const missing = await request(app).get('/v1/nope');
    assert.equal(missing.status, 401, 'v1 routes require auth before routing');
    const unknown = await request(app).get('/nope');
    assert.equal(unknown.status, 404);
    const malformed = await request(app).post('/v1/auth/login').set('Content-Type', 'application/json').send('{bad');
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'bad_request');
    const health = await request(app).get('/health');
    assert.deepEqual(health.body, { ok: true });
  });
});
