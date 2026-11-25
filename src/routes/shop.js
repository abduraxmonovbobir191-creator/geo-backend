import { Router } from 'express';
import { z } from 'zod';
import { one } from '../db.js';
import { parse, route } from '../lib/http.js';
import { buy, setRenewal, shopFor } from '../lib/shop.js';
import { sessionOnly } from '../middleware/auth.js';

// Nex Map's subscription and purchases. Money lives only at Nex ID (Nex Coins); an API key never spends it.
const router = Router();
const me = (req) => one('SELECT * FROM users WHERE id = $1', [req.auth.userId]);

export const buySchema = z.object({
  sku: z.string().min(1).max(40),
  price: z.number().int().positive().optional(),
  key: z.string().min(8).max(64).optional(),
});

router.get('/', route(async (req, res) => res.json(await shopFor(await me(req)))));

router.post(
  '/buy',
  sessionOnly,
  route(async (req, res) => {
    const input = parse(buySchema, req.body);
    const user = await me(req);
    const p = await buy(user, { ...input, source: 'map' });
    res.status(201).json({ purchase: { id: p.id, sku: p.sku, status: p.status, renewsAt: p.renews_at }, ...(await shopFor(user)) });
  }),
);

for (const [action, renew] of [['cancel', false], ['resume', true]]) {
  router.post(
    `/subscriptions/:sku/${action}`,
    sessionOnly,
    route(async (req, res) => {
      await setRenewal(req.auth.userId, req.params.sku, renew);
      res.json(await shopFor(await me(req)));
    }),
  );
}

export default router;
