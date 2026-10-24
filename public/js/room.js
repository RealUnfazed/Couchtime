import { api, ApiError, calibrateClock } from './api.js';
import { session, loadSession, savedName, ensureIdentity } from './session.js';
import { mountAccount, openAuthModal } from './account.js';
import { createRealtime } from './realtime.js';
import { SyncController } from './sync.js';
import { CallManager } from './rtc.js';
import { PlayerControls } from './controls.js';
import { h, $, icon, avatar, brandMark, toast, openModal, copyText, linkify, timeLabel } from './ui.js';

const roomId = (location.pathname.split('/').filter(Boolean)[1] || '').toLowerCase();
const peerId = `p${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')}`; // one per browser tab (works on plain http too)

let me = null;
let room = null;
let members = [];
let queue = [];
let rt = null;
let sync = null;
let call = null;
let controls = null;
let theater = false;       // side panel hidden, the player gets the whole page
let announce = false;       // show "X joined" lines only after the first member list
let activeTab = 'chat';
let unread = 0;
let watching = null;        // peerId whose shared screen is on the stage
let nowTitle = '';
let lastRefresh = 0;
let ended = false;

const seenChat = new Set();
const autoWatched = new Set();
const streams = new Map();  // "peerId:kind" -> MediaStream
const tiles = new Map();    // peerId -> tile element
const speakingNow = new Set();

// ------------------------------------------------------------------ roles

const role = () => (!room || !me ? 'member' : room.ownerId === me.id ? 'owner' : room.mods.includes(me.id) ? 'mod' : 'member');
const canControl = () => {
  const r = role();
  return room.control === 'everyone' || r === 'owner' || (room.control === 'mods' && r === 'mod');
};

const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
};

// ------------------------------------------------------------------ full-screen messages and the join gate

function showCard(content) {
  const gate = $('#gate');
  gate.hidden = false;
  gate.replaceChildren(h('div', { class: 'modal' }, content));
}

function fatal(title, text, { home = true, retry = false } = {}) {
  ended = true;
  $('#room-main').hidden = true;
  showCard([
    h('h2', null, title),
    h('p', { class: 'sub' }, text),
    h('div', { class: 'modal-actions' },
      retry && h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Try again'),
      home && h('a', { class: 'btn btn-primary', href: '/' }, 'Back to home')),
  ]);
}

function renderGate(info) {
  const needsPassword = info.room.locked && !info.access;
  const isUser = session.me && session.me.kind === 'user';
  const nick = h('input', { class: 'field', id: 'g-nick', maxLength: 24, dir: 'auto', placeholder: 'What friends will see', value: (session.me && session.me.name) || savedName() });
  const pass = needsPassword ? h('input', { class: 'field', id: 'g-pass', type: 'password', autocomplete: 'off', maxLength: 64 }) : null;
  const err = h('p', { class: 'err', role: 'alert' });
  const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit', style: { padding: '12px', fontSize: '16px' } }, icon('play'), 'Join room');

  const form = h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      btn.disabled = true;
      try {
        await ensureIdentity(nick.value);
        if (needsPassword) await api(`/rooms/${roomId}/join`, { method: 'POST', body: { password: pass.value } });
        const snap = await api(`/rooms/${roomId}`);
        if (!snap.access) throw new Error('You cannot enter this room yet.');
        $('#gate').hidden = true;
        await enter(snap);
      } catch (ex) {
        if (ex instanceof ApiError && ex.code === 'BANNED') return joinFailed(ex);
        err.textContent = ex.message;
        btn.disabled = false;
      }
    },
  },
  !isUser && h('div', null, h('label', { class: 'lbl', for: 'g-nick' }, 'Your nickname'), nick),
  isUser && h('p', { class: 'hint' }, 'Joining as ', h('strong', { dir: 'auto' }, session.me.name)),
  needsPassword && h('div', null, h('label', { class: 'lbl', for: 'g-pass' }, 'Room password'), pass),
  err, btn);

  showCard([
    h('h2', { dir: 'auto' }, info.room.name),
    h('p', { class: 'sub' }, info.room.ownerName ? `Hosted by ${info.room.ownerName}` : 'You were invited to watch together.'),
    form,
    !isUser && h('p', { class: 'hint', style: { marginTop: '14px' } }, 'Have an account? ',
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); openAuthModal({ onDone: () => renderGate(info) }); } }, 'Sign in')),
  ]);
  setTimeout(() => (isUser ? btn : (nick.value ? btn : nick)).focus(), 30);
}

