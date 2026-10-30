import { api } from './api.js';

export const session = { me: null, cfg: { appName: 'Couchtime', realtime: { driver: 'socketio' }, turn: false } };

// Every change of who is signed in goes through here. It also tells the page (data-kind on <html>,
// which the CSS reads) and remembers the answer, so the next page load can draw the right version
// of the page straight away instead of showing the guest version until the server has replied.
export function setMe(me) {
  session.me = me;
  const kind = me ? me.kind : 'none';
  document.documentElement.dataset.kind = kind;
  try { localStorage.setItem('ct_kind', kind); } catch (_) { /* private mode */ }
}

export async function loadSession() {
  const [cfg, who] = await Promise.all([api('/config'), api('/auth/me')]);
  session.cfg = cfg;
  setMe(who.me);
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
  setMe(me);
  rememberName(me.name);
  return me;
}
