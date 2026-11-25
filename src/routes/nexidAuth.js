import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db.js';
import { HttpError, parse, route } from '../lib/http.js';
import { exchange, logoutUrl, revoke } from '../lib/nexid.js';
import { refreshPlan } from '../lib/plans.js';
import { signUserToken } from '../lib/tokens.js';
import { serializeMe } from './me.js';

// Sign-in only through Nex ID (OIDC + PKCE). The app opens Nex ID, gets a code at nexmap://auth
// and sends it here; Nexly and Nexgram use the same account (same `sub`).
const router = Router();

const schema = z.object({
  code: z.string().min(1).max(2000),
  codeVerifier: z.string().min(43).max(128),
  redirectUri: z.string().min(1).max(300),
});

function baseUsername(claims) {
  const raw = (claims.username || '').toLowerCase().replace(/[^a-z0-9_.]/g, '');
  return raw.length >= 3 ? raw.slice(0, 24) : `user_${claims.sub.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 10)}`;
}

async function freeUsername(claims) {
  const base = baseUsername(claims);
  for (let i = 0; i < 20; i += 1) {
    const candidate = i === 0 ? base : `${base}${Math.floor(Math.random() * 9000 + 1000)}`;
    if (!(await one('SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)', [candidate]))) return candidate;
  }
  throw new HttpError(503, 'username_unavailable', 'Could not pick a username');
}

export async function signInWithClaims({ claims, refreshToken }) {
  let user = await one('SELECT * FROM users WHERE nexid_sub = $1', [claims.sub]);
  if (user) {
    user = await one(
      `UPDATE users SET verification_level = $2, telegram_id = COALESCE($3, telegram_id),
         nexid_refresh = COALESCE($4, nexid_refresh) WHERE id = $1 RETURNING *`,
      [user.id, claims.verificationLevel, claims.telegramId, refreshToken],
    );
  } else {
    for (let attempt = 0; ; attempt += 1) {
      try {
        user = await one(
          `INSERT INTO users (name, username, nexid_sub, nexid_refresh, verification_level, telegram_id, avatar_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [claims.name || claims.username || 'Nex user', await freeUsername(claims), claims.sub, refreshToken,
            claims.verificationLevel, claims.telegramId, claims.picture],
        );
        break;
      } catch (err) {
        if (err.code === '23505' && attempt < 3) {
          const again = await one('SELECT * FROM users WHERE nexid_sub = $1', [claims.sub]);
          if (again) { user = again; break; }
          continue; // username raced
        }
        throw err;
      }
    }
  }
  return refreshPlan(user, { force: true });
}

router.post(
  '/nexid',
  route(async (req, res) => {
    const input = parse(schema, req.body);
    const user = await signInWithClaims(await exchange(input.code, input.codeVerifier, input.redirectUri));
    res.json({ token: signUserToken(user.id), user: serializeMe(user), logoutUrl: logoutUrl() });
  }),
);

router.post(
  '/logout',
  route(async (req, res) => {
    // Optional auth: the token tells whose Nex ID grant to end.
    const { verifyUserToken } = await import('../lib/tokens.js');
    const header = req.get('authorization') || '';
    const id = header.toLowerCase().startsWith('bearer ') ? verifyUserToken(header.slice(7).trim()) : null;
    if (id) {
      const user = await one('SELECT nexid_refresh FROM users WHERE id = $1', [id]);
      await revoke(user?.nexid_refresh);
      await query('UPDATE users SET nexid_refresh = NULL WHERE id = $1', [id]);
    }
    res.json({ logoutUrl: logoutUrl() });
  }),
);

export default router;
