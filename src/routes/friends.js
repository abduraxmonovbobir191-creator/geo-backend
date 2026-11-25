import { Router } from 'express';
import { z } from 'zod';
import { many, one, query } from '../db.js';
import { badRequest, conflict, forbidden, idParam, notFound, parse, route } from '../lib/http.js';
import { PUBLIC_USER_COLUMNS, emitToUsers, publicUser } from '../lib/social.js';
import { MODES, viewOf, viewsForFriends } from '../lib/privacy.js';

const router = Router();

// Friends with the location each of them chose to show you (precise, blurred, frozen or none) and how you show yourself to them.
router.get(
  '/',
  route(async (req, res) => {
    const me = req.auth.userId;
    const rows = await many(
      `SELECT ${PUBLIC_USER_COLUMNS}, f.accepted_at,
              u.share_mode AS owner_default, u.share_activity, u.share_steps, u.status_text, u.status_until,
              l.user_id, l.lat, l.lng, l.accuracy, l.speed, l.heading, l.battery, l.updated_at,
              l.activity, l.is_charging, l.steps_today, l.anchor_since,
              theirs.mode AS their_mode, theirs.frozen_lat, theirs.frozen_lng, theirs.frozen_at,
              mine.mode AS my_mode
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
       LEFT JOIN locations l ON l.user_id = u.id
       LEFT JOIN location_sharing theirs ON theirs.owner_id = u.id AND theirs.friend_id = $1
       LEFT JOIN location_sharing mine ON mine.owner_id = $1 AND mine.friend_id = u.id
       WHERE f.status = 'accepted' AND (f.requester_id = $1 OR f.addressee_id = $1)
       ORDER BY u.name`,
      [me],
    );
    res.json({
      friends: rows.map((r) => ({
        ...publicUser(r),
        friendsSince: r.accepted_at,
        location: viewOf({ mode: r.their_mode ?? r.owner_default, frozen: r, owner: r, loc: r.user_id ? { ...r, user_id: r.user_id } : null }),
        // How you appear to this friend ("default" = your general setting).
        sharing: r.my_mode ?? 'default',
      })),
    });
  }),
);

// Choose how you appear to one friend: precise | blurred | frozen (they keep the point from now) | hidden | default.
router.put(
  '/:userId/sharing',
  route(async (req, res) => {
    const friend = idParam(req.params.userId, 'Friend');
    const { mode } = parse(z.object({ mode: z.enum([...MODES, 'default']) }), req.body);
    const me = req.auth.userId;
    const ok = await one(
      `SELECT 1 FROM friendships WHERE status = 'accepted'
         AND LEAST(requester_id, addressee_id) = LEAST($1::uuid, $2::uuid) AND GREATEST(requester_id, addressee_id) = GREATEST($1::uuid, $2::uuid)`,
      [me, friend],
    );
    if (!ok) throw notFound('Friend');
    if (mode === 'default') {
      await query('DELETE FROM location_sharing WHERE owner_id = $1 AND friend_id = $2', [me, friend]);
    } else {
      const loc = mode === 'frozen' ? await one('SELECT lat, lng FROM locations WHERE user_id = $1', [me]) : null;
      await query(
        `INSERT INTO location_sharing (owner_id, friend_id, mode, frozen_lat, frozen_lng, frozen_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (owner_id, friend_id) DO UPDATE SET mode = EXCLUDED.mode, frozen_lat = EXCLUDED.frozen_lat,
           frozen_lng = EXCLUDED.frozen_lng, frozen_at = EXCLUDED.frozen_at`,
        [me, friend, mode, loc?.lat ?? null, loc?.lng ?? null, loc ? new Date() : null],
      );
    }
    // The friend's map follows at once: they get the new view (or none).
    const view = (await viewsForFriends(me)).find((v) => v.friendId === friend)?.view ?? null;
    emitToUsers([friend], view ? 'friend:location' : 'friend:location_hidden', view ?? { userId: me });
    res.json({ userId: friend, mode });
  }),
);

function serializeRequest(r) {
  return { id: r.request_id, createdAt: r.request_created_at, user: publicUser(r) };
}

