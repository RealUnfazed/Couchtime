'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const realtime = require('../realtime');
const Room = require('../models/Room');
const Message = require('../models/Message');
const { HttpError } = require('../lib/errors');
const { randomId, uuid, cleanName } = require('../lib/ids');
const { parseMedia, resolveTitle } = require('../lib/media');
const {
  roomCookie, roleOf, canControl, signRoomPass, checkAccess,
  publicRoom, publicState, publicPlaylist,
} = require('../lib/access');
const { requireMe } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
const IDLE_MS = config.limits.roomIdleHours * 3600 * 1000;
const RESERVED = new Set(['new', 'api', 'r', 'admin', 'login', 'register', 'static', 'assets', 'js', 'css']);

const byUser = (req) => (req.me ? req.me.id : req.ip);
const createLimit = rateLimit({ windowMs: 60_000, max: 10, key: byUser, message: 'You are creating rooms too fast.' });
const chatLimit = rateLimit({ windowMs: 10_000, max: 10, key: byUser, message: 'You are sending messages too fast.' });
const actionLimit = rateLimit({ windowMs: 5_000, max: 25, key: byUser });
const joinLimit = rateLimit({ windowMs: 60_000, max: 10, message: 'Too many password attempts. Wait a minute.' });

// ---------- helpers ----------

async function loadRoom(req, _res, next) {
  const room = await Room.findById(String(req.params.id || '').toLowerCase());
  if (!room) throw new HttpError(404, 'This room does not exist or has expired.', 'NO_ROOM');
  req.room = room;
  next();
}

function needAccess(req, _res, next) {
  const a = checkAccess(req.room, req.me, req.cookies);
  if (a.ok) return next();
  if (a.reason === 'banned') throw new HttpError(403, 'You were removed from this room.', 'BANNED');
  if (a.reason === 'password') throw new HttpError(401, 'This room needs a password.', 'PASSWORD');
  throw new HttpError(401, 'Pick a nickname first.', 'NO_SESSION');
}

function needRole(...roles) {
  return (req, _res, next) => {
    if (!roles.includes(roleOf(req.room, req.me))) throw new HttpError(403, 'You do not have permission to do that.', 'FORBIDDEN');
    next();
  };
}

function needControl(req, _res, next) {
  if (!canControl(req.room, req.me)) {
    const who = req.room.control === 'host' ? 'the host' : 'the host and moderators';
    throw new HttpError(403, `Only ${who} can do that in this room.`, 'NO_CONTROL');
  }
  next();
}

const touchFields = (room) => (room.permanent ? {} : { expireAt: new Date(Date.now() + IDLE_MS) });

// Publishing must never fail an action that already succeeded in the database.
async function emit(roomId, name, data) {
  try {
    await realtime.publish(roomId, name, data);
    return true;
  } catch (err) {
    console.error(`[realtime] publish "${name}" failed:`, err.message);
    return false;
  }
}

const expectedPosition = (s, now = Date.now()) =>
  s.playing ? s.position + ((now - new Date(s.updatedAt).getTime()) / 1000) * (s.rate || 1) : s.position;

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 3 * 86400 ? n : fallback;
};

function loadFields(media, title) {
  return {
    'state.provider': media.provider,
    'state.mediaId': media.mediaId,
    'state.url': media.url,
    'state.title': title,
    'state.playing': true,
    'state.position': media.start || 0,
    'state.rate': 1,
    'state.updatedAt': new Date(),
  };
}

