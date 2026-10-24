'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const { connectDB } = require('./db');
const { HttpError } = require('./lib/errors');
const { attach } = require('./middleware/auth');
const { rateLimit } = require('./middleware/rateLimit');
const misc = require('./routes/misc');
const authRoutes = require('./routes/auth');
const roomRoutes = require('./routes/rooms');

const PUBLIC = path.join(__dirname, '..', 'public');
const app = express();

app.set('trust proxy', 1); // behind Vercel / nginx / Render: lets req.secure and req.ip be correct
app.disable('x-powered-by');

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Screen share, mic and camera are used by this origin only.
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), autoplay=*, fullscreen=*');
  next();
});

// ---------- API ----------

const api = express.Router();
api.use(express.json({ limit: '20kb' }));
api.use((req, _res, next) => { req.body = req.body || {}; next(); });
api.use(attach);

// Browsers always send Origin on cross-site POSTs. Refuse anything not coming from our own pages.
api.use((req, _res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.headers.host; } catch (_) { ok = false; }
    if (!ok) return next(new HttpError(403, 'Cross-site request blocked.', 'BAD_ORIGIN'));
  }
  next();
});

// Every JSON object carries the server clock so the browser can line its own clock up with it.
api.use((_req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === 'object' && !Array.isArray(body) && body.serverTime === undefined) body.serverTime = Date.now();
    return json(body);
  };
  next();
});

api.use(rateLimit({ windowMs: 60_000, max: 600, message: 'Too many requests from your network. Wait a moment.' }));
api.use(misc.open);

api.use((_req, _res, next) => {
  if (!config.jwtSecret) return next(new HttpError(500, 'Server setup is incomplete: JWT_SECRET is not set. Open /api/health for details.', 'MISCONFIGURED'));
  next();
});

api.use(async (_req, _res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error('[db] connection failed:', err.message);
    next(new HttpError(503, 'The database is unreachable. Check MONGODB_URI (open /api/health for details).', 'DB_DOWN'));
  }
});

api.use(misc.needsDb);
api.use('/auth', authRoutes);
api.use('/rooms', roomRoutes);

api.use((_req, _res, next) => next(new HttpError(404, 'Not found.', 'NOT_FOUND')));

// eslint-disable-next-line no-unused-vars
api.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.', code: 'BAD_JSON' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.', code: 'TOO_LARGE' });
  console.error('[api] unhandled error:', err);
  res.status(500).json({
    error: 'Something went wrong on our side.',
    code: 'SERVER_ERROR',
    ...(config.isProd ? {} : { detail: err && err.message }),
  });
});

app.use('/api', api);

// ---------- static files (local / VPS). On Vercel the CDN serves /public and these never run. ----------

app.use(express.static(PUBLIC, { maxAge: config.isProd ? '5m' : 0, extensions: ['html'] }));
app.get('/r/:id', (_req, res) => res.sendFile(path.join(PUBLIC, 'room.html')));

module.exports = app;
