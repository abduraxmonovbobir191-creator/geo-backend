import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new HttpError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message) => new HttpError(409, 'conflict', message);

// Lets route handlers be async without wrapping each one in try/catch.
export const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Parses input with a zod schema, turning failures into a 400 with per-field details.
export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    throw badRequest('Invalid request', details);
  }
  return result.data;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Path ids that are not UUIDs cannot exist, so they get a 404 instead of a database error.
export function idParam(value, what) {
  if (!UUID_RE.test(String(value))) throw notFound(what);
  return value;
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    err = badRequest('Invalid request');
  }
  if (err?.type === 'entity.parse.failed') {
    err = badRequest('Request body is not valid JSON');
  }
  if (err?.type === 'entity.too.large') {
    err = new HttpError(413, 'payload_too_large', 'Request body is too large');
  }
  if (err instanceof HttpError) {
    const body = { error: { code: err.code, message: err.message } };
    if (err.details) body.error.details = err.details;
    return res.status(err.status).json(body);
  }
  console.error(err);
  res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } });
}