function joinFailed(err) {
  if (err.code === 'NO_ROOM') return fatal('This room is gone', 'It may have expired after a day without visitors, or the link has a typo. You can start a new one in seconds.');
  if (err.code === 'BANNED') return fatal('You were removed from this room', 'The host removed you, so you cannot rejoin this room.');
  return fatal('Could not open this room', err.message, { retry: true });
}

// ------------------------------------------------------------------ boot

async function boot() {
  $('#brand-mark').replaceWith(brandMark());
  try {
    await loadSession();
  } catch (err) {
    return fatal('Cannot reach the server', err.message, { retry: true, home: false });
  }
  calibrateClock();
  if (!roomId) return fatal('No room code in this link', 'Check the address, or start a new room.');
  mountAccount($('#account'), { onChange: () => location.reload() });

  let info;
  try { info = await api(`/rooms/${roomId}`); } catch (err) { return joinFailed(err); }
  document.title = `${info.room.name} - ${session.cfg.appName}`;
  if (info.access) {
    // Returning visitor with a valid session: still show the gate once, because a real click is what
    // lets the browser play sound and start video without blocking it.
    renderGate({ ...info, access: true });
  } else {
    renderGate(info);
  }
}

// ------------------------------------------------------------------ entering the room

async function enter(snap) {
  me = session.me;
  room = snap.room;
  document.title = `${room.name} - ${session.cfg.appName}`;
  buildStatic();
  $('#room-main').hidden = false;
  $('#account').replaceChildren();
  mountAccount($('#account'), { onChange: () => location.reload() });
  applyRoom();

  snap.messages.forEach(addMessage);
  setQueue(snap.playlist);

  sync = new SyncController({
    host: $('#host'),
    roomId,
    canControl,
    ui: {
      setEmpty: (v) => { $('#stage-empty').hidden = !v; $('#stage').classList.toggle('has-media', !v); },
      setLoading: (v) => { $('#stage-loading').hidden = !v; },
      showTap: (v) => { $('#tap').hidden = !v; },
      setStatus: setSyncStatus,
      toast,
      onMedia: (s) => { nowTitle = s.title || ''; const el = $('#now-title'); if (el) el.textContent = nowTitle || 'Nothing playing'; },
    },
  });

  controls = new PlayerControls({
    stage: $('#stage'),
    sync,
    toast,
    hooks: { onResync: resync, onTheater: toggleTheater, onFullscreen: toggleFullscreen, onChat: openFloatChat },
  });
  controls.setQueueSize(queue.length);
  controls.refresh();

  rt = createRealtime(session.cfg.realtime.driver, {
    roomId, peerId, me,
    getFlags: () => (call ? call.flags : { inCall: false, mic: false, cam: false, screen: false }),
  });

  call = new CallManager({
    selfId: peerId,
    signal: (to, data) => rt.signal(to, data),
    setPresence: (flags) => rt.setPresence(flags),
    getIceServers: () => api('/ice'),
    onChange: () => { renderDock(); renderStrip(); renderPeople(); updateScreenView(); },
    onStream: onRemoteStream,
    onSpeaking: onSpeaking,
    toast,
  });

  window.couchtime = { get sync() { return sync; }, get call() { return call; }, get rt() { return rt; }, get controls() { return controls; } }; // handy in the console and in tests

  rt.on('evt', onEvent);
  rt.on('signal', (from, data) => call.handleSignal(from, data));
  rt.on('members', onMembers);
  rt.on('peer-join', (m) => { if (announce) addSystem(`${m.name} joined`); });
  rt.on('peer-leave', (m) => { if (announce) addSystem(`${m.name} left`); });
  rt.on('status', onStatus);
  rt.on('reconnected', () => refreshSnapshot().catch(() => {}));

  try {
    await rt.connect();
  } catch (err) {
    return fatal('Could not connect to live updates', `${err.message} The page cannot stay in sync without it.`, { retry: true, home: false });
  }
  announce = true;
  await refreshSnapshot(true);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastRefresh > 8000) refreshSnapshot().catch(() => {});
  });
  window.addEventListener('pagehide', () => { if (call) call.destroy(); if (rt) rt.close(); });
}

async function refreshSnapshot(first = false) {
  if (ended) return;
  let snap;
  try {
    snap = await api(`/rooms/${roomId}`);
  } catch (err) {
    if (err.code === 'NO_ROOM') return fatal('This room was closed', 'The host deleted it, or it expired.');
    if (err.code === 'BANNED') return joinFailed(err);
    throw err;
  }
  if (!snap.access) { location.reload(); return; }
  lastRefresh = Date.now();
  room = snap.room;
  applyRoom();
  setQueue(snap.playlist);
  snap.messages.forEach(addMessage);
  await sync.receive(snap.state, { force: first });
}

