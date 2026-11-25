import { Router } from 'express';
import { z } from 'zod';
import { many, one } from '../db.js';
import { forbidden, idParam, notFound, parse, route } from '../lib/http.js';
import { PUBLIC_USER_COLUMNS, areFriends, emitToUsers, publicUser } from '../lib/social.js';

const router = Router();

function serializeMessage(r) {
  return {
    id: String(r.id),
    senderId: r.sender_id,
    recipientId: r.recipient_id,
    body: r.body,
    createdAt: r.created_at,
    readAt: r.read_at,
  };
}

router.get(
  '/conversations',
  route(async (req, res) => {
    const rows = await many(
      `WITH last AS (
         SELECT DISTINCT ON (partner) *
         FROM (
           SELECT m.*, CASE WHEN m.sender_id = $1 THEN m.recipient_id ELSE m.sender_id END AS partner
           FROM messages m
           WHERE m.sender_id = $1 OR m.recipient_id = $1
         ) mine
         ORDER BY partner, id DESC
       )
       SELECT last.id, last.sender_id, last.recipient_id, last.body, last.created_at, last.read_at,
              ${PUBLIC_USER_COLUMNS},
              (SELECT COUNT(*) FROM messages x
               WHERE x.sender_id = last.partner AND x.recipient_id = $1 AND x.read_at IS NULL) AS unread
       FROM last JOIN users u ON u.id = last.partner
       ORDER BY last.id DESC`,
      [req.auth.userId],
    );
    res.json({
      conversations: rows.map((r) => ({
        user: publicUser(r),
        lastMessage: serializeMessage(r),
        unreadCount: r.unread,
      })),
    });
  }),
);

const historySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // Cursor: only messages with an id lower than this (use the oldest message's id).
  before: z.coerce.number().int().positive().optional(),
});

router.get(
  '/:userId',
  route(async (req, res) => {
    const other = idParam(req.params.userId, 'User');
    const { limit, before } = parse(historySchema, req.query);
    const rows = await many(
      `SELECT * FROM messages
       WHERE LEAST(sender_id, recipient_id) = LEAST($1::uuid, $2::uuid)
         AND GREATEST(sender_id, recipient_id) = GREATEST($1::uuid, $2::uuid)
         AND ($3::bigint IS NULL OR id < $3)
       ORDER BY id DESC
       LIMIT $4`,
      [req.auth.userId, other, before ?? null, limit],
    );
    // Reading the newest page marks the partner's messages as read.
    if (!before) {
      const read = await many(
        `UPDATE messages SET read_at = NOW()
         WHERE sender_id = $2 AND recipient_id = $1 AND read_at IS NULL RETURNING id`,
        [req.auth.userId, other],
      );
      if (read.length > 0) {
        emitToUsers([other], 'message:read', { userId: req.auth.userId, messageIds: read.map((r) => String(r.id)) });
      }
    }
    res.json({ messages: rows.map(serializeMessage) });
  }),
);

const sendSchema = z.object({ body: z.string().trim().min(1).max(4_000) });

router.post(
  '/:userId',
  route(async (req, res) => {
    const other = idParam(req.params.userId, 'User');
    const { body } = parse(sendSchema, req.body);
    const exists = await one('SELECT 1 FROM users WHERE id = $1', [other]);
    if (!exists) throw notFound('User');
    if (!(await areFriends(req.auth.userId, other))) throw forbidden('You can only message friends');
    const row = await one('INSERT INTO messages (sender_id, recipient_id, body) VALUES ($1, $2, $3) RETURNING *', [
      req.auth.userId,
      other,
      body,
    ]);
    const message = serializeMessage(row);
    // The sender's other devices get it too.
    emitToUsers([other, req.auth.userId], 'message:new', message);
    res.status(201).json(message);
  }),
);

export default router;
