'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { parseCookies } = require('../lib/cookies');
const { HttpError } = require('../lib/errors');

const COOKIE = 'ct_session';
const MAX_AGE_MS = 60 * 24 * 3600 * 1000;

// "Me" is the identity of whoever is making a request: a registered user ("u:<id>") or a guest ("g:<id>").
// It lives in a signed cookie, so no database lookup is needed to know who is chatting or pressing play.
function sign(me) {
  return jwt.sign({ id: me.id, n: me.name, c: me.color }, config.jwtSecret, { expiresIn: Math.floor(MAX_AGE_MS / 1000) });
}

function verify(token) {
  if (!token || !config.jwtSecret) return null;
  try {
    const p = jwt.verify(token, config.jwtSecret);
    if (!p || typeof p.id !== 'string') return null;
    return { id: p.id, kind: p.id.startsWith('u:') ? 'user' : 'guest', name: p.n || 'Guest', color: p.c || '#ffb547' };
  } catch (_) {
    return null;
  }
}

function meFromCookies(cookies) {
  return verify(cookies[COOKIE]);
}

function setSession(req, res, me) {
  res.cookie(COOKIE, sign(me), {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!req.secure,
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

function attach(req, _res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  req.me = meFromCookies(req.cookies);
  next();
}

function requireMe(req, _res, next) {
  if (!req.me) return next(new HttpError(401, 'Pick a nickname first.', 'NO_SESSION'));
  next();
}

module.exports = { COOKIE, sign, verify, meFromCookies, setSession, clearSession, attach, requireMe };
