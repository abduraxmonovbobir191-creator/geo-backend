import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function signUserToken(userId) {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

// Returns the user id, or null if the token is invalid or expired.
export function verifyUserToken(token) {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export const API_KEY_PREFIX = 'nex_';

export function generateApiKey() {
  const key = API_KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
  // The visible prefix lets users tell their keys apart without storing the key itself.
  return { key, prefix: key.slice(0, 12), hash: hashApiKey(key) };
}

export function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}
