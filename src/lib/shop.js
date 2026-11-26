// Nex Map shop: a 30-day pass and in-app purchases paid in Stars at Nex ID (src/lib/wallet.js).
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
  let stars = null;
  if (user.nexid_sub) stars = await wallet.balance(user.nexid_sub).catch(() => null);
  return {
    items: items.map((i) => serializeItem(i, owned)),
    balance: stars?.balance ?? null,
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
  // A 30-day pass is extended with one tap while it runs (the days add up); an item is bought once.
  if (owned && item.kind === 'subscription') return extendPass(user, item, owned, ref);
  if (owned) throw new HttpError(409, 'already_owned', 'You already have this');

  await wallet.charge(user.nexid_sub, item.price, ref, `Nex Map: ${item.title}`);
  try {
    return await one(
      `INSERT INTO purchases (user_id, sku, price, ref, source, renews_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [user.id, sku, item.price, ref, source, item.period_days ? new Date(Date.now() + item.period_days * DAY) : null],
    );
  } catch (err) {
    // Took the money but could not record it: give it back, never keep Stars without the item.
    await wallet.refund(ref).catch(() => {});
    if (err.code === '23505') throw new HttpError(409, 'already_owned', 'You already have this');
    throw err;
  }
}

async function extendPass(user, item, owned, ref) {
  // the same tap again (a retry): the days were added once, nothing is charged or refunded
  if (await one('SELECT 1 FROM purchase_extensions WHERE ref = $1', [ref])) return one('SELECT * FROM purchases WHERE id = $1', [owned.id]);
  await wallet.charge(user.nexid_sub, item.price, ref, `Nex Map: ${item.title}`);
  try {
    const base = Math.max(Date.now(), new Date(owned.renews_at).getTime());
    await query('INSERT INTO purchase_extensions (ref, purchase_id, days) VALUES ($1, $2, $3)', [ref, owned.id, item.period_days]);
    return await one('UPDATE purchases SET renews_at = $2, status = $3 WHERE id = $1 RETURNING *', [owned.id, new Date(base + item.period_days * DAY), 'active']);
  } catch (err) {
    if (err.code === '23505') return one('SELECT * FROM purchases WHERE id = $1', [owned.id]); // a parallel retry already recorded it
    await wallet.refund(ref).catch(() => {}); // took the Stars but could not record it: give them back
    throw err;
  }
}

// Sweep: a pass that ran out simply ends. Nothing is charged automatically (store rules); the app reminds the person and one tap extends it.
export async function endExpired() {
  const rows = await many(
    `UPDATE purchases p SET status = 'ended' FROM shop_items i
     WHERE i.sku = p.sku AND i.kind = 'subscription' AND p.status IN ('active', 'canceled') AND p.renews_at <= NOW() RETURNING p.id`,
  );
  return rows.length;
}

// People whose pass ends within `days` days (the app shows "ends in N days, extend"; a push can follow).
export const endingSoon = (userId, days = 3) =>
  many(
    `SELECT p.sku, p.renews_at FROM purchases p JOIN shop_items i ON i.sku = p.sku
     WHERE p.user_id = $1 AND i.kind = 'subscription' AND p.status = 'active' AND p.renews_at BETWEEN NOW() AND NOW() + make_interval(days => $2)`,
    [userId, days],
  );
