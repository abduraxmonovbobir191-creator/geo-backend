// Nex Map shop: subscription and in-app purchases paid in Nex Coins at Nex ID (src/lib/wallet.js).
// What is bought here works only in Nex Map (entitlements below), it is never a Nex ID perk.
import crypto from 'node:crypto';
import { many, one, query } from '../db.js';
import { HttpError, notFound } from './http.js';
import * as wallet from './wallet.js';

const DAY = 86_400_000;

export const catalog = () => many('SELECT * FROM shop_items WHERE active ORDER BY sort');

const stillValid = (p) => p.status === 'active' || (p.status === 'canceled' && p.renews_at && new Date(p.renews_at) > new Date());

export async function myPurchases(userId) {
  const rows = await many(
    `SELECT p.*, i.kind, i.perks FROM purchases p JOIN shop_items i ON i.sku = p.sku
     WHERE p.user_id = $1 AND p.status IN ('active', 'canceled')`,
    [userId],
  );
  return rows.filter(stillValid);
}

// Nex ID perks (Nex Premium) plus what this person bought in Nex Map.
export async function entitlementsOf(user) {
  const bought = (await myPurchases(user.id)).flatMap((p) => p.perks);
  return [...new Set([...(user.perks || []), ...bought])];
}

export function serializeItem(i, owned) {
  const mine = owned.find((p) => p.sku === i.sku);
  return {
    sku: i.sku, kind: i.kind, title: i.title, description: i.description, price: i.price,
    periodDays: i.period_days, perks: i.perks,
    owned: mine ? { status: mine.status, renewsAt: mine.renews_at, since: mine.created_at } : null,
  };
}

export async function shopFor(user) {
  const [items, owned] = await Promise.all([catalog(), myPurchases(user.id)]);
  let coins = null;
  if (user.nexid_sub) coins = await wallet.balance(user.nexid_sub).catch(() => null);
  return {
    items: items.map((i) => serializeItem(i, owned)),
    balance: coins?.balance ?? null,
    walletUrl: wallet.walletUrl(),
  };
}

// One tap: the client sends the price it showed (`price`, 409 price_changed if it moved) and a `key`, so a retry pays once.
export async function buy(user, { sku, price, key, source = 'map' }) {
  if (!user.nexid_sub) throw new HttpError(403, 'nexid_required', 'Sign in with Nex ID to buy');
  const item = await one('SELECT * FROM shop_items WHERE sku = $1 AND active', [sku]);
  if (!item) throw notFound('Item');
  if (price !== undefined && price !== item.price) {
    throw new HttpError(409, 'price_changed', 'The price changed', { price: item.price });
  }
  const ref = `nexmap:buy:${user.id}:${sku}:${key || crypto.randomUUID()}`;
  const again = await one('SELECT * FROM purchases WHERE ref = $1', [ref]);
  if (again) return again; // a retry of a paid purchase
  const owned = (await myPurchases(user.id)).find((p) => p.sku === sku);
  if (owned) throw new HttpError(409, 'already_owned', 'You already have this');

  await wallet.charge(user.nexid_sub, item.price, ref, `Nex Map: ${item.title}`);
  try {
    return await one(
      `INSERT INTO purchases (user_id, sku, price, ref, source, renews_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [user.id, sku, item.price, ref, source, item.period_days ? new Date(Date.now() + item.period_days * DAY) : null],
    );
  } catch (err) {
    // Took the money but could not record it: give it back, never keep coins without the item.
    await wallet.refund(ref).catch(() => {});
    if (err.code === '23505') throw new HttpError(409, 'already_owned', 'You already have this');
    throw err;
  }
}

async function ownedSubscription(userId, sku) {
  const p = await one(
    `SELECT p.* FROM purchases p JOIN shop_items i ON i.sku = p.sku
     WHERE p.user_id = $1 AND p.sku = $2 AND i.kind = 'subscription' AND p.status IN ('active', 'canceled')`,
    [userId, sku],
  );
  if (!p) throw notFound('Subscription');
  return p;
}

// Cancel keeps the access until the paid period ends; resume (before it ends) turns renewals back on, no new charge.
export async function setRenewal(userId, sku, renew) {
  const p = await ownedSubscription(userId, sku);
  if (renew && !stillValid(p)) throw new HttpError(409, 'subscription_ended', 'Buy it again');
  return one('UPDATE purchases SET status = $2 WHERE id = $1 RETURNING *', [p.id, renew ? 'active' : 'canceled']);
}

// Sweep: renew what is due at Nex ID's wallet; a person without coins loses the subscription, nothing else.
export async function renewDue(batch = 100) {
  let renewed = 0;
  const due = await many(
    `SELECT p.*, i.period_days, i.price AS now_price, i.title, u.nexid_sub
     FROM purchases p JOIN shop_items i ON i.sku = p.sku JOIN users u ON u.id = p.user_id
     WHERE p.renews_at <= NOW() AND p.status IN ('active', 'canceled') AND i.kind = 'subscription' LIMIT $1`,
    [batch],
  );
  for (const p of due) {
    if (p.status === 'canceled' || !p.nexid_sub) {
      await query("UPDATE purchases SET status = 'ended' WHERE id = $1", [p.id]);
      continue;
    }
    const next = new Date(new Date(p.renews_at).getTime() + p.period_days * DAY);
    try {
      await wallet.charge(p.nexid_sub, p.now_price, `nexmap:sub:${p.id}:${next.toISOString().slice(0, 10)}`, `Nex Map: ${p.title}`);
      await query('UPDATE purchases SET renews_at = $2, price = $3 WHERE id = $1', [p.id, next, p.now_price]);
      renewed += 1;
    } catch (err) {
      // No coins: the subscription ends. Nex ID or wallet down: try again at the next sweep.
      if (err.code === 'insufficient_funds') await query("UPDATE purchases SET status = 'ended' WHERE id = $1", [p.id]);
    }
  }
  return renewed;
}
