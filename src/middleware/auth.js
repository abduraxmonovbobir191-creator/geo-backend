import { one, query } from '../db.js';
import { forbidden, unauthorized } from '../lib/http.js';
import { API_KEY_PREFIX, hashApiKey, verifyUserToken } from '../lib/tokens.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function credentialsFrom(req) {
  const header = req.get('authorization') || '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
  const apiKey = req.get('x-api-key') || (bearer?.startsWith(API_KEY_PREFIX) ? bearer : null);
  if (apiKey) return { apiKey };
  if (bearer) return { token: bearer };
  return {};
}

/**
 * Resolves who is calling. Accepts either the app's JWT (`Authorization: Bearer <jwt>`)
 * or a developer API key (`X-API-Key: nex_...` or `Authorization: Bearer nex_...`).
 * Sets req.auth = { userId, kind: 'session' | 'api_key', scopes, keyId }.
 */
export async function resolveAuth(req) {
  const { apiKey, token } = credentialsFrom(req);
  if (apiKey) {
    const key = await one(
      'SELECT id, user_id, scopes FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL',
      [hashApiKey(apiKey)],
    );
    if (!key) return null;
    // Fire-and-forget: a failed timestamp update must not fail the request.
    query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [key.id]).catch(() => {});
    return { userId: key.user_id, kind: 'api_key', scopes: key.scopes, keyId: key.id };
  }
  if (token) {
    const userId = verifyUserToken(token);
    if (!userId) return null;
    const user = await one('SELECT id FROM users WHERE id = $1', [userId]);
    if (!user) return null;
    return { userId, kind: 'session', scopes: ['read', 'write'], keyId: null };
  }
  return null;
}

export async function authenticate(req, _res, next) {
  try {
    const auth = await resolveAuth(req);
    if (!auth) {
      const { apiKey, token } = credentialsFrom(req);
      throw unauthorized(apiKey || token ? 'Invalid or expired credentials' : 'Authentication required');
    }
    const needed = READ_METHODS.has(req.method) ? 'read' : 'write';
    if (!auth.scopes.includes(needed)) {
      throw forbidden(`This API key lacks the "${needed}" scope`);
    }
    req.auth = auth;
    next();
  } catch (err) {
    next(err);
  }
}

// For account-level actions (managing API keys, password) that an API key must never perform.
export function sessionOnly(req, _res, next) {
  if (req.auth?.kind !== 'session') {
    return next(forbidden('This endpoint requires signing in with the app, not an API key'));
  }
  next();
}
