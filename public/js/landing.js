import { api } from './api.js';
import { session, loadSession, savedName, ensureIdentity } from './session.js';
import { mountAccount, openAuthModal } from './account.js';
import { h, $, icon, brandMark, toast } from './ui.js';

$('#brand-mark').replaceWith(brandMark());

// The "marquee" bulbs on the ticket light up one after another.
const bulbs = $('#bulbs');
for (let i = 0; i < 14; i++) bulbs.append(h('i', { style: { animationDelay: `${i * 0.17}s` } }));

$('#facts').append(
  ...[
    ['users', 'Same second, every screen', 'Play, pause or seek once and everyone follows, including people who join late.'],
    ['headphones', 'Talk while you watch', 'Voice, camera and screen share run in the browser. Nothing to install.'],
    ['film', 'Bring any link', 'YouTube, Vimeo, or a direct video file or HLS stream.'],
  ].map(([ic, title, text]) => h('li', null,
    h('span', { class: 'ico' }, icon(ic)),
    h('div', null, h('strong', null, title), h('span', null, text))))
);

const el = {
  nick: $('#nick'), nickRow: $('#nick-row'), name: $('#room-name'), control: $('#control'), pass: $('#room-pass'),
  slug: $('#slug'), permanent: $('#permanent'), userOnly: $('#user-only'), guestNote: $('#guest-note'),
  err: $('#create-err'), btn: $('#create-btn'), code: $('#code'),
};

function refresh() {
  const isUser = session.me && session.me.kind === 'user';
  el.nickRow.hidden = !!isUser;
  el.userOnly.hidden = !isUser;
  el.guestNote.hidden = !!isUser;
  if (!isUser) el.nick.value = el.nick.value || (session.me && session.me.name) || savedName();
  loadMyRooms();
}

async function loadMyRooms() {
  const box = $('#my-rooms');
  if (!session.me) { box.hidden = true; return; }
  try {
    const { rooms } = await api('/rooms/mine');
    box.hidden = rooms.length === 0;
    $('#room-list').replaceChildren(...rooms.map((r) => h('a', { class: 'room-card', href: `/r/${r.id}` },
      h('b', null, h('span', { dir: 'auto' }, r.name), r.locked && icon('lock'), r.permanent && h('span', { class: 'role' }, 'Forever')),
      h('span', { dir: 'auto' }, r.title || 'Nothing playing yet'))));
  } catch (_) {
    box.hidden = true;
  }
}

$('#create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  el.err.textContent = '';
  el.btn.disabled = true;
  try {
    await ensureIdentity(el.nick.value);
    const isUser = session.me.kind === 'user';
    const { room } = await api('/rooms', {
      method: 'POST',
      body: {
        name: el.name.value,
        control: el.control.value,
        password: el.pass.value,
        slug: isUser ? el.slug.value : '',
        permanent: isUser ? el.permanent.checked : false,
      },
    });
    location.href = `/r/${room.id}`;
  } catch (ex) {
    el.err.textContent = ex.message;
    if (/nickname/i.test(ex.message)) el.nick.focus();
    el.btn.disabled = false;
  }
});

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = el.code.value.trim();
  const match = /(?:\/r\/)?([a-z0-9][a-z0-9-]{1,39})\/?(?:[?#].*)?$/i.exec(raw);
  if (!raw || !match) { toast('Paste an invite link or a room code.', 'error'); el.code.focus(); return; }
  location.href = `/r/${match[1].toLowerCase()}`;
});

(async function init() {
  try {
    await loadSession();
  } catch (ex) {
    toast(ex.message, 'error', 8000);
  }
  document.title = `${session.cfg.appName}: watch together`;
  mountAccount($('#account'), { onChange: refresh });
  refresh();
  if (new URLSearchParams(location.search).has('login')) openAuthModal({ onDone: refresh });
})();