// Applies a change to the shared player with optimistic concurrency: two people pressing buttons at the
// same instant cannot corrupt each other's write, the loser re-reads and tries again.
async function mutateState(roomId, build) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const room = await Room.findById(roomId);
    if (!room) throw new HttpError(404, 'This room does not exist or has expired.', 'NO_ROOM');
    const plan = await build(room);
    if (!plan) return { room, changed: false };

    const filter = { _id: roomId, 'state.version': room.state.version };
    if (plan.guardHeadId) filter['playlist.0.id'] = plan.guardHeadId;
    const update = { $set: { ...plan.set, ...touchFields(room) }, $inc: { 'state.version': 1 } };
    if (plan.popHead) update.$pop = { playlist: -1 };
    if (plan.pullId) update.$pull = { playlist: { id: plan.pullId } };

    const updated = await Room.findOneAndUpdate(filter, update, { returnDocument: 'after' });
    if (updated) return { room: updated, changed: true, plan };
  }
  throw new HttpError(409, 'The room was busy. Try again.', 'BUSY');
}

const toChat = (m) => ({
  id: String(m._id), kind: 'chat', text: m.text,
  author: { id: m.author.id, name: m.author.name, color: m.author.color },
  createdAt: new Date(m.createdAt).getTime(),
});

// ---------- list my rooms ----------

router.get('/mine', requireMe, async (req, res) => {
  const rooms = await Room.find({ 'owner.id': req.me.id }).sort({ createdAt: -1 }).limit(30).lean();
  res.json({
    rooms: rooms.map((r) => ({
      id: r._id, name: r.name, permanent: !!r.permanent, locked: !!r.passwordHash, title: r.state && r.state.title || '',
    })),
  });
});

// ---------- create ----------

router.post('/', requireMe, createLimit, async (req, res) => {
  const me = req.me;
  const name = cleanName(req.body.name, 40) || `${me.name}'s room`;
  const control = ['everyone', 'mods', 'host'].includes(req.body.control) ? req.body.control : 'everyone';
  const password = String(req.body.password || '');
  if (password && (password.length < 3 || password.length > 64)) throw new HttpError(400, 'Room password: 3 to 64 characters.');
  const permanent = me.kind === 'user' && req.body.permanent === true;

  let id = '';
  const slug = String(req.body.slug || '').trim().toLowerCase();
  if (slug) {
    if (me.kind !== 'user') throw new HttpError(403, 'Create a free account to pick a custom room address.', 'NEEDS_ACCOUNT');
    if (!/^[a-z0-9][a-z0-9-]{2,29}$/.test(slug) || RESERVED.has(slug)) throw new HttpError(400, 'Room address: 3 to 30 letters, numbers or dashes.');
    id = slug;
  }

  const doc = {
    name, control,
    owner: { id: me.id, name: me.name },
    passwordHash: password ? await bcrypt.hash(password, 8) : '',
    permanent,
    ...(permanent ? {} : { expireAt: new Date(Date.now() + IDLE_MS) }),
  };

  for (let i = 0; i < 6; i++) {
    const _id = id || randomId(8);
    try {
      const room = await Room.create({ ...doc, _id });
      return res.status(201).json({ room: publicRoom(room) });
    } catch (err) {
      if (err && err.code === 11000) {
        if (id) throw new HttpError(409, 'That room address is already taken.');
        continue;
      }
      throw err;
    }
  }
  throw new HttpError(500, 'Could not allocate a room code. Try again.');
});

// ---------- read ----------

router.get('/:id', loadRoom, async (req, res) => {
  const room = req.room;
  const access = checkAccess(room, req.me, req.cookies);
  if (!access.ok && access.reason === 'banned') throw new HttpError(403, 'You were removed from this room.', 'BANNED');
  if (!access.ok) {
    return res.json({
      access: false,
      reason: access.reason,
      room: { id: room._id, name: room.name, ownerName: room.owner.name, locked: !!room.passwordHash },
    });
  }

  // Keep a temporary room alive while people use it (at most one write per hour per room).
  if (!room.permanent && room.expireAt && room.expireAt.getTime() - Date.now() < IDLE_MS - 3600 * 1000) {
    await Room.updateOne({ _id: room._id }, { $set: touchFields(room) });
  }

  const history = await Message.find({ room: room._id }).sort({ createdAt: -1 }).limit(config.limits.historyOnJoin).lean();
  res.json({
    access: true,
    room: publicRoom(room),
    role: roleOf(room, req.me),
    canControl: canControl(room, req.me),
    state: publicState(room.state),
    playlist: publicPlaylist(room.playlist),
    messages: history.reverse().map(toChat),
  });
});