router.get(
  '/requests',
  route(async (req, res) => {
    const select = (join, where) =>
      many(
        `SELECT f.id AS request_id, f.created_at AS request_created_at, ${PUBLIC_USER_COLUMNS}
         FROM friendships f JOIN users u ON u.id = f.${join}
         WHERE f.status = 'pending' AND f.${where} = $1
         ORDER BY f.created_at DESC`,
        [req.auth.userId],
      );
    const [incoming, outgoing] = await Promise.all([
      select('requester_id', 'addressee_id'),
      select('addressee_id', 'requester_id'),
    ]);
    res.json({ incoming: incoming.map(serializeRequest), outgoing: outgoing.map(serializeRequest) });
  }),
);

const requestSchema = z.object({ userId: z.string().uuid() });

router.post(
  '/requests',
  route(async (req, res) => {
    const { userId } = parse(requestSchema, req.body);
    const me = req.auth.userId;
    if (userId === me) throw badRequest('You cannot add yourself');
    const target = await one('SELECT id FROM users WHERE id = $1', [userId]);
    if (!target) throw notFound('User');

    const existing = await one(
      `SELECT * FROM friendships
       WHERE LEAST(requester_id, addressee_id) = LEAST($1::uuid, $2::uuid)
         AND GREATEST(requester_id, addressee_id) = GREATEST($1::uuid, $2::uuid)`,
      [me, userId],
    );
    if (existing?.status === 'accepted') throw conflict('You are already friends');
    if (existing && existing.requester_id === me) throw conflict('Friend request already sent');

    if (existing) {
      // They already asked us: sending a request back simply accepts theirs.
      const row = await one(
        `UPDATE friendships SET status = 'accepted', accepted_at = NOW() WHERE id = $1 RETURNING *`,
        [existing.id],
      );
      emitToUsers([userId], 'friend:accepted', { requestId: row.id, userId: me });
      return res.json({ id: row.id, status: 'accepted' });
    }

    let row;
    try {
      row = await one(
        `INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'pending') RETURNING *`,
        [me, userId],
      );
    } catch (err) {
      if (err.code === '23505') throw conflict('Friend request already exists');
      throw err;
    }
    emitToUsers([userId], 'friend:request', { requestId: row.id, userId: me });
    res.status(201).json({ id: row.id, status: 'pending' });
  }),
);

router.post(
  '/requests/:id/accept',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Friend request');
    const request = await one(`SELECT * FROM friendships WHERE id = $1 AND status = 'pending'`, [id]);
    if (!request || (request.addressee_id !== req.auth.userId && request.requester_id !== req.auth.userId)) {
      throw notFound('Friend request');
    }
    if (request.addressee_id !== req.auth.userId) throw forbidden('Only the recipient can accept a request');
    await one(`UPDATE friendships SET status = 'accepted', accepted_at = NOW() WHERE id = $1`, [id]);
    emitToUsers([request.requester_id], 'friend:accepted', { requestId: id, userId: req.auth.userId });
    res.json({ id, status: 'accepted' });
  }),
);

// Declines (recipient) or cancels (sender) a pending request.
router.delete(
  '/requests/:id',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'Friend request');
    const row = await one(
      `DELETE FROM friendships
       WHERE id = $1 AND status = 'pending' AND (requester_id = $2 OR addressee_id = $2)
       RETURNING id`,
      [id, req.auth.userId],
    );
    if (!row) throw notFound('Friend request');
    res.status(204).end();
  }),
);

router.delete(
  '/:userId',
  route(async (req, res) => {
    const other = idParam(req.params.userId, 'Friend');
    const row = await one(
      `DELETE FROM friendships
       WHERE status = 'accepted'
         AND LEAST(requester_id, addressee_id) = LEAST($1::uuid, $2::uuid)
         AND GREATEST(requester_id, addressee_id) = GREATEST($1::uuid, $2::uuid)
       RETURNING id`,
      [req.auth.userId, other],
    );
    if (!row) throw notFound('Friend');
    emitToUsers([other], 'friend:removed', { userId: req.auth.userId });
    res.status(204).end();
  }),
);

export default router;
