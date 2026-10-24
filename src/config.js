'use strict';

// Load .env for local development. On Vercel the variables come from the project settings.
try { require('dotenv').config({ quiet: true }); } catch (_) { /* dotenv is optional */ }

const env = process.env;
const isVercel = !!env.VERCEL;
const isProd = env.NODE_ENV === 'production' || isVercel;

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// Vercel cannot hold WebSocket connections, so it defaults to Ably (hosted realtime, free tier).
// Everywhere else (your laptop, a VPS, Render, Railway...) it defaults to Socket.IO.
const driver = String(env.REALTIME_DRIVER || (isVercel ? 'ably' : 'socketio')).toLowerCase();

const config = {
  appName: env.APP_NAME || 'Couchtime',
  port: int(env.PORT, 3000),
  isVercel,
  isProd,

  mongoUri: env.MONGODB_URI || 'mongodb://127.0.0.1:27017/couchtime',
  // A fixed fallback keeps local sessions alive across restarts. Production requires a real secret.
  jwtSecret: env.JWT_SECRET || (isProd ? '' : 'dev-only-secret-change-me'),

  realtime: {
    driver,
    ablyKey: env.ABLY_API_KEY || '',
  },

  ice: {
    stun: list(env.STUN_URLS).length
      ? list(env.STUN_URLS)
      : ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'],
    // cloudflare | metered | static | coturn | (empty = STUN only)
    turnProvider: String(env.TURN_PROVIDER || '').toLowerCase(),
    cloudflare: { keyId: env.CF_TURN_KEY_ID || '', apiToken: env.CF_TURN_API_TOKEN || '' },
    metered: { app: env.METERED_APP || '', apiKey: env.METERED_API_KEY || '' },
    staticTurn: { urls: list(env.TURN_URLS), username: env.TURN_USERNAME || '', credential: env.TURN_CREDENTIAL || '' },
    coturn: { urls: list(env.TURN_URLS), secret: env.TURN_SECRET || '' },
  },

  limits: {
    roomIdleHours: int(env.ROOM_IDLE_HOURS, 24),   // temporary rooms are deleted after this much inactivity
    chatKeepDays: int(env.CHAT_KEEP_DAYS, 7),      // chat history is deleted after this many days
    chatMaxLength: 500,
    playlistMax: 50,
    historyOnJoin: 80,
  },
};

// Human readable list of what is missing, shown by /api/health so first-time setup is easy.
config.problems = function problems() {
  const out = [];
  if (!config.jwtSecret) out.push('JWT_SECRET is not set (use a long random string).');
  if (isVercel && !env.MONGODB_URI) out.push('MONGODB_URI is not set (use a MongoDB Atlas connection string).');
  if (driver === 'ably' && !config.realtime.ablyKey) out.push('ABLY_API_KEY is not set (the Ably driver needs it).');
  if (driver === 'socketio' && isVercel) out.push('REALTIME_DRIVER=socketio cannot run on Vercel. Use ably.');
  if (!['ably', 'socketio'].includes(driver)) out.push(`Unknown REALTIME_DRIVER "${driver}" (use socketio or ably).`);
  const t = config.ice.turnProvider;
  if (t === 'cloudflare' && !(config.ice.cloudflare.keyId && config.ice.cloudflare.apiToken)) out.push('TURN_PROVIDER=cloudflare needs CF_TURN_KEY_ID and CF_TURN_API_TOKEN.');
  if (t === 'metered' && !(config.ice.metered.app && config.ice.metered.apiKey)) out.push('TURN_PROVIDER=metered needs METERED_APP and METERED_API_KEY.');
  if (t === 'static' && !(config.ice.staticTurn.urls.length && config.ice.staticTurn.username)) out.push('TURN_PROVIDER=static needs TURN_URLS, TURN_USERNAME and TURN_CREDENTIAL.');
  if (t === 'coturn' && !(config.ice.coturn.urls.length && config.ice.coturn.secret)) out.push('TURN_PROVIDER=coturn needs TURN_URLS and TURN_SECRET.');
  return out;
};

module.exports = config;