// Enter a password-protected room.
router.post('/:id/join', requireMe, joinLimit, loadRoom, async (req, res) => {
  const room = req.room;
  if ((room.banned || []).includes(req.me.id)) throw new HttpError(403, 'You were removed from this room.', 'BANNED');
  if (room.passwordHash && roleOf(room, req.me) !== 'owner') {
    const ok = await bcrypt.compare(String(req.body.password || ''), room.passwordHash);
    if (!ok) throw new HttpError(401, 'Wrong room password.', 'PASSWORD');
    res.cookie(roomCookie(room._id), signRoomPass(room, req.me), {
      httpOnly: true, sameSite: 'lax', secure: !!req.secure, maxAge: 7 * 24 * 3600 * 1000, path: '/',
    });
  }
  res.json({ ok: true });
});

// ---------- settings (owner) ----------

router.patch('/:id', requireMe, loadRoom, needRole('owner'), async (req, res) => {
  const room = req.room;
  const set = {};
  const unset = {};

  if (req.body.name !== undefined) {
    const name = cleanName(req.body.name, 40);
    if (!name) throw new HttpError(400, 'Room name cannot be empty.');
    set.name = name;
  }
  if (req.body.control !== undefined) {
    if (!['everyone', 'mods', 'host'].includes(req.body.control)) throw new HttpError(400, 'Unknown control mode.');
    set.control = req.body.control;
  }
  if (req.body.password !== undefined) {
    const pw = String(req.body.password);
    if (pw === '') set.passwordHash = '';
    else {
      if (pw.length < 3 || pw.length > 64) throw new HttpError(400, 'Room password: 3 to 64 characters.');
      set.passwordHash = await bcrypt.hash(pw, 8);
    }
  }
  if (req.body.permanent !== undefined) {
    if (req.me.kind !== 'user') throw new HttpError(403, 'Create a free account to keep a room forever.', 'NEEDS_ACCOUNT');
    set.permanent = !!req.body.permanent;
    if (set.permanent) unset.expireAt = '';
    else set.expireAt = new Date(Date.now() + IDLE_MS);
  }

  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  const updated = Object.keys(update).length
    ? await Room.findByIdAndUpdate(room._id, update, { returnDocument: 'after' })
    : room;

  const delivered = await emit(room._id, 'room', { room: publicRoom(updated) });
  res.json({ room: publicRoom(updated), delivered });
});

router.delete('/:id', requireMe, loadRoom, needRole('owner'), async (req, res) => {
  await Room.deleteOne({ _id: req.room._id });
  await Message.deleteMany({ room: req.room._id });
  await emit(req.room._id, 'closed', {});
  res.json({ ok: true });
});

// ---------- people ----------

router.post('/:id/mods', requireMe, loadRoom, needRole('owner'), async (req, res) => {
  const uid = String(req.body.uid || '');
  if (!/^[ug]:[\w-]{8,}$/.test(uid) || uid === req.room.owner.id) throw new HttpError(400, 'Pick someone else in the room.');
  const updated = await Room.findByIdAndUpdate(
    req.room._id,
    req.body.mod ? { $addToSet: { mods: uid } } : { $pull: { mods: uid } },
    { returnDocument: 'after' }
  );
  const delivered = await emit(req.room._id, 'room', { room: publicRoom(updated) });
  res.json({ room: publicRoom(updated), delivered });
});

