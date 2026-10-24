// Tiny DOM helpers shared by every page. No framework, no build step.

const NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  play: '<path d="m7 4 13 8-13 8Z"/>',
  skip: '<path d="m5 4 10 8-10 8Z"/><path d="M19 5v14"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
  micOff: '<path d="m2 2 20 20"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><path d="M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M19 10v2a7 7 0 0 1-.11 1.23"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M12 19v3"/>',
  video: '<path d="m16 13 5.22 3.48a.5.5 0 0 0 .78-.42V7.94a.5.5 0 0 0-.78-.42L16 11"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  videoOff: '<path d="M10.66 6H14a2 2 0 0 1 2 2v2.5l5.25-3.5a.5.5 0 0 1 .75.43v9.14"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h.5"/><path d="m2 2 20 20"/>',
  screen: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="m9 11 3-3 3 3"/><path d="M12 8v6"/>',
  headphones: '<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3Z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3Z"/>',
  hangup: '<path d="M3 13.5c5-5 13-5 18 0l-2.2 2.2a1 1 0 0 1-1.2.15l-2.6-1.4a1 1 0 0 1-.5-1.1l.25-1.2c-1.7-.55-3.4-.55-5.1 0l.25 1.2a1 1 0 0 1-.5 1.1l-2.6 1.4a1 1 0 0 1-1.2-.15Z"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  sliders: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/>',
  crown: '<path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7Z"/><path d="M5 20h14"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18"/><path d="M17 3v18"/><path d="M3 8h4"/><path d="M3 12h18"/><path d="M3 16h4"/><path d="M17 8h4"/><path d="M17 16h4"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  volumeLow: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
  volumeOff: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  minimize: '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
  theater: '<rect x="2" y="6" width="20" height="12" rx="2"/>',
  door: '<path d="M13 4h3a2 2 0 0 1 2 2v14"/><path d="M2 20h3"/><path d="M13 20h9"/><path d="M10 12v.01"/><path d="M13 4.56v16.88a1 1 0 0 1-1.2.98l-6-1.2A1 1 0 0 1 5 20.24V5.76a1 1 0 0 1 .8-.98l6-1.2A1 1 0 0 1 13 4.56Z"/>',
};

export function icon(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || ''; // static, trusted strings only
  return svg;
}

// h('button', { class: 'btn', onclick: fn }, icon('plus'), 'Add')
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) return c.forEach(add);
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function initial(name) {
  const t = String(name || '?').trim();
  return (Array.from(t)[0] || '?').toUpperCase();
}

export function avatar(user, size) {
  const el = h('span', { class: 'avatar', style: { background: user.color || '#ffb547' }, 'aria-hidden': 'true' }, initial(user.name));
  if (size) Object.assign(el.style, { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.43)}px` });
  return el;
}

export function timeLabel(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ---------- toasts ----------

let toastHost = null;
export function toast(message, kind = 'info', ms = 3200) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: `toast ${kind === 'error' ? 'error' : ''}` }, message);
  // In full screen only the full-screen element is drawn, so the toasts have to live inside it.
  const home = document.fullscreenElement || document.webkitFullscreenElement || document.body;
  if (toastHost.parentNode !== home) home.append(toastHost);
  toastHost.append(el);
  while (toastHost.children.length > 4) toastHost.firstChild.remove();
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 260);
  }, ms);
}

// ---------- modal ----------

export function openModal({ title, sub, content, actions = [], dismissible = true, onClose }) {
  const previous = document.activeElement;
  const scrim = h('div', { class: 'scrim' });
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
    title && h('h2', null, title),
    sub && h('p', { class: 'sub' }, sub),
    content,
    actions.length > 0 && h('div', { class: 'modal-actions' }, actions)
  );
  scrim.append(box);

  const api = {
    el: box,
    close() {
      document.removeEventListener('keydown', onKey);
      scrim.remove();
      if (previous && previous.focus) previous.focus();
      if (onClose) onClose();
    },
  };
  function onKey(e) { if (e.key === 'Escape' && dismissible) api.close(); }
  if (dismissible) scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) api.close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(scrim);
  const first = box.querySelector('input, select, textarea, button.btn-primary');
  if (first) setTimeout(() => first.focus(), 30);
  return api;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { /* ignore */ }
    ta.remove();
    return ok;
  }
}

// Make URLs in chat clickable without ever using innerHTML.
export function linkify(text) {
  const frag = document.createDocumentFragment();
  const re = /https?:\/\/[^\s<>"']+/gi;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    let url = m[0];
    const trail = /[.,!?;:)\]]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    if (m.index > last) frag.append(text.slice(last, m.index));
    frag.append(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow' }, url));
    last = m.index + url.length;
    re.lastIndex = last;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

export const brandMark = () => h('span', { class: 'brand-mark' }, icon('play'));
