'use strict';

const config = require('../config');

// One small interface, two engines:
//   socketio  persistent WebSockets inside this Node process (local machine, VPS, Render, Railway...)
//   ably      hosted pub/sub, so serverless platforms like Vercel can push events to browsers
//
//   publish(roomId, name, data)   send an event to everyone in a room
//   kick(roomId, uid)             drop a user's live connections (best effort)
//   attach(httpServer)            socketio only, called by server.js
//   createToken(me, roomId)       ably only, used by GET /api/rt/auth

let impl = null;
function engine() {
  if (!impl) impl = config.realtime.driver === 'ably' ? require('./ably') : require('./socketio');
  return impl;
}

module.exports = {
  driver: config.realtime.driver,
  publish: (roomId, name, data) => engine().publish(roomId, name, data),
  kick: (roomId, uid) => engine().kick(roomId, uid),
  attach: (server) => (engine().attach ? engine().attach(server) : undefined),
  createToken: (me, roomId) => engine().createToken(me, roomId),
};