// ------------------------------------------------------------------ static UI built once

function buildStatic() {
  $('#invite-btn').replaceChildren(icon('link'), h('span', { class: 'label-long' }, 'Invite'));
  $('#invite-btn').hidden = false;
  $('#invite-btn').onclick = openInvite;
  $('#settings-btn').replaceChildren(icon('sliders'), h('span', { class: 'label-long' }, 'Room settings'));
  $('#settings-btn').onclick = openSettings;
  $('#play-now').replaceChildren(icon('play'), 'Play now');
  $('#queue-add').replaceChildren(icon('plus'), 'Add to queue');
  $('#tap-btn').replaceChildren(icon('play'), 'Click to join the video');
  $('#tap-btn').onclick = () => sync.tapToPlay();
  $('#chat-form button').replaceChildren(icon('send'));

  $('#link-form').addEventListener('submit', (e) => { e.preventDefault(); playNow(); });
  $('#queue-add').addEventListener('click', addToQueue);
  $('#queue-clear').addEventListener('click', () => api(`/rooms/${roomId}/playlist`, { method: 'POST', body: { action: 'clear' } }).catch((e) => toast(e.message, 'error')));
  $('#chat-form').addEventListener('submit', sendChat);
  $('#screen-back').addEventListener('click', () => { watching = null; updateScreenView(); renderDock(); });
  $('#screen-full').addEventListener('click', toggleFullscreen);
  $('#cf-form').addEventListener('submit', async (e) => { e.preventDefault(); if (await postChat($('#cf-input'))) closeFloatChat(); });
  $('#cf-input').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeFloatChat(); } });
  document.addEventListener('fullscreenchange', onFullChange);
  document.addEventListener('webkitfullscreenchange', onFullChange);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#shell').classList.contains('fake-full')) toggleFullscreen(); });

  const tabs = $('#tabs');
  tabs.replaceChildren(
    ...[['chat', 'chat', 'Chat'], ['queue', 'list', 'Queue'], ['people', 'users', 'People']].map(([id, ic, label]) =>
      h('button', {
        type: 'button', role: 'tab', id: `tab-${id}`, 'aria-selected': String(id === activeTab),
        onclick: () => setTab(id),
      }, icon(ic), label, h('span', { class: 'badge', id: `badge-${id}`, hidden: true }, '0')))
  );
}

function setTab(id) {
  activeTab = id;
  for (const t of ['chat', 'queue', 'people']) {
    $(`#tab-${t}`).setAttribute('aria-selected', String(t === id));
    $(`#pane-${t}`).classList.toggle('active', t === id);
  }
  if (id === 'chat') { unread = 0; updateBadges(); const log = $('#chat-log'); log.scrollTop = log.scrollHeight; $('#chat-input').focus(); }
}

function updateBadges() {
  const set = (id, n, hot) => {
    const b = $(`#badge-${id}`);
    if (!b) return;
    b.hidden = !n;
    b.textContent = String(n);
    b.classList.toggle('hot', !!hot);
  };
  set('chat', unread, true);
  set('queue', queue.length, false);
  set('people', members.length, false);
}

// ------------------------------------------------------------------ room-level rendering

function applyRoom() {
  const title = $('#room-title');
  title.replaceChildren(...[room.name, room.locked ? h('span', { class: 'lock-badge', title: 'Password protected' }, ' ', icon('lock')) : null].filter(Boolean));
  $('#settings-btn').hidden = role() !== 'owner';
  const can = canControl();
  $('#play-now').disabled = !can;
  $('#play-now').title = can ? '' : 'Only the host can start videos in this room';
  $('#link-input').placeholder = can ? 'Paste a YouTube, Vimeo or video link' : 'Paste a link to add it to the queue';
  $('#queue-clear').hidden = !can || queue.length === 0;
  renderQueue();
  renderPeople();
  renderDock();
  if (controls) controls.refresh();
}

function setSyncStatus(s) {
  const pill = $('#sync-pill');
  if (!pill) return;
  pill.dataset.s = s === 'wait' ? 'wait' : 'ok';
  $('#sync-text').textContent = s === 'wait' ? 'Syncing' : 'In sync';
}

function onStatus(s) {
  const pill = $('#net-pill');
  pill.hidden = s === 'online';
  pill.dataset.s = 'off';
  $('#net-text').textContent = 'Reconnecting';
  if (sync) sync.ui.setStatus(s === 'online' ? 'ok' : 'wait');
}

// ------------------------------------------------------------------ link bar, queue

