'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Room = require('../models/Room');
const { HttpError } = require('../lib/errors');
const { uuid, randomColor, isColor, cleanName } = require('../lib/ids');
const { setSession, clearSession, requireMe } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
const authLimit = rateLimit({ windowMs: 60_000, max: 12, message: 'Too many attempts. Try again in a minute.' });
// Guests are cheap and a whole classroom or office can share one IP address, so this one is much looser.
const guestLimit = rateLimit({ windowMs: 60_000, max: 90, message: 'Too many people joined from your network at once. Try again in a minute.' });

const publicMe = (me) => ({ id: me.id, kind: me.kind, name: me.name, color: me.color });

// Rooms made as a guest follow you into your account when you sign up or sign in on the same browser.
async function adoptGuestRooms(oldMe, newMe) {
  if (oldMe && oldMe.kind === 'guest') {
    await Room.updateMany({ 'owner.id': oldMe.id }, { $set: { 'owner.id': newMe.id, 'owner.name': newMe.name } });
  }
}

router.get('/me', (req, res) => {
  res.json({ me: req.me ? publicMe(req.me) : null });
});

// Guests need no account: a nickname is enough to join a room or start one.
router.post('/guest', guestLimit, (req, res) => {
  const name = cleanName(req.body.name);
  if (!name) throw new HttpError(400, 'Type a nickname to continue.');
  let me = req.me;
  if (!me || me.kind !== 'guest') me = { id: `g:${uuid()}`, kind: 'guest', color: randomColor() };
  me = { ...me, name };
  setSession(req, res, me);
  res.json({ me: publicMe(me) });
});

router.post('/register', authLimit, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username)) throw new HttpError(400, 'Username: 3 to 24 letters, numbers, dots, dashes or underscores.');
  if (password.length < 8 || password.length > 128) throw new HttpError(400, 'Password must be 8 to 128 characters.');
  const displayName = cleanName(req.body.displayName) || (req.me && req.me.name) || username;

  const passwordHash = await bcrypt.hash(password, 10);
  let user;
  try {
    user = await User.create({
      username, usernameLower: username.toLowerCase(), displayName, passwordHash,
      color: (req.me && req.me.color) || randomColor(),
    });
  } catch (err) {
    if (err && err.code === 11000) throw new HttpError(409, 'That username is taken.');
    throw err;
  }
  const me = { id: `u:${user._id}`, kind: 'user', name: user.displayName, color: user.color };
  await adoptGuestRooms(req.me, me);
  setSession(req, res, me);
  res.status(201).json({ me: publicMe(me) });
});

router.post('/login', authLimit, async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = await User.findOne({ usernameLower: username });
  // Same error and similar timing whether the user exists or not.
  const hash = user ? user.passwordHash : '$2a$10$abcdefghijklmnopqrstuuMkB1zX0m7QyT1uU9mE3mQJdPZk8b0yS';
  const ok = await bcrypt.compare(password, hash);
  if (!user || !ok) throw new HttpError(401, 'Wrong username or password.');
  const me = { id: `u:${user._id}`, kind: 'user', name: user.displayName, color: user.color };
  await adoptGuestRooms(req.me, me);
  setSession(req, res, me);
  res.json({ me: publicMe(me) });
});

router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

router.patch('/profile', requireMe, async (req, res) => {
  const name = cleanName(req.body.name);
  const color = req.body.color;
  const me = { ...req.me };
  if (name) me.name = name;
  if (isColor(color)) me.color = color;
  if (me.kind === 'user') {
    await User.updateOne({ _id: me.id.slice(2) }, { $set: { displayName: me.name, color: me.color } });
  }
  setSession(req, res, me);
  res.json({ me: publicMe(me) });
});

module.exports = router;
