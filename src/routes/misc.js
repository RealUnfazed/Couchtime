'use strict';

const express = require('express');
const mongoose = require('mongoose');
const config = require('../config');
const realtime = require('../realtime');
const Room = require('../models/Room');
const { connectDB } = require('../db');
const { HttpError } = require('../lib/errors');
const { checkAccess } = require('../lib/access');
const { getIceServers } = require('../lib/ice');
const { requireMe } = require('../middleware/auth');

// Routes that need no database.
const open = express.Router();

open.get('/config', (_req, res) => {
  res.json({
    appName: config.appName,
    realtime: { driver: config.realtime.driver },
    turn: !!config.ice.turnProvider,
  });
});

open.get('/time', (_req, res) => res.json({ ok: true }));

// Open this in a browser after deploying to see what is (not) configured.
open.get('/health', async (_req, res) => {
  let db = 'ok';
  try { await connectDB(); } catch (err) { db = `error: ${err.message}`; }
  res.json({
    ok: db === 'ok' && !config.problems().length,
    db,
    dbState: mongoose.connection.readyState,
    realtime: config.realtime.driver,
    turn: config.ice.turnProvider || 'none (STUN only)',
    problems: config.problems(),
  });
});

// Routes that need the database.
const needsDb = express.Router();

// ICE servers for WebRTC voice, camera and screen share.
needsDb.get('/ice', requireMe, async (req, res) => {
  res.json(await getIceServers(req.me));
});

// Ably only: hands the browser a short-lived, room-scoped token. The API key itself never leaves the server.
needsDb.get('/rt/auth', requireMe, async (req, res) => {
  if (config.realtime.driver !== 'ably') throw new HttpError(404, 'Not using the Ably driver.');
  const room = await Room.findById(String(req.query.room || '').toLowerCase()).lean();
  if (!room) throw new HttpError(404, 'This room does not exist or has expired.', 'NO_ROOM');
  const access = checkAccess(room, req.me, req.cookies);
  if (!access.ok) throw new HttpError(access.reason === 'banned' ? 403 : 401, 'No access to this room.', access.reason.toUpperCase());
  res.json(await realtime.createToken(req.me, room._id));
});

module.exports = { open, needsDb };
