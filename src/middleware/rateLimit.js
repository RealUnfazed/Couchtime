'use strict';

const { HttpError } = require('../lib/errors');

// A small in-memory sliding window. On Vercel every warm function instance keeps its own
// counters, so this is a speed bump against spam, not a hard guarantee.
function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Slow down a little.' }) {
  const hits = new Map();
  let lastSweep = Date.now();

  return function limiter(req, _res, next) {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [k, arr] of hits) {
        if (!arr.length || now - arr[arr.length - 1] > windowMs) hits.delete(k);
      }
      lastSweep = now;
    }
    const k = key(req) || 'anon';
    const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return next(new HttpError(429, message, 'RATE_LIMITED'));
    arr.push(now);
    hits.set(k, arr);
    next();
  };
}

module.exports = { rateLimit };
