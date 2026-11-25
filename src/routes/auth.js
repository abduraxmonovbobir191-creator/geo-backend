import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { one } from '../db.js';
import { conflict, parse, route, unauthorized } from '../lib/http.js';
import { signUserToken } from '../lib/tokens.js';
import { serializeMe } from './me.js';

const router = Router();

const username = z
  .string()
  .trim()
  .min(3)
  .max(30)
  .regex(/^[a-zA-Z0-9_.]+$/, 'Only letters, digits, "_" and "."');

const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  username,
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(200),
});

const loginSchema = z.object({
  // Either the email or the username.
  login: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
});

router.post(
  '/register',
  route(async (req, res) => {
    const input = parse(registerSchema, req.body);
    const taken = await one(
      'SELECT LOWER(email) = LOWER($1) AS email_taken FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2) LIMIT 1',
      [input.email, input.username],
    );
    if (taken) throw conflict(taken.email_taken ? 'Email is already registered' : 'Username is taken');

    const hash = await bcrypt.hash(input.password, 10);
    let user;
    try {
      user = await one(
        `INSERT INTO users (name, username, email, password_hash)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [input.name, input.username, input.email, hash],
      );
    } catch (err) {
      // Two sign-ups racing for the same email or username.
      if (err.code === '23505') throw conflict('Email or username is already taken');
      throw err;
    }
    res.status(201).json({ token: signUserToken(user.id), user: serializeMe(user) });
  }),
);

router.post(
  '/login',
  route(async (req, res) => {
    const { login, password } = parse(loginSchema, req.body);
    const user = await one('SELECT * FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($1)', [
      login,
    ]);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      throw unauthorized('Wrong login or password');
    }
    res.json({ token: signUserToken(user.id), user: serializeMe(user) });
  }),
);

export default router;
