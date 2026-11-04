import { Router } from 'express';
import { z } from 'zod';
import { many, one } from '../db.js';
import { idParam, notFound, parse, route } from '../lib/http.js';
import { PUBLIC_USER_COLUMNS, publicUser } from '../lib/social.js';

const router = Router();

const searchSchema = z.object({
  q: z.string().trim().min(1).max(50),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// Escapes LIKE wildcards so a search for "a_b" matches literally.
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

router.get(
  '/search',
  route(async (req, res) => {
    const { q, limit } = parse(searchSchema, req.query);
    const pattern = `%${likeEscape(q.toLowerCase())}%`;
    const rows = await many(
      `SELECT ${PUBLIC_USER_COLUMNS} FROM users u
       WHERE u.id <> $1 AND (LOWER(u.username) LIKE $2 OR LOWER(u.name) LIKE $2)
       ORDER BY (LOWER(u.username) = LOWER($3)) DESC, u.username
       LIMIT $4`,
      [req.auth.userId, pattern, q, limit],
    );
    res.json({ users: rows.map(publicUser) });
  }),
);

router.get(
  '/:id',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'User');
    const row = await one(`SELECT ${PUBLIC_USER_COLUMNS} FROM users u WHERE u.id = $1`, [id]);
    if (!row) throw notFound('User');
    const rel = await one(
      `SELECT status, requester_id FROM friendships
       WHERE LEAST(requester_id, addressee_id) = LEAST($1::uuid, $2::uuid)
         AND GREATEST(requester_id, addressee_id) = GREATEST($1::uuid, $2::uuid)`,
      [req.auth.userId, id],
    );
    let friendship = 'none';
    if (id === req.auth.userId) friendship = 'self';
    else if (rel?.status === 'accepted') friendship = 'friends';
    else if (rel) friendship = rel.requester_id === req.auth.userId ? 'request_sent' : 'request_received';
    res.json({ ...publicUser(row), friendship });
  }),
);

export default router;