async function playNow() {
  const input = $('#link-input');
  const url = input.value.trim();
  if (!url) { input.focus(); return; }
  if (!canControl()) { toast('Only the host can start videos here. Add it to the queue instead.'); return; }
  const btn = $('#play-now');
  btn.disabled = true;
  const res = await sync.command('load', { url });
  btn.disabled = !canControl();
  if (res) input.value = '';
}

async function addToQueue() {
  const input = $('#link-input');
  const url = input.value.trim();
  if (!url) { input.focus(); return; }
  const nothingPlaying = !sync.state || !sync.state.provider;
  if (nothingPlaying && canControl()) return playNow();
  try {
    await api(`/rooms/${roomId}/playlist`, { method: 'POST', body: { action: 'add', url } });
    input.value = '';
    toast('Added to the queue.');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function setQueue(list) {
  queue = list || [];
  renderQueue();
  $('#queue-clear').hidden = !canControl() || queue.length === 0;
  if (controls) controls.setQueueSize(queue.length);
  updateBadges();
}

function renderQueue() {
  const box = $('#queue-list');
  if (!queue.length) {
    box.replaceChildren(h('p', { class: 'empty-note' }, 'The queue is empty. Paste a link and choose Add to queue.'));
    return;
  }
  const can = canControl();
  box.replaceChildren(...queue.map((item) => {
    const thumb = h('div', { class: 'q-thumb' });
    if (item.provider === 'youtube') thumb.style.backgroundImage = `url(https://i.ytimg.com/vi/${encodeURIComponent(item.mediaId)}/mqdefault.jpg)`;
    else thumb.append(icon(item.provider === 'vimeo' ? 'film' : 'play'));
    const mine = item.addedById === me.id;
    return h('div', { class: 'q-item' },
      thumb,
      h('div', null, h('div', { class: 'q-title', dir: 'auto' }, item.title || item.url), h('div', { class: 'q-meta', dir: 'auto' }, `Added by ${item.addedBy}`)),
      h('div', { class: 'q-actions' },
        can && h('button', { class: 'btn btn-sm btn-icon', type: 'button', title: 'Play now', 'aria-label': 'Play now',
          onclick: () => api(`/rooms/${roomId}/playlist`, { method: 'POST', body: { action: 'play', id: item.id } }).catch((e) => toast(e.message, 'error')) }, icon('play')),
        (can || mine) && h('button', { class: 'btn btn-sm btn-icon btn-ghost', type: 'button', title: 'Remove', 'aria-label': 'Remove from queue',
          onclick: () => api(`/rooms/${roomId}/playlist`, { method: 'POST', body: { action: 'remove', id: item.id } }).catch((e) => toast(e.message, 'error')) }, icon('x'))));
  }));
}

// ------------------------------------------------------------------ chat

function addMessage(msg) {
  if (!msg || seenChat.has(msg.id)) return;
  seenChat.add(msg.id);
  const log = $('#chat-log');
  const empty = log.querySelector('.chat-empty');
  if (empty) empty.remove();
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 90;

  if (msg.kind === 'system') {
    log.append(h('div', { class: 'sys', dir: 'auto' }, msg.text));
  } else {
    log.append(h('div', { class: 'msg' },
      avatar(msg.author),
      h('div', null,
        h('div', null, h('span', { class: 'who', style: { color: msg.author.color }, dir: 'auto' }, msg.author.name), h('span', { class: 'when' }, timeLabel(msg.createdAt))),
        h('div', { class: 'txt', dir: 'auto' }, linkify(msg.text)))));
    if (msg.author.id !== (me && me.id) && activeTab !== 'chat') { unread++; updateBadges(); }
  }
  floatMessage(msg);
  while (log.children.length > 300) log.firstChild.remove();
  if (nearBottom || (msg.author && me && msg.author.id === me.id)) log.scrollTop = log.scrollHeight;
}

const addSystem = (text) => addMessage({ id: `sys-${Date.now()}-${Math.random()}`, kind: 'system', text, createdAt: Date.now() });

async function postChat(input) {
  const text = input.value.trim();
  if (!text) return false;
  input.value = '';
  try {
    const res = await api(`/rooms/${roomId}/chat`, { method: 'POST', body: { text } });
    addMessage(res.message);
    return true;
  } catch (err) {
    input.value = text;
    toast(err.message, 'error');
    return false;
  }
}

async function sendChat(e) {
  e.preventDefault();
  await postChat($('#chat-input'));
}

// ------------------------------------------------------------------ theater mode, full screen, chat over the video

const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const isFull = () => fsElement() === $('#shell') || $('#shell').classList.contains('fake-full');
const overlayOn = () => isFull() || theater;

// Full screen is given to the whole player shell, not to the bare video, so the controls, the chat
// lines and everyone's camera stay on screen. Phones that refuse element full screen get a page-sized
// version of the same thing.
async function toggleFullscreen() {
  const el = $('#shell');
  if (isFull()) {
    if (fsElement()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      try { await exit.call(document); } catch (_) { /* the change event still fires */ }
    } else {
      el.classList.remove('fake-full');
      onFullChange();
    }
    return;
  }
  const request = el.requestFullscreen || el.webkitRequestFullscreen;
  if (request) {
    try { await request.call(el); return; } catch (_) { /* fall back below */ }
  }
  el.classList.add('fake-full');
  onFullChange();
}

function onFullChange() {
  const on = isFull();
  document.body.classList.toggle('is-full', on);
  if (controls) controls.setFullscreen(on);
  syncOverlay();
}

function toggleTheater() {
  theater = !theater;
  $('#room-main').classList.toggle('theater', theater);
  if (controls) controls.setTheater(theater);
  syncOverlay();
}

// In theater mode and full screen the picture is all there is, so the chat lines and everyone's
// camera ride on top of it instead of living in the side panel and the strip below.
function syncOverlay() {
  const on = overlayOn();
  $('#chat-float').classList.toggle('on', on);
  const strip = $('#strip');
  if (on) {
    if (strip.parentNode !== $('#stage')) $('#stage').append(strip);
  } else {
    if (strip.parentNode !== $('#stage-col')) $('#dock').after(strip);
    closeFloatChat();
    $('#cf-log').replaceChildren();
  }
}

// Enter (or the chat button) opens a one-line box over the video. Returns false when there is nothing to open.
function openFloatChat(viaKey) {
  if (!overlayOn()) {
    if (viaKey) return false;
    setTab('chat');
    return true;
  }
  $('#cf-form').hidden = false;
  $('#cf-input').focus();
  return true;
}

function closeFloatChat() {
  const form = $('#cf-form');
  if (form.hidden) return;
  form.hidden = true;
  $('#cf-input').blur();
}

function floatMessage(msg) {
  if (!overlayOn() || msg.kind === 'system' || !msg.author) return;
  const log = $('#cf-log');
  const line = h('div', { class: 'cf-line' },
    h('b', { style: { color: msg.author.color }, dir: 'auto' }, msg.author.name), ' ', h('span', { dir: 'auto' }, msg.text));
  log.append(line);
  while (log.children.length > 6) log.firstChild.remove();
  const fade = () => {
    if (!$('#cf-form').hidden) return setTimeout(fade, 3000); // keep the conversation up while someone is typing
    line.classList.add('fade');
    setTimeout(() => line.remove(), 500);
  };
  setTimeout(fade, 9000);
}

// ------------------------------------------------------------------ realtime events

function onEvent(name, data) {
  if (ended) return;
  if (name === 'state') {
    sync.receive(data.state);
    const by = data.by;
    if (by && by.id !== me.id) {
      const s = data.state;
      const text = { play: `${by.name} pressed play`, pause: `${by.name} paused`, seek: `${by.name} jumped to ${fmt(s.position)}`, rate: `${by.name} set the speed to ${s.rate}x` }[data.action];
      if (text) toast(text, 'info', 1800);
    }
  } else if (name === 'chat') {
    addMessage(data);
  } else if (name === 'playlist') {
    setQueue(data.playlist);
  } else if (name === 'room') {
    const before = room.control;
    room = data.room;
    applyRoom();
    if (before !== room.control) toast(room.control === 'everyone' ? 'Everyone can control playback now.' : room.control === 'mods' ? 'Only the host and moderators can control playback now.' : 'Only the host can control playback now.');
  } else if (name === 'kick') {
    if (data.uid === me.id) {
      if (call) call.destroy();
      if (rt) rt.close();
      if (sync) sync.destroy();
      if (controls) controls.destroy();
      fatal('You were removed from this room', `${data.by || 'The host'} removed you.`);
    }
  } else if (name === 'closed') {
    if (call) call.destroy();
    if (rt) rt.close();
    if (sync) sync.destroy();
    if (controls) controls.destroy();
    fatal('This room was closed', 'The host deleted it.');
  }
}

function onMembers(list) {
  members = list;
  if (call) call.syncMembers(list);
  renderPeople();
  renderStrip();
  renderDock();
  updateScreenView();
  updateBadges();
  const inCall = list.filter((m) => m.inCall).length;
  if (call && call.inCall && inCall > 6 && !onMembers.warned) {
    onMembers.warned = true;
    toast('Calls with more than 6 people can get choppy. Turning cameras off helps.', 'info', 6000);
  }
}

// ------------------------------------------------------------------ people

function renderPeople() {
  const box = $('#people-list');
  if (!box || !room) return;
  const r = role();
  const sorted = [...members].sort((a, b) => (a.uid === room.ownerId ? -1 : b.uid === room.ownerId ? 1 : a.name.localeCompare(b.name)));
  box.replaceChildren(...sorted.map((m) => {
    const isOwner = m.uid === room.ownerId;
    const isMod = room.mods.includes(m.uid);
    const self = m.peerId === peerId;
    const canKick = !self && !isOwner && (r === 'owner' || (r === 'mod' && !isMod));
    return h('div', { class: 'person' },
      avatar(m),
      h('div', null,
        h('div', { class: 'nm' }, h('span', { dir: 'auto' }, m.name), self && h('span', { class: 'hint' }, '(you)'),
          isOwner && h('span', { class: 'role' }, 'Host'), isMod && h('span', { class: 'role' }, 'Moderator')),
        h('div', { class: 'state' },
          m.inCall && h('span', { title: 'In the voice call' }, icon('headphones')),
          m.inCall && !m.mic && h('span', { title: 'Muted' }, icon('micOff')),
          m.cam && h('span', { title: 'Camera on' }, icon('video')),
          m.screen && h('span', { title: 'Sharing screen' }, icon('screen')))),
      h('div', { class: 'acts' },
        r === 'owner' && !self && !isOwner && h('button', { class: 'btn btn-sm btn-icon btn-ghost', type: 'button', title: isMod ? 'Remove moderator' : 'Make moderator', 'aria-label': isMod ? 'Remove moderator' : 'Make moderator',
          onclick: () => api(`/rooms/${roomId}/mods`, { method: 'POST', body: { uid: m.uid, mod: !isMod } }).catch((e) => toast(e.message, 'error')) }, icon('shield')),
        canKick && h('button', { class: 'btn btn-sm btn-icon btn-ghost', type: 'button', title: 'Remove from room', 'aria-label': `Remove ${m.name}`,
          onclick: () => removePerson(m) }, icon('ban'))));
  }));
}

function removePerson(m) {
  const modal = openModal({
    title: `Remove ${m.name}?`,
    sub: 'They will be disconnected and cannot rejoin this room.',
    actions: [
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => modal.close() }, 'Cancel'),
      h('button', { class: 'btn btn-danger', type: 'button', onclick: async () => {
        modal.close();
        try { await api(`/rooms/${roomId}/kick`, { method: 'POST', body: { uid: m.uid } }); toast(`${m.name} was removed.`); } catch (e) { toast(e.message, 'error'); }
      } }, 'Remove'),
    ],
  });
}

