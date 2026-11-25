// Nex ID (OIDC) client: code exchange with PKCE, refresh, revoke, logout URL and Nex Premium.
// Same contract as Nexly's app/nexid.py. Tests replace `transport.call`.
import { config } from '../config.js';
import { HttpError } from './http.js';

export const transport = {
  async call(url, init) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  },
};

export const nexidEnabled = () => Boolean(config.nexid.issuer && config.nexid.clientId && config.nexid.clientSecret);

function issuer() {
  const { issuer: iss } = config.nexid;
  if (!nexidEnabled() || !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost))/.test(iss)) {
    throw new HttpError(503, 'nexid_not_configured', 'Nex ID sign-in is not configured');
  }
  return iss;
}

async function call(path, init) {
  let result;
  try {
    result = await transport.call(`${issuer()}${path}`, init);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, 'nexid_unavailable', 'Nex ID is not reachable');
  }
  if (result.status === 400 || result.status === 401) throw new HttpError(401, 'nexid_failed', 'Nex ID refused the sign-in');
  if (result.status >= 400 || typeof result.data !== 'object' || result.data === null) {
    throw new HttpError(503, 'nexid_unavailable', 'Nex ID is not reachable');
  }
  return result.data;
}

function basic() {
  const enc = encodeURIComponent;
  return 'Basic ' + Buffer.from(`${enc(config.nexid.clientId)}:${enc(config.nexid.clientSecret)}`).toString('base64');
}

const post = (path, form) =>
  call(path, {
    method: 'POST',
    headers: { authorization: basic(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });

export function claimsFrom(info) {
  const sub = String(info.sub ?? '');
  if (!sub || sub.length > 64) throw new HttpError(401, 'nexid_failed', 'Nex ID refused the sign-in');
  const tg = Number(info.telegram_id);
  const level = Math.max(0, Math.min(3, Number.parseInt(info.verification_level ?? 0, 10) || 0));
  const name = String(info.name || [info.given_name, info.family_name].filter(Boolean).join(' ') || '').slice(0, 80);
  return {
    sub,
    telegramId: Number.isSafeInteger(tg) && tg > 0 ? tg : null,
    name,
    username: info.telegram_username ? String(info.telegram_username).slice(0, 30) : null,
    picture: typeof info.picture === 'string' && info.picture.startsWith('https://') ? info.picture : null,
    verificationLevel: level,
  };
}

async function grant(token) {
  if (typeof token.access_token !== 'string' || !token.access_token) {
    throw new HttpError(401, 'nexid_failed', 'Nex ID refused the sign-in');
  }
  const info = await call('/oauth/userinfo', { headers: { authorization: `Bearer ${token.access_token}` } });
  const refresh = typeof token.refresh_token === 'string' && token.refresh_token ? token.refresh_token : null;
  return { claims: claimsFrom(info), refreshToken: refresh };
}

export function exchange(code, verifier, redirectUri) {
  if (!config.nexid.redirectUris.includes(redirectUri)) {
    throw new HttpError(401, 'nexid_invalid_redirect', 'This redirect address is not allowed');
  }
  return post('/oauth/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  }).then(grant);
}

// Fresh claims (verification_level) now. 401 nexid_failed: the grant is gone.
export const refresh = (refreshToken) => post('/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken }).then(grant);

// Best effort: signing out here also ends this server's Nex ID grant.
export async function revoke(refreshToken) {
  if (!refreshToken || !nexidEnabled()) return;
  await post('/oauth/revoke', { token: refreshToken, token_type_hint: 'refresh_token' }).catch(() => {});
}

export function logoutUrl() {
  if (!nexidEnabled()) return null;
  const q = new URLSearchParams({ client_id: config.nexid.clientId, post_logout_redirect_uri: config.nexid.postLogoutUri });
  return `${config.nexid.issuer}/oauth/logout?${q}`;
}

// Nex Premium from Nex ID (one subscription for every Nex product). null when Nex ID cannot answer.
export async function fetchPlan(sub) {
  if (!nexidEnabled()) return null;
  try {
    const data = await post('/api/partner/plan', { sub });
    return data.found ? { plan: String(data.plan || 'free'), perks: Array.isArray(data.perks) ? data.perks.map(String) : [] } : { plan: 'free', perks: [] };
  } catch {
    return null;
  }
}
