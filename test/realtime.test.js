import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { io as connect } from 'socket.io-client';
import { app, makeFriends, pool, request, resetDatabase, signUp } from './helpers.js';
import { attachRealtime } from '../src/realtime.js';

let server;
let ioServer;
let url;
const sockets = [];

before(async () => {
  await resetDatabase();
  server = http.createServer(app);
  ioServer = attachRealtime(server);
  await new Promise((resolve) => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});

after(async () => {
  sockets.forEach((s) => s.close());
  ioServer.close();
  await pool.end();
});

function open(token) {
  const socket = connect(url, { auth: { token }, transports: ['websocket'], forceNew: true });
  sockets.push(socket);
  return socket;
}

const nextEvent = (socket, event) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 3000);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

test('rejects connections without valid credentials', async () => {
  const socket = open('not-a-token');
  const err = await nextEvent(socket, 'connect_error');
  assert.equal(err.message, 'unauthorized');
});

test('friends get live locations, presence and messages', async () => {
  const a = await signUp();
  const b = await signUp();
  const stranger = await signUp();
  await makeFriends(a, b);

  const sa = open(a.token);
  await nextEvent(sa, 'friends:online');
  const strangerSocket = open(stranger.token);
  await nextEvent(strangerSocket, 'friends:online');
  let strangerGotLocation = false;
  strangerSocket.on('friend:location', () => (strangerGotLocation = true));

  const online = nextEvent(sa, 'friend:online');
  const sb = open(b.token);
  const initial = await nextEvent(sb, 'friends:online');
  assert.deepEqual(initial.userIds, [a.user.id]);
  assert.equal((await online).userId, b.user.id);

  const located = nextEvent(sa, 'friend:location');
  const ack = await sb.emitWithAck('location:update', { lat: 41.3, lng: 69.25, battery: 55 });
  assert.deepEqual(ack, { ok: true, shared: true });
  const loc = await located;
  assert.equal(loc.userId, b.user.id);
  assert.equal(loc.battery, 55);

  const bad = await sb.emitWithAck('location:update', { lat: 500 });
  assert.equal(bad.ok, false);

  const message = nextEvent(sa, 'message:new');
  await request(app).post(`/v1/messages/${a.user.id}`).set(b.auth).send({ body: 'Qayerdasan?' });
  assert.equal((await message).body, 'Qayerdasan?');

  const offline = nextEvent(sa, 'friend:offline');
  sb.close();
  assert.equal((await offline).userId, b.user.id);
  assert.equal(strangerGotLocation, false);
});