// ------------------------------------------------------------------ voice, camera, screen share

function renderDock() {
  const dock = $('#dock');
  if (!dock || !call || !room) return;
  const sharers = members.filter((m) => m.screen && m.peerId !== peerId);
  const btn = (cls, ic, label, onclick, extra = {}) => h('button', { class: `btn ${cls}`, type: 'button', title: label, 'aria-label': label, onclick, ...extra }, icon(ic), extra.text && h('span', { class: 'label-long' }, extra.text));

  const calls = call.inCall
    ? h('div', { class: 'group' },
      btn(call.micOn ? 'is-on' : 'is-off', call.micOn ? 'mic' : 'micOff', call.micOn ? 'Mute microphone' : 'Unmute microphone', () => call.toggleMic()),
      btn(call.camOn ? 'is-on' : '', call.camOn ? 'video' : 'videoOff', call.camOn ? 'Turn camera off' : 'Turn camera on', () => call.toggleCam()),
      call.canShareScreen && btn(call.screenOn ? 'is-live' : '', 'screen', call.screenOn ? 'Stop sharing your screen' : 'Share your screen', () => call.toggleScreen(), { text: call.screenOn ? 'Stop sharing' : 'Share screen' }),
      btn('btn-danger', 'hangup', 'Leave the voice call', () => call.leave(), { text: 'Leave' }))
    : h('div', { class: 'group' }, h('button', { class: 'btn', type: 'button', title: 'Join voice chat', 'aria-label': 'Join voice chat', onclick: () => call.join() }, icon('headphones'), 'Join voice'));

  const watchBtns = sharers
    .filter((m) => call.inCall ? watching !== m.peerId : false)
    .map((m) => h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { watching = m.peerId; updateScreenView(); renderDock(); } }, icon('screen'), h('span', { dir: 'auto' }, `Watch ${m.name}'s screen`)));
  const joinToWatch = !call.inCall && sharers.length
    ? [h('button', { class: 'btn btn-primary', type: 'button', onclick: () => call.join() }, icon('screen'), h('span', { dir: 'auto' }, `Join voice to watch ${sharers[0].name}'s screen`))]
    : [];

  dock.replaceChildren(
    calls, ...watchBtns, ...joinToWatch,
    h('span', { class: 'hint', id: 'now-title', style: { flex: '1', minWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, dir: 'auto' }, nowTitle || 'Nothing playing'),
    h('span', { class: 'sync-pill', id: 'sync-pill', 'data-s': 'ok' }, h('i'), h('span', { id: 'sync-text' }, 'In sync')),
    h('button', { class: 'btn btn-sm btn-ghost btn-icon', type: 'button', title: 'Reload the video and sync again', 'aria-label': 'Resync', onclick: resync }, icon('refresh'))
  );
}

