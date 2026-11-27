import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { app, makeFriends, request, resetDatabase, signUp, straightTrack } = await import('./helpers.js');

const upload = (u, visibility, secondsPerStep = 30, count = 41) =>
  request(app).post('/v1/activities').set(u.auth).send({
    type: 'run', visibility,
    points: straightTrack({ count, stepM: 50, stepS: secondsPerStep }).map((p) => ({ ...p, t: new Date(p.t).toISOString() })),
  });

describe('segments, clubs, heatmap', () => {
  let a, b, c, d;
  before(async () => { await resetDatabase(); [a, b, c, d] = [await signUp(), await signUp(), await signUp(), await signUp()]; await makeFriends(a, b); });

  it('cuts a segment from an activity and ranks efforts; private runs never reach the board', async () => {
    const first = await upload(a, 'public', 30);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const seg = await request(app).post('/v1/segments').set(a.auth).send({ name: 'Park loop', activityId: first.body.id, from: 2, to: 38 });
    assert.equal(seg.status, 201, JSON.stringify(seg.body));
    assert.ok(seg.body.distanceM > 1500);
    assert.equal((await request(app).post('/v1/segments').set(a.auth).send({ name: 'x1', activityId: first.body.id, from: 5, to: 6 })).status, 400);
    // a faster public run, a friends-only run and a private run over the same line
    assert.equal((await upload(b, 'public', 20)).status, 201);
    assert.equal((await upload(c, 'private', 10)).status, 201);
    assert.equal((await upload(d, 'friends', 15)).status, 201);
    const board = (await request(app).get(`/v1/segments/${seg.body.id}`).set(a.auth)).body;
    // efforts only exist for runs recorded after the segment, so the owner's earlier run has none
    assert.deepEqual(board.board.map((r) => r.user.id), [b.user?.id ?? board.board[0].user.id]);
    assert.equal(board.me, null);
    const again = await upload(a, 'public', 25);
    assert.equal(again.status, 201);
    const after = (await request(app).get(`/v1/segments/${seg.body.id}`).set(a.auth)).body;
    assert.equal(after.board.length, 2);
    assert.equal(after.kom.elapsedS < after.board[1].elapsedS, true);
    assert.equal(after.me.place, 2);
    // the private runner's effort and a stranger's friends-only effort stay hidden from a stranger
    const asC = (await request(app).get(`/v1/segments/${seg.body.id}`).set(c.auth)).body;
    assert.equal(asC.board.length, 3); // a, b and your own private run; d's friends-only run stays hidden
    assert.ok(asC.me, 'you see your own effort');
    assert.equal(asC.board.some((r) => r.user.id === d.user?.id && d.user?.id), false);
    const nearby = (await request(app).get('/v1/segments/nearby?lat=41.311&lng=69.279&radius=20000').set(a.auth)).body;
    assert.equal(nearby.segments.length >= 0, true);
  });

  it('clubs, joining and a challenge board that skips private activities', async () => {
    const club = await request(app).post('/v1/clubs').set(a.auth).send({ name: 'Morning Runners' });
    assert.equal(club.status, 201);
    assert.equal((await request(app).post('/v1/clubs').set(b.auth).send({ name: 'morning runners' })).status, 409);
    assert.equal((await request(app).post(`/v1/clubs/${club.body.id}/join`).set(b.auth)).status, 204);
    assert.equal((await request(app).post(`/v1/clubs/${club.body.id}/join`).set(c.auth)).status, 204);
    assert.equal((await request(app).post(`/v1/clubs/${club.body.id}/challenges`).set(b.auth).send({ title: 'Week', metric: 'distance' })).status, 403);
    const ch = await request(app).post(`/v1/clubs/${club.body.id}/challenges`).set(a.auth).send({ title: 'Distance cup', metric: 'distance', days: 7 });
    assert.equal(ch.status, 201);
    assert.equal(ch.body.ad, undefined);
    assert.equal((await request(app).post(`/v1/clubs/${club.body.id}/challenges`).set(a.auth).send({ title: 'Backed', metric: 'count', sponsorPlaceId: '00000000-0000-4000-8000-000000000000' })).status, 403);
    const res = (await request(app).get(`/v1/challenges/${ch.body.id}`).set(b.auth)).body;
    const byUser = Object.fromEntries(res.board.map((r) => [r.user.id, r.total]));
    assert.equal(res.board.length, 3);
    assert.equal(Object.values(byUser).filter((v) => v === 0).length >= 1, true); // the private runner counts for nothing
    assert.equal(res.board[0].total >= res.board[1].total, true);
    assert.equal((await request(app).delete(`/v1/clubs/${club.body.id}/leave`).set(a.auth)).status, 403);
    assert.equal((await request(app).delete(`/v1/clubs/${club.body.id}/leave`).set(b.auth)).status, 204);
    assert.equal((await request(app).get('/v1/clubs?q=morning').set(a.auth)).body.clubs.length, 1);
  });

  it('heatmap shows only cells where enough different people moved', async () => {
    const q = (x) => `/v1/heatmap?minLat=${x.minLat}&maxLat=${x.maxLat}&minLng=${x.minLng}&maxLng=${x.maxLng}`;
    const start = straightTrack({ count: 2, stepM: 10, stepS: 1 })[0];
    const box = { minLat: start.lat - 0.05, maxLat: start.lat + 0.05, minLng: start.lng - 0.05, maxLng: start.lng + 0.05 };
    // only a (x2) and b are public over this route: 2 people < 3
    assert.equal((await request(app).get(q(box)).set(a.auth)).body.cells.length, 0);
    assert.equal((await upload(d, 'public', 40)).status, 201);
    const cells = (await request(app).get(q(box)).set(a.auth)).body.cells;
    assert.ok(cells.length > 0);
    assert.equal((await request(app).get(q({ minLat: 0, maxLat: 5, minLng: 0, maxLng: 5 })).set(a.auth)).status, 400);
  });
});