router.post('/:id/kick', requireMe, loadRoom, needRole('owner', 'mod'), async (req, res) => {
  const room = req.room;
  const uid = String(req.body.uid || '');
  if (!/^[ug]:[\w-]{8,}$/.test(uid)) throw new HttpError(400, 'Pick someone in the room.');
  if (uid === room.owner.id) throw new HttpError(403, 'The host cannot be removed.');
  if (uid === req.me.id) throw new HttpError(400, 'You cannot remove yourself. Just leave.');
  if (room.mods.includes(uid) && roleOf(room, req.me) !== 'owner') throw new HttpError(403, 'Only the host can remove a moderator.');

  const updated = await Room.findByIdAndUpdate(
    room._id,
    { $addToSet: { banned: uid }, $pull: { mods: uid } },
    { returnDocument: 'after' }
  );
  await emit(room._id, 'kick', { uid, by: req.me.name });
  await emit(room._id, 'room', { room: publicRoom(updated) });
  await realtime.kick(room._id, uid).catch(() => {});
  res.json({ ok: true });
});

router.post('/:id/unban-all', requireMe, loadRoom, needRole('owner'), async (req, res) => {
  await Room.updateOne({ _id: req.room._id }, { $set: { banned: [] } });
  res.json({ ok: true });
});

// ---------- shared player ----------

router.post('/:id/state', requireMe, actionLimit, loadRoom, needAccess, async (req, res) => {
  const action = String(req.body.action || '');
  const me = req.me;
  const body = req.body;

  // Anybody in the room may report that the video ended. Everything else needs control rights.
  if (action !== 'ended') needControl(req, res, () => {});

  const result = await mutateState(req.room._id, async (room) => {
    const s = room.state;
    const now = Date.now();
    const exp = expectedPosition(s, now);
    const at = new Date(now);

    switch (action) {
      case 'play': {
        const pos = num(body.position, exp);
        if (s.playing && Math.abs(pos - exp) < 0.5) return null; // already playing there
        return { set: { 'state.playing': true, 'state.position': pos, 'state.updatedAt': at } };
      }
      case 'pause': {
        const pos = num(body.position, exp);
        if (!s.playing && Math.abs(pos - s.position) < 0.3) return null;
        return { set: { 'state.playing': false, 'state.position': pos, 'state.updatedAt': at } };
      }
      case 'seek': {
        const pos = num(body.position, null);
        if (pos === null) throw new HttpError(400, 'Missing position.');
        return { set: { 'state.position': pos, 'state.updatedAt': at } };
      }
      case 'rate': {
        const rate = Math.min(2, Math.max(0.25, num(body.rate, 1)));
        if (Math.abs(rate - s.rate) < 0.01) return null;
        return { set: { 'state.rate': rate, 'state.position': exp, 'state.updatedAt': at } };
      }
      case 'load': {
        const media = parseMedia(body.url);
        const title = await resolveTitle(media);
        return { set: loadFields(media, title), announce: { text: `${me.name} started "${title}"` } };
      }
      case 'next':
      case 'ended': {
        if (action === 'ended' && Number(body.version) !== s.version) return null; // someone else already handled it
        const head = room.playlist[0];
        if (head) {
          return {
            set: loadFields(head, head.title),
            popHead: true,
            guardHeadId: head.id,
            playlistChanged: true,
            announce: { text: `Up next: "${head.title}"` },
          };
        }
        if (action === 'next') throw new HttpError(400, 'The queue is empty.');
        return { set: { 'state.playing': false, 'state.position': exp, 'state.updatedAt': at } };
      }
      default:
        throw new HttpError(400, 'Unknown action.');
    }
  });

  if (!result.changed) return res.json({ ok: true, changed: false, state: publicState(result.room.state) });

  const state = publicState(result.room.state);
  const delivered = await emit(req.room._id, 'state', { state, action, by: { id: me.id, name: me.name } });
  if (result.plan.playlistChanged) await emit(req.room._id, 'playlist', { playlist: publicPlaylist(result.room.playlist) });
  if (result.plan.announce) {
    await emit(req.room._id, 'chat', { id: uuid(), kind: 'system', text: result.plan.announce.text, createdAt: Date.now() });
  }
  res.json({ ok: true, changed: true, state, delivered });
});