async function resync() {
  try {
    sync.mediaKey = null; // forces a clean reload of the player
    await refreshSnapshot(true);
    toast('Resynced with the room.');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function tileFor(m) {
  let t = tiles.get(m.peerId);
  if (!t) {
    const video = h('video', { autoplay: true, playsInline: true, muted: true, hidden: true });
    const av = avatar(m);
    const name = h('div', { class: 'nm' });
    t = { el: h('div', { class: 'tile in-call' }, video, av, name), video, av, name };
    tiles.set(m.peerId, t);
  }
  return t;
}

function renderStrip() {
  const strip = $('#strip');
  if (!strip || !call) return;
  const live = members.filter((m) => m.inCall);
  strip.hidden = live.length === 0;
  const keep = new Set();
  const nodes = [];
  for (const m of live) {
    keep.add(m.peerId);
    const t = tileFor(m);
    const self = m.peerId === peerId;
    const stream = self ? call.localStreams.cam : streams.get(`${m.peerId}:cam`);
    const showVideo = m.cam && !!stream;
    if (showVideo && t.video.srcObject !== stream) t.video.srcObject = stream;
    t.video.hidden = !showVideo;
    t.video.muted = true;
    t.av.hidden = showVideo;
    t.el.classList.toggle('speaking', speakingNow.has(m.peerId));
    t.name.replaceChildren(...[!m.mic ? icon('micOff') : null, h('span', { dir: 'auto' }, self ? `${m.name} (you)` : m.name)].filter(Boolean));
    nodes.push(t.el);
  }
  for (const [id, t] of tiles) if (!keep.has(id)) { t.video.srcObject = null; tiles.delete(id); }
  if (call.screenOn && call.localStreams.screen) {
    let mine = tiles.get('__screen');
    if (!mine) {
      const video = h('video', { autoplay: true, playsInline: true, muted: true });
      mine = { el: h('div', { class: 'tile in-call' }, video, h('div', { class: 'nm' }, h('span', null, 'Your screen'))), video };
      tiles.set('__screen', mine);
    }
    if (mine.video.srcObject !== call.localStreams.screen) mine.video.srcObject = call.localStreams.screen;
    keep.add('__screen');
    nodes.push(mine.el);
  } else if (tiles.has('__screen')) {
    tiles.delete('__screen');
  }
  strip.replaceChildren(...nodes);
}

function onSpeaking(id, on) {
  if (on) speakingNow.add(id); else speakingNow.delete(id);
  const t = tiles.get(id);
  if (t) t.el.classList.toggle('speaking', on);
}

function onRemoteStream(id, kind, stream) {
  const key = `${id}:${kind}`;
  if (stream) streams.set(key, stream); else streams.delete(key);

  if (kind === 'mic') {
    let a = document.getElementById(`aud-${id}`);
    if (stream) {
      if (!a) {
        a = h('audio', { id: `aud-${id}`, autoplay: true, playsInline: true });
        $('#audio-sink').append(a);
      }
      if (a.srcObject !== stream) a.srcObject = stream;
      a.play().catch(() => {});
    } else if (a) {
      a.srcObject = null;
      a.remove();
    }
  }
  if (kind === 'cam') renderStrip();
  if (kind === 'screen') updateScreenView();
}

function updateScreenView() {
  if (!call || !room) return;
  const sharers = members.filter((m) => m.screen && m.peerId !== peerId);
  const ids = new Set(sharers.map((m) => m.peerId));
  for (const id of [...autoWatched]) if (!ids.has(id)) autoWatched.delete(id);
  if (watching && !ids.has(watching)) watching = null;
  if (call.inCall) {
    for (const m of sharers) {
      if (!autoWatched.has(m.peerId)) { autoWatched.add(m.peerId); watching = m.peerId; } // a new share opens itself
    }
  }
  const view = $('#screen-view');
  const video = $('#screen-video');
  view.hidden = !watching;
  $('#stage').classList.toggle('screen-on', !!watching);
  if (watching) {
    const who = members.find((m) => m.peerId === watching);
    $('#screen-who').textContent = who ? `${who.name} is sharing their screen` : 'Shared screen';
    const stream = streams.get(`${watching}:screen`) || null;
    if (video.srcObject !== stream) video.srcObject = stream;
    video.play().catch(() => {});
  } else if (video.srcObject) {
    video.srcObject = null;
  }
}

// ------------------------------------------------------------------ invite and settings

function openInvite() {
  const url = `${location.origin}/r/${room.id}`;
  const input = h('input', { class: 'field', readOnly: true, value: url, 'aria-label': 'Invite link', onfocus: (e) => e.target.select() });
  const copy = async () => { if (await copyText(url)) toast('Invite link copied.'); else { input.select(); toast('Press Ctrl+C to copy.'); } };
  const modal = openModal({
    title: 'Invite friends',
    sub: room.locked ? 'Anyone with this link also needs the room password.' : 'Anyone with this link can join.',
    content: h('div', { class: 'copy-row' }, input, h('button', { class: 'btn btn-primary', type: 'button', onclick: copy }, 'Copy link')),
    actions: [
      navigator.share && h('button', { class: 'btn', type: 'button', onclick: () => navigator.share({ title: room.name, url }).catch(() => {}) }, 'Share'),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => modal.close() }, 'Done'),
    ],
  });
  copy();
}

