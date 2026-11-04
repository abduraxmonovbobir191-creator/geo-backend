import { Server } from 'socket.io';
import { config } from './config.js';
import { resolveAuth } from './middleware/auth.js';
import { emitToUsers, friendIds, setRealtimeServer } from './lib/social.js';
import { locationSchema, updateLocation } from './routes/me.js';

// Open sockets per user, to announce online/offline only on the first connect and last disconnect.
// This lives in memory, so it is correct for a single server process; several instances would
// need the Socket.IO Redis adapter and a shared presence store.
const connections = new Map();

/**
 * Socket.IO events
 *  client -> server: "location:update" {lat, lng, accuracy?, speed?, heading?, battery?}, ack({ok, shared})
 *  server -> client: "friend:location", "friend:online", "friend:offline", "friend:ghost",
 *                    "friend:request", "friend:accepted", "friend:removed", "friend:checkin",
 *                    "message:new", "message:read", "activity:kudos"
 * Connect with io(url, { auth: { token: "<jwt or nex_ api key>" } }).
 */
export function attachRealtime(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const headers = { authorization: token ? `Bearer ${token}` : '' };
      const auth = await resolveAuth({ get: (name) => headers[name.toLowerCase()] });
      if (!auth) return next(new Error('unauthorized'));
      socket.data.auth = auth;
      next();
    } catch (err) {
      next(err);
    }
  });

  io.on('connection', async (socket) => {
    const { userId, scopes } = socket.data.auth;
    socket.join(`user:${userId}`);

    const count = (connections.get(userId) ?? 0) + 1;
    connections.set(userId, count);
    const friends = await friendIds(userId).catch(() => []);
    if (count === 1) emitToUsers(friends, 'friend:online', { userId });
    // Tell the newcomer which friends are online right now.
    socket.emit('friends:online', { userIds: friends.filter((id) => connections.has(id)) });

    socket.on('location:update', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!scopes.includes('write')) return reply({ ok: false, error: 'missing write scope' });
      const parsed = locationSchema.safeParse(payload);
      if (!parsed.success) return reply({ ok: false, error: 'invalid location' });
      try {
        const { shared } = await updateLocation(userId, parsed.data);
        reply({ ok: true, shared });
      } catch {
        reply({ ok: false, error: 'server error' });
      }
    });

    socket.on('disconnect', async () => {
      const left = (connections.get(userId) ?? 1) - 1;
      if (left > 0) {
        connections.set(userId, left);
        return;
      }
      connections.delete(userId);
      emitToUsers(await friendIds(userId).catch(() => []), 'friend:offline', { userId });
    });
  });

  setRealtimeServer(io);
  return io;
}
