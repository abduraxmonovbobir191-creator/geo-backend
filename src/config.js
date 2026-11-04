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
  geocoderUserAgent: env.GEOCODER_USER_AGENT || 'NexMap/0.1 (self-hosted)',
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
