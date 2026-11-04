import { Router } from 'express';
import { z } from 'zod';
import { many, one } from '../db.js';
import { badRequest, idParam, notFound, parse, route } from '../lib/http.js';
import { generateApiKey } from '../lib/tokens.js';
import { sessionOnly } from '../middleware/auth.js';

// Developers create keys here (signed in with the app) and then call the same /v1 API
// with `X-API-Key`. A key acts as its owner, limited to its scopes.
const router = Router();
router.use(sessionOnly);

const MAX_ACTIVE_KEYS = 10;

function serializeKey(r) {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: r.scopes,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

router.get(
  '/',
  route(async (req, res) => {
    const rows = await many(
      'SELECT * FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC',
      [req.auth.userId],
    );
    res.json({ apiKeys: rows.map(serializeKey) });
  }),
);

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  scopes: z
    .array(z.enum(['read', 'write']))
    .min(1)
    .default(['read'])
    .transform((s) => [...new Set(s)]),
});

router.post(
  '/',
  route(async (req, res) => {
    const input = parse(createSchema, req.body);
    const { count } = await one(
      'SELECT COUNT(*) AS count FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL',
      [req.auth.userId],
    );
    if (count >= MAX_ACTIVE_KEYS) throw badRequest(`You can have at most ${MAX_ACTIVE_KEYS} active API keys`);
    const { key, prefix, hash } = generateApiKey();
    const row = await one(
      `INSERT INTO api_keys (user_id, name, prefix, key_hash, scopes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.auth.userId, input.name, prefix, hash, input.scopes],
    );
    // The full key is only ever returned here; afterwards only its prefix is known.
    res.status(201).json({ ...serializeKey(row), key });
  }),
);

router.delete(
  '/:id',
  route(async (req, res) => {
    const id = idParam(req.params.id, 'API key');
    const row = await one(
      'UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id',
      [id, req.auth.userId],
    );
    if (!row) throw notFound('API key');
    res.status(204).end();
  }),
);

export default router;
