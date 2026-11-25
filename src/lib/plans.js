// Nex Premium is one subscription for every Nex product, bought at Nex ID. Features follow the Nex ID
// `perks` keys, never the plan name. The plan is cached per user (PLAN_CACHE_MINUTES); Nex ID down keeps the cached plan.
import { config } from '../config.js';
import { one } from '../db.js';
import { fetchPlan } from './nexid.js';

export const has = (user, perk) => Array.isArray(user?.perks) && user.perks.includes(perk);

// nexmap.api_keys: more developer API keys.
export const maxApiKeys = (user) => (has(user, 'nexmap.api_keys') ? 50 : 10);

export async function refreshPlan(user, { force = false } = {}) {
  if (!user?.nexid_sub) return user;
  const fresh = user.plan_checked_at && Date.now() - new Date(user.plan_checked_at).getTime() < config.nexid.planCacheMinutes * 60_000;
  if (fresh && !force) return user;
  const plan = await fetchPlan(user.nexid_sub);
  if (!plan) return user;
  return one('UPDATE users SET plan = $2, perks = $3, plan_checked_at = NOW() WHERE id = $1 RETURNING *', [user.id, plan.plan, plan.perks]);
}
