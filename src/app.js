import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { config } from './config.js';
import { pool } from './db.js';
import { errorHandler, notFoundHandler, route } from './lib/http.js';
import { API_KEY_PREFIX, hashApiKey } from './lib/tokens.js';
import { authenticate } from './middleware/auth.js';
import { openApiSpec } from './openapi.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import userRoutes from './routes/users.js';
import friendRoutes from './routes/friends.js';
import activityRoutes, { listUserActivities } from './routes/activities.js';
import placeRoutes from './routes/places.js';
import geocodeRoutes from './routes/geocode.js';
import messageRoutes from './routes/messages.js';
import apiKeyRoutes from './routes/apiKeys.js';

function apiKeyFrom(req) {
  const key = req.get('x-api-key');
  if (key) return key;
  const header = req.get('authorization') || '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  return bearer.startsWith(API_KEY_PREFIX) ? bearer : null;
}

const rateLimitMessage = { error: { code: 'rate_limited', message: 'Too many requests, slow down' } };

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Swagger UI needs inline scripts, so the default CSP is relaxed only for the docs page.
  app.use('/docs', helmet({ contentSecurityPolicy: false }));
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') }));
  // Activities can carry tens of thousands of GPS points.
  app.use(express.json({ limit: '5mb' }));

  app.get('/', (_req, res) => {
    res.json({ name: 'Nex Map API', version: 'v1', docs: '/docs', openapi: '/openapi.json' });
  });
  app.get(
    '/health',
    route(async (_req, res) => {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    }),
  );
  app.get('/openapi.json', (_req, res) => res.json(openApiSpec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, { customSiteTitle: 'Nex Map API' }));

  const v1 = express.Router();

  // Third-party API keys get a tighter budget than the app's own users; limits are per key
  // for API clients and per IP otherwise.
  v1.use(
    rateLimit({
      windowMs: config.rateLimit.windowMs,
      limit: (req) => (apiKeyFrom(req) ? config.rateLimit.apiKeyMax : config.rateLimit.defaultMax),
      keyGenerator: (req) => {
        const key = apiKeyFrom(req);
        return key ? `key:${hashApiKey(key)}` : `ip:${req.ip}`;
      },
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: rateLimitMessage,
    }),
  );

  v1.use(
    '/auth',
    rateLimit({
      windowMs: config.rateLimit.windowMs,
      limit: config.rateLimit.authMax,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: rateLimitMessage,
    }),
    authRoutes,
  );

  v1.use(authenticate);
  v1.use('/me', meRoutes);
  v1.get('/users/:id/activities', route(listUserActivities));
  v1.use('/users', userRoutes);
  v1.use('/friends', friendRoutes);
  v1.use('/activities', activityRoutes);
  v1.use('/places', placeRoutes);
  v1.use('/geocode', geocodeRoutes);
  v1.use('/messages', messageRoutes);
  v1.use('/api-keys', apiKeyRoutes);

  app.use('/v1', v1);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
