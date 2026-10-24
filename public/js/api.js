// fetch wrapper + a clock that lines this browser up with the server.
// Synced playback depends on everyone agreeing what "now" is, and device clocks are often seconds off.

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `Request failed (${status})`);
    this.status = status;
    this.code = body && body.code;
    this.body = body;
  }
}

let offset = 0;        // serverTime - localTime, in ms
let bestRtt = Infinity;

export const serverNow = () => Date.now() + offset;

function sample(serverTime, t0, t1) {
  const rtt = t1 - t0;
  // Prefer the sample with the shortest round trip; let the bar creep up so the estimate can follow drift.
  if (rtt <= bestRtt) {
    bestRtt = rtt;
    offset = serverTime - (t0 + t1) / 2;
  } else {
    bestRtt += 2;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch (_) {
    throw new ApiError(0, { error: 'Cannot reach the server. Check your connection.', code: 'OFFLINE' });
  }
  const t1 = Date.now();
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (data && typeof data.serverTime === 'number') sample(data.serverTime, t0, t1);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// A few quick pings at startup so the very first sync is already accurate.
export async function calibrateClock(n = 4) {
  for (let i = 0; i < n; i++) {
    try { await api('/time'); } catch (_) { return; }
  }
}
