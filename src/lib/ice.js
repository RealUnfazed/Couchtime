'use strict';

const crypto = require('crypto');
const config = require('../config');

// STUN lets two browsers discover their public address (free, nothing relayed).
// TURN relays media when a direct connection is impossible (strict NAT, mobile data, corporate Wi-Fi).
// Roughly 10 to 15 percent of connections need it, so voice/screen share is flaky without one.

let cache = { at: 0, servers: null };
const CACHE_MS = 60 * 60 * 1000; // credentials below are valid for 24h, so reusing them for 1h is safe

async function cloudflare() {
  const { keyId, apiToken } = config.ice.cloudflare;
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: 86400 }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`Cloudflare TURN responded ${res.status}`);
  const j = await res.json();
  // Port 53 URLs time out in browsers, drop them.
  return (j.iceServers || []).map((s) => ({
    ...s,
    urls: [].concat(s.urls || []).filter((u) => !/:53(\?|$)/.test(u)),
  }));
}

async function metered() {
  const { app, apiKey } = config.ice.metered;
  const res = await fetch(`https://${encodeURIComponent(app)}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`Metered TURN responded ${res.status}`);
  const j = await res.json();
  return Array.isArray(j) ? j : (j.iceServers || []);
}

function staticTurn() {
  const { urls, username, credential } = config.ice.staticTurn;
  return [{ urls, username, credential }];
}

// coturn with `use-auth-secret`: credentials are an HMAC of an expiry timestamp, no database needed.
function coturn(uid) {
  const { urls, secret } = config.ice.coturn;
  const username = `${Math.floor(Date.now() / 1000) + 86400}:${uid}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return [{ urls, username, credential }];
}

async function getIceServers(me) {
  const stun = [{ urls: config.ice.stun }];
  const provider = config.ice.turnProvider;
  if (!provider) return { iceServers: stun, turn: false };

  try {
    if (provider === 'coturn') return { iceServers: [...stun, ...coturn(me.id)], turn: true };
    if (provider === 'static') return { iceServers: [...stun, ...staticTurn()], turn: true };

    if (cache.servers && Date.now() - cache.at < CACHE_MS) return { iceServers: cache.servers, turn: true };
    const servers = provider === 'cloudflare' ? await cloudflare() : provider === 'metered' ? await metered() : [];
    if (!servers.length) throw new Error('no TURN servers returned');
    const hasStun = servers.some((s) => [].concat(s.urls).some((u) => String(u).startsWith('stun:')));
    cache = { at: Date.now(), servers: hasStun ? servers : [...stun, ...servers] };
    return { iceServers: cache.servers, turn: true };
  } catch (err) {
    console.error('[ice] TURN lookup failed, falling back to STUN only:', err.message);
    return { iceServers: stun, turn: false };
  }
}

module.exports = { getIceServers };
