'use strict';

const { Server } = require('socket.io');
const { parseCookies } = require('../lib/cookies');
const { meFromCookies } = require('../middleware/auth');
const { connectDB } = require('../db');
const Room = require('../models/Room');
const { checkAccess } = require('../lib/access');

let io = null;
const rooms = new Map(); // roomId -> Map(peerId -> member)

const FLAGS = ['inCall', 'mic', 'cam', 'screen'];
const cleanFlags = (d) => Object.fromEntries(FLAGS.map((k) => [k, !!(d && d[k])]));
const chan = (roomId) => `room:${roomId}`;

function removeMember(socket) {
  const { roomId, peerId } = socket.data;
  if (!roomId || !peerId) return;
  const members = rooms.get(roomId);
  if (members && members.get(peerId) && members.get(peerId).socketId === socket.id) {
    const member = members.get(peerId);
    members.delete(peerId);
    if (!members.size) rooms.delete(roomId);
    socket.to(chan(roomId)).emit('presence', { type: 'leave', member });
  }
  socket.leave(chan(roomId));
  socket.data.roomId = null;
  socket.data.peerId = null;
}

function attach(server) {
  io = new Server(server, { pingInterval: 10000, pingTimeout: 8000, maxHttpBufferSize: 1e5 });

  io.on('connection', (socket) => {
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const me = meFromCookies(cookies);

    // Join a room: verifies the same access rules as the REST API, then registers presence.
    socket.on('join', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        if (!me) return reply({ ok: false, error: 'No session' });
        const roomId = String(payload && payload.roomId || '');
        const peerId = String(payload && payload.peerId || '');
        if (!/^[\w-]{2,40}$/.test(roomId) || !/^[\w-]{6,64}$/.test(peerId)) return reply({ ok: false, error: 'Bad request' });

        await connectDB();
        const room = await Room.findById(roomId).lean();
        if (!room) return reply({ ok: false, error: 'Room not found' });
        const access = checkAccess(room, me, cookies);
        if (!access.ok) return reply({ ok: false, error: 'No access', reason: access.reason });

        removeMember(socket);
        const member = { peerId, uid: me.id, name: me.name, color: me.color, socketId: socket.id, ...cleanFlags(payload.data) };
        if (!rooms.has(roomId)) rooms.set(roomId, new Map());
        const members = rooms.get(roomId);
        members.set(peerId, member);
        socket.data.roomId = roomId;
        socket.data.peerId = peerId;
        socket.join(chan(roomId));

        socket.to(chan(roomId)).emit('presence', { type: 'join', member });
        reply({ ok: true, members: [...members.values()] });
      } catch (err) {
        console.error('[socketio] join failed:', err.message);
        reply({ ok: false, error: 'Server error' });
      }
    });

    socket.on('presence:update', (data) => {
      const { roomId, peerId } = socket.data;
      const member = roomId && rooms.get(roomId) && rooms.get(roomId).get(peerId);
      if (!member) return;
      Object.assign(member, cleanFlags(data));
      socket.to(chan(roomId)).emit('presence', { type: 'update', member });
    });

    // WebRTC signalling: relay an SDP/ICE blob to one specific peer in the same room.
    socket.on('signal', (msg) => {
      const { roomId, peerId } = socket.data;
      if (!roomId || !msg || typeof msg.to !== 'string') return;
      const target = rooms.get(roomId) && rooms.get(roomId).get(msg.to);
      if (!target) return;
      io.to(target.socketId).emit('signal', { from: peerId, data: msg.data });
    });

    socket.on('disconnect', () => removeMember(socket));
  });
}

async function publish(roomId, name, data) {
  if (!io) throw new Error('Socket.IO is not attached. Start the app with `npm start` (server.js).');
  io.to(chan(roomId)).emit('evt', { name, data });
}

async function kick(roomId, uid) {
  if (!io) return;
  const members = rooms.get(roomId);
  if (!members) return;
  for (const m of [...members.values()]) {
    if (m.uid !== uid) continue;
    const s = io.sockets.sockets.get(m.socketId);
    if (s) s.disconnect(true);
  }
}

async function createToken() {
  throw new Error('createToken is only used by the Ably driver');
}

module.exports = { attach, publish, kick, createToken };
