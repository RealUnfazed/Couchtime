'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');

const roomCookie = (roomId) => `ct_r_${roomId}`;

function roleOf(room, me) {
  if (!me) return 'viewer';
  if (room.owner && room.owner.id === me.id) return 'owner';
  if ((room.mods || []).includes(me.id)) return 'mod';
  return 'member';
}

function canControl(room, me) {
  const role = roleOf(room, me);
  if (role === 'viewer') return false;
  if (room.control === 'everyone') return true;
  if (room.control === 'mods') return role === 'owner' || role === 'mod';
  return role === 'owner';
}

// A short fingerprint of the current password so changing it invalidates old passes.
const fingerprint = (room) => (room.passwordHash || '').slice(-12);

function signRoomPass(room, me) {
  return jwt.sign({ r: room._id, s: me.id, f: fingerprint(room) }, config.jwtSecret, { expiresIn: '7d' });
}

function hasRoomPass(room, me, cookies) {
  const token = cookies && cookies[roomCookie(room._id)];
  if (!token) return false;
  try {
    const p = jwt.verify(token, config.jwtSecret);
    return p.r === room._id && p.s === me.id && p.f === fingerprint(room);
  } catch (_) {
    return false;
  }
}

// Returns { ok: true } or { ok: false, reason: 'session' | 'banned' | 'password' }.
function checkAccess(room, me, cookies) {
  if (!me) return { ok: false, reason: 'session' };
  if ((room.banned || []).includes(me.id)) return { ok: false, reason: 'banned' };
  if (!room.passwordHash) return { ok: true };
  if (roleOf(room, me) === 'owner') return { ok: true };
  if (hasRoomPass(room, me, cookies)) return { ok: true };
  return { ok: false, reason: 'password' };
}

function publicRoom(room) {
  return {
    id: room._id,
    name: room.name,
    ownerId: room.owner.id,
    ownerName: room.owner.name,
    control: room.control,
    mods: room.mods || [],
    locked: !!room.passwordHash,
    permanent: !!room.permanent,
  };
}

function publicState(s) {
  return {
    provider: s.provider || '',
    mediaId: s.mediaId || '',
    url: s.url || '',
    title: s.title || '',
    playing: !!s.playing,
    position: s.position || 0,
    rate: s.rate || 1,
    updatedAt: new Date(s.updatedAt).getTime(),
    version: s.version || 0,
  };
}

function publicPlaylist(list) {
  return (list || []).map((i) => ({
    id: i.id, provider: i.provider, mediaId: i.mediaId, url: i.url, title: i.title, addedBy: i.addedBy, addedById: i.addedById || '',
  }));
}

module.exports = {
  roomCookie, roleOf, canControl, signRoomPass, checkAccess,
  publicRoom, publicState, publicPlaylist,
};
