import { api } from './api.js';

export const session = { me: null, cfg: { appName: 'Couchtime', realtime: { driver: 'socketio' }, turn: false } };

export async function loadSession() {
  const [cfg, who] = await Promise.all([api('/config'), api('/auth/me')]);
  session.cfg = cfg;
  session.me = who.me;
  document.querySelectorAll('[data-app-name]').forEach((el) => { el.textContent = cfg.appName; });
  return session;
}

export function savedName() {
  try { return localStorage.getItem('ct_name') || ''; } catch (_) { return ''; }
}

export function rememberName(name) {
  try { localStorage.setItem('ct_name', name); } catch (_) { /* private mode */ }
}

// Guests only need a nickname. Registered users already have an identity and keep it.
export async function ensureIdentity(nickname) {
  if (session.me && session.me.kind === 'user') return session.me;
  const name = String(nickname || '').trim();
  if (session.me && session.me.name === name) return session.me;
  const { me } = await api('/auth/guest', { method: 'POST', body: { name } });
  session.me = me;
  rememberName(me.name);
  return me;
}
