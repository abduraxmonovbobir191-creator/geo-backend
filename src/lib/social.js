import { many, one } from '../db.js';

// Fields of a user that anyone signed in may see.
export const PUBLIC_USER_COLUMNS = 'u.id, u.username, u.name, u.bio, u.avatar_url, u.created_at';

export function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
  };
}

export async function areFriends(a, b) {
  if (a === b) return false;
  const row = await one(
    `SELECT 1 FROM friendships
     WHERE status = 'accepted'
       AND LEAST(requester_id, addressee_id) = LEAST($1::uuid, $2::uuid)
       AND GREATEST(requester_id, addressee_id) = GREATEST($1::uuid, $2::uuid)`,
    [a, b],
  );
  return Boolean(row);
}

export async function friendIds(userId) {
  const rows = await many(
    `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS id
     FROM friendships
     WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)`,
    [userId],
  );
  return rows.map((r) => r.id);
}

// Realtime fan-out. realtime.js registers the Socket.IO server here so HTTP routes can
// notify connected clients without importing the socket layer directly.
let io = null;
export function setRealtimeServer(server) {
  io = server;
}
export function emitToUsers(userIds, event, payload) {
  if (!io || userIds.length === 0) return;
  io.to(userIds.map((id) => `user:${id}`)).emit(event, payload);
}