function openSettings() {
  const isUser = me.kind === 'user';
  const name = h('input', { class: 'field', id: 's-name', maxLength: 40, value: room.name, dir: 'auto' });
  const control = h('select', { class: 'field', id: 's-control' },
    h('option', { value: 'everyone' }, 'Everyone in the room'),
    h('option', { value: 'mods' }, 'The host and moderators'),
    h('option', { value: 'host' }, 'Only the host'));
  control.value = room.control;
  const pass = h('input', { class: 'field', id: 's-pass', type: 'password', maxLength: 64, autocomplete: 'new-password', placeholder: room.locked ? 'Type a new password to change it' : 'No password' });
  const removePass = room.locked ? h('label', { class: 'row', style: { cursor: 'pointer', marginTop: '8px' } }, h('input', { type: 'checkbox', id: 's-rm' }), h('span', null, 'Remove the password')) : null;
  const perm = h('input', { type: 'checkbox', id: 's-perm', checked: !!room.permanent, disabled: !isUser });
  const err = h('p', { class: 'err', role: 'alert' });
  let armed = false;

  const del = h('button', { class: 'btn btn-danger', type: 'button', onclick: async () => {
    if (!armed) { armed = true; del.textContent = 'Click again to delete for everyone'; return; }
    try { await api(`/rooms/${roomId}`, { method: 'DELETE' }); location.href = '/'; } catch (e) { err.textContent = e.message; }
  } }, icon('trash'), 'Delete room');

  const save = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
    err.textContent = '';
    const body = { name: name.value, control: control.value };
    if (removePass && removePass.querySelector('input').checked) body.password = '';
    else if (pass.value) body.password = pass.value;
    if (isUser) body.permanent = perm.checked;
    try {
      const res = await api(`/rooms/${roomId}`, { method: 'PATCH', body });
      room = res.room;
      applyRoom();
      document.title = `${room.name} - ${session.cfg.appName}`;
      modal.close();
      toast('Room settings saved.');
    } catch (e) { err.textContent = e.message; }
  } }, 'Save changes');

  const modal = openModal({
    title: 'Room settings',
    content: h('div', { class: 'stack' },
      h('div', null, h('label', { class: 'lbl', for: 's-name' }, 'Room name'), name),
      h('div', null, h('label', { class: 'lbl', for: 's-control' }, 'Who can press play, pause and seek'), control),
      h('div', null, h('label', { class: 'lbl', for: 's-pass' }, 'Room password'), pass, removePass),
      h('div', null,
        h('label', { class: 'row', style: { cursor: isUser ? 'pointer' : 'not-allowed' } }, perm, h('span', null, 'Keep this room forever')),
        !isUser && h('p', { class: 'hint', style: { marginTop: '6px' } }, 'Create a free account to keep rooms forever.')),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => { try { await api(`/rooms/${roomId}/unban-all`, { method: 'POST' }); toast('Everyone who was removed can rejoin now.'); } catch (e) { toast(e.message, 'error'); } } }, 'Let removed people rejoin'),
      err),
    actions: [del, save],
  });
}

boot();