// ---------- queue ----------

router.post('/:id/playlist', requireMe, actionLimit, loadRoom, needAccess, async (req, res) => {
  const room = req.room;
  const me = req.me;
  const action = String(req.body.action || '');
  const max = config.limits.playlistMax;

  if (action === 'add') {
    const media = parseMedia(req.body.url);
    const title = await resolveTitle(media);
    const item = {
      id: uuid(), provider: media.provider, mediaId: media.mediaId, url: media.url,
      title, addedBy: me.name, addedById: me.id, addedAt: new Date(),
    };
    const updated = await Room.findOneAndUpdate(
      { _id: room._id, [`playlist.${max - 1}`]: { $exists: false } },
      { $push: { playlist: item }, $set: touchFields(room) },
      { returnDocument: 'after' }
    );
    if (!updated) throw new HttpError(400, `The queue is full (${max} items).`);
    const playlist = publicPlaylist(updated.playlist);
    const delivered = await emit(room._id, 'playlist', { playlist });
    return res.json({ playlist, delivered });
  }

  if (action === 'remove') {
    const item = room.playlist.find((i) => i.id === req.body.id);
    if (!item) return res.json({ playlist: publicPlaylist(room.playlist) });
    if (item.addedById !== me.id && !canControl(room, me)) throw new HttpError(403, 'You can only remove items you added.', 'NO_CONTROL');
    const updated = await Room.findByIdAndUpdate(room._id, { $pull: { playlist: { id: item.id } } }, { returnDocument: 'after' });
    const playlist = publicPlaylist(updated.playlist);
    const delivered = await emit(room._id, 'playlist', { playlist });
    return res.json({ playlist, delivered });
  }

  if (action === 'clear') {
    needControl(req, res, () => {});
    const updated = await Room.findByIdAndUpdate(room._id, { $set: { playlist: [] } }, { returnDocument: 'after' });
    const delivered = await emit(room._id, 'playlist', { playlist: [] });
    return res.json({ playlist: publicPlaylist(updated.playlist), delivered });
  }

  if (action === 'play') {
    needControl(req, res, () => {});
    const id = String(req.body.id || '');
    const result = await mutateState(room._id, async (r) => {
      const item = r.playlist.find((i) => i.id === id);
      if (!item) throw new HttpError(404, 'That item is no longer in the queue.');
      return { set: loadFields(item, item.title), pullId: item.id, playlistChanged: true, announce: { text: `${me.name} started "${item.title}"` } };
    });
    const state = publicState(result.room.state);
    await emit(room._id, 'state', { state, action: 'load', by: { id: me.id, name: me.name } });
    await emit(room._id, 'playlist', { playlist: publicPlaylist(result.room.playlist) });
    await emit(room._id, 'chat', { id: uuid(), kind: 'system', text: result.plan.announce.text, createdAt: Date.now() });
    return res.json({ ok: true, state, playlist: publicPlaylist(result.room.playlist) });
  }

  throw new HttpError(400, 'Unknown action.');
});

// ---------- chat ----------

router.post('/:id/chat', requireMe, chatLimit, loadRoom, needAccess, async (req, res) => {
  const text = String(req.body.text || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!text) throw new HttpError(400, 'Type a message first.');
  if (text.length > config.limits.chatMaxLength) throw new HttpError(400, `Messages can be up to ${config.limits.chatMaxLength} characters.`);

  const msg = await Message.create({
    room: req.room._id,
    author: { id: req.me.id, name: req.me.name, color: req.me.color },
    text,
  });
  const payload = toChat(msg);
  const delivered = await emit(req.room._id, 'chat', payload);
  res.status(201).json({ message: payload, delivered });
});

module.exports = router;
