'use strict';

const Ably = require('ably');
const config = require('../config');
const { HttpError } = require('../lib/errors');

let rest = null;
function client() {
  if (!config.realtime.ablyKey) throw new HttpError(500, 'Realtime is not configured: set ABLY_API_KEY.');
  if (!rest) rest = new Ably.Rest({ key: config.realtime.ablyKey });
  return rest;
}

// Server to browsers. Clients are not allowed to publish on this channel, so anything arriving
// here is trusted (permission checks already happened in the REST route that called publish).
async function publish(roomId, name, data) {
  await client().channels.get(`room:${roomId}`).publish(name, data);
}

// Browsers may only subscribe + use presence on room:<id>, and publish WebRTC signals on sig:<id>.
async function createToken(me, roomId) {
  return client().auth.createTokenRequest({
    clientId: me.id,
    ttl: 60 * 60 * 1000,
    capability: JSON.stringify({
      [`room:${roomId}`]: ['subscribe', 'presence'],
      [`sig:${roomId}`]: ['subscribe', 'publish'],
    }),
  });
}

// Hosted channels cannot be force-closed per user without paid token revocation. The kicked
// browser leaves on its own when it receives the "kick" event, and the API refuses it afterwards.
async function kick() {}

module.exports = { publish, createToken, kick };
