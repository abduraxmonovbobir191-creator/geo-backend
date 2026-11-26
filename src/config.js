import 'dotenv/config';

const env = process.env;

function required(name, fallback) {
  const value = env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

const isProduction = env.NODE_ENV === 'production';

export const config = {
  env: env.NODE_ENV || 'development',
  isProduction,
  port: Number(env.PORT || 3000),
  databaseUrl: required('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/nexmap'),
  // In production a real secret must be provided; in development a fixed one keeps tokens valid across restarts.
  jwtSecret: isProduction ? required('JWT_SECRET') : env.JWT_SECRET || 'dev-only-secret-change-me',
  jwtExpiresIn: env.JWT_EXPIRES_IN || '30d',
  corsOrigin: env.CORS_ORIGIN || '*',
  geocoderUrl: env.GEOCODER_URL || 'https://nominatim.openstreetmap.org',
  // Asked when the main geocoder is down or finds nothing, e.g. an own server that only
  // covers one country, backed by the public OpenStreetMap server for the rest of the world.
  geocoderFallbackUrl: env.GEOCODER_FALLBACK_URL || null,
  geocoderUserAgent: env.GEOCODER_USER_AGENT || 'NexMap/0.1 (self-hosted)',
  // Nex ID (OIDC + PKCE): the only sign-in of the Nex ecosystem. The secret stays on this server.
  nexid: {
    issuer: (env.NEXID_ISSUER || '').replace(/\/+$/, ''),
    clientId: env.NEXID_CLIENT_ID || '',
    clientSecret: env.NEXID_CLIENT_SECRET || '',
    redirectUris: (env.NEXID_REDIRECT_URIS || 'nexmap://auth').split(',').map((s) => s.trim()).filter(Boolean),
    postLogoutUri: env.NEXID_POST_LOGOUT_URI || 'nexmap://logout',
    planCacheMinutes: Number(env.PLAN_CACHE_MINUTES || 30),
    premiumUrl: env.PREMIUM_URL || 'https://id.nexecos.com/account/premium',
  },
  // Old e-mail + password accounts: on in development and tests, off in production unless asked for.
  legacyPasswordLogin: (env.LEGACY_PASSWORD_LOGIN ?? (isProduction ? '0' : '1')) === '1',
  // Other Nex products (Nexly, Nexgram, Nex ID) call /internal/v1 with `X-Service-Key` + `X-Nexid-Sub`.
  // SERVICE_KEYS=nexly:<key>,nexgramm:<key>  (never exposed publicly, never the user's token).
  serviceKeys: Object.fromEntries(
    (env.SERVICE_KEYS || '')
      .split(',')
      .map((p) => p.trim().split(':'))
      .filter((p) => p.length === 2 && p[0] && p[1]),
  ),
  // Which services may open a Nex Map session for a person they already signed in (Nexly's Nex Map tab). Never the user's token.
  sessionServices: (env.SESSION_SERVICES || 'nexly').split(',').map((s) => s.trim()).filter(Boolean),
  // Alert kinds this server does not allow (e.g. camera,police where such posts are banned by law)
  alertDisabledKinds: (env.ALERT_DISABLED_KINDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  // Own Valhalla routing server (deploy/planet). Without it /v1/route answers 503 routing_unavailable.
  routingUrl: (env.ROUTING_URL || '').replace(/\/+$/, ''),
  rateLimit: {
    windowMs: Number(env.RATE_LIMIT_WINDOW_MS || 60_000),
    // Requests per window for API-key clients (third-party developers).
    apiKeyMax: Number(env.RATE_LIMIT_API_KEY_MAX || 120),
    // Requests per window for the app's own users and anonymous callers.
    defaultMax: Number(env.RATE_LIMIT_DEFAULT_MAX || 600),
    // Login/register attempts per window per IP, to slow down password guessing.
    authMax: Number(env.RATE_LIMIT_AUTH_MAX || 30),
  },
};
