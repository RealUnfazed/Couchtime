// One interface over two transports, picked by the server (/api/config):
//   socketio  WebSocket to this same server (local, VPS, Render...)
//   ably      hosted realtime, used on Vercel where long-lived connections are impossible
//
// Events emitted:
//   'evt'          (name, data)   server broadcast: state, chat, playlist, room, kick, closed
//   'members'      (list)         everyone currently in the room, including me
//   'peer-join' | 'peer-leave' | 'peer-update'   (member)
//   'signal'       (fromPeerId, data)   WebRTC offers / answers / ICE candidates
//   'status'       ('online' | 'offline')
//   'reconnected'  ()             connection came back after a drop: re-fetch the room snapshot

import { api } from './api.js';

const scripts = {};
export function loadScript(src) {
  if (!scripts[src]) {
    scripts[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => { delete scripts[src]; reject(new Error(`Could not load ${new URL(src, location.href).host}`)); };
      document.head.append(s);
    });
  }
  return scripts[src];
}

class Transport {
  constructor({ roomId, peerId, me, getFlags }) {
    this.roomId = roomId;
    this.peerId = peerId;
    this.me = me;
    this.getFlags = getFlags;
    this.handlers = {};
    this.members = new Map(); // peerId -> member
  }
  on(name, fn) { (this.handlers[name] ||= []).push(fn); return this; }
  emit(name, ...args) { (this.handlers[name] || []).forEach((fn) => { try { fn(...args); } catch (e) { console.error(e); } }); }
  list() { return [...this.members.values()]; }
  replaceMembers(list) {
    const next = new Map(list.map((m) => [m.peerId, m]));
    for (const [id, m] of this.members) if (!next.has(id)) this.emit('peer-leave', m);
    for (const [id, m] of next) if (!this.members.has(id) && id !== this.peerId) this.emit('peer-join', m);
    this.members = next;
    this.emit('members', this.list());
  }
  upsert(member, kind) {
    const had = this.members.has(member.peerId);
    this.members.set(member.peerId, member);
    if (member.peerId !== this.peerId) this.emit(had ? 'peer-update' : 'peer-join', member);
    this.emit('members', this.list());
    return kind;
  }
  remove(peerId) {
    const m = this.members.get(peerId);
    if (!m) return;
    this.members.delete(peerId);
    this.emit('peer-leave', m);
    this.emit('members', this.list());
  }
}

const FLAGS = ['inCall', 'mic', 'cam', 'screen'];
const pickFlags = (d) => Object.fromEntries(FLAGS.map((k) => [k, !!(d && d[k])]));
const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#ffb547');
const safeName = (n) => String(n || 'Guest').slice(0, 24);

// ---------------------------------------------------------------- Socket.IO

class SocketTransport extends Transport {
  async connect() {
    await loadScript('/socket.io/socket.io.js');
    this.socket = window.io({ transports: ['websocket', 'polling'] });
    let first = true;
    let dropped = false;

    await new Promise((resolve, reject) => {
      const join = () => {
        this.socket.emit('join', { roomId: this.roomId, peerId: this.peerId, data: this.getFlags() }, (res) => {
          if (!res || !res.ok) {
            const err = new Error((res && res.error) || 'Could not join the room');
            if (first) reject(err); else this.emit('status', 'offline');
            return;
          }
          this.replaceMembers(res.members.map((m) => this.normalise(m)));
          this.emit('status', 'online');
          if (first) { first = false; resolve(); } else if (dropped) { dropped = false; this.emit('reconnected'); }
        });
      };
      this.socket.on('connect', join);
      this.socket.on('connect_error', (e) => { if (first) { this.socket.close(); reject(new Error(e.message || 'Could not reach the server')); } });
    });

    this.socket.on('disconnect', () => { dropped = true; this.emit('status', 'offline'); });
    this.socket.on('evt', ({ name, data }) => this.emit('evt', name, data));
    this.socket.on('signal', ({ from, data }) => this.emit('signal', from, data));
    this.socket.on('presence', ({ type, member }) => {
      const m = this.normalise(member);
      if (type === 'leave') this.remove(m.peerId);
      else this.upsert(m);
    });
  }
  normalise(m) {
    return { peerId: m.peerId, uid: m.uid, name: safeName(m.name), color: safeColor(m.color), ...pickFlags(m) };
  }
  setPresence(flags) { this.socket.emit('presence:update', flags); const me = this.members.get(this.peerId); if (me) { Object.assign(me, pickFlags(flags)); this.emit('members', this.list()); } }
  signal(to, data) { this.socket.emit('signal', { to, data }); }
  close() { try { this.socket.close(); } catch (_) { /* ignore */ } }
}

// ---------------------------------------------------------------- Ably

class AblyTransport extends Transport {
  async connect() {
    await loadScript('https://cdn.ably.com/lib/ably.min-2.js');
    const Ably = window.Ably;
    this.ably = new Ably.Realtime({
      echoMessages: false,
      // The browser never sees the API key: the server signs a short-lived, room-scoped token for us.
      authCallback: (_params, cb) => {
        api(`/rt/auth?room=${encodeURIComponent(this.roomId)}`)
          .then(({ serverTime, ...tokenRequest }) => cb(null, tokenRequest))
          .catch((e) => cb(e.message || 'Auth failed', null));
      },
    });

    this.roomCh = this.ably.channels.get(`room:${this.roomId}`);
    this.sigCh = this.ably.channels.get(`sig:${this.roomId}`);
    this.byConn = new Map(); // Ably connectionId -> member

    this.roomCh.subscribe((msg) => this.emit('evt', msg.name, msg.data));
    this.sigCh.subscribe('signal', (msg) => {
      const d = msg.data;
      if (d && d.to === this.peerId) this.emit('signal', d.from, d.data);
    });
    this.roomCh.presence.subscribe((pm) => this.onPresence(pm));

    let wasDown = false;
    this.ably.connection.on((change) => {
      if (change.current === 'connected') {
        this.emit('status', 'online');
        if (wasDown) { wasDown = false; this.emit('reconnected'); }
      } else if (['disconnected', 'suspended', 'failed'].includes(change.current)) {
        wasDown = true;
        this.emit('status', 'offline');
      }
    });

    await Promise.race([
      this.roomCh.presence.enter(this.selfData()),
      new Promise((_, rej) => setTimeout(() => rej(new Error('The realtime service did not answer. Check ABLY_API_KEY.')), 15000)),
    ]);
    await this.sigCh.attach();
    const present = await this.roomCh.presence.get();
    present.forEach((pm) => this.trackPresence(pm));
    this.emitAll();
  }
  selfData(flags = this.getFlags()) {
    return { peerId: this.peerId, name: this.me.name, color: this.me.color, ...pickFlags(flags) };
  }
  toMember(pm) {
    const d = pm.data || {};
    return { peerId: String(d.peerId || ''), uid: pm.clientId, name: safeName(d.name), color: safeColor(d.color), ...pickFlags(d) };
  }
  trackPresence(pm) {
    if (['leave', 'absent'].includes(pm.action)) { this.byConn.delete(pm.connectionId); return; }
    const m = this.toMember(pm);
    if (m.peerId) this.byConn.set(pm.connectionId, m);
  }
  emitAll() {
    this.replaceMembers([...this.byConn.values()]);
  }
  onPresence(pm) {
    const prev = this.byConn.get(pm.connectionId);
    this.trackPresence(pm);
    if (['leave', 'absent'].includes(pm.action)) { if (prev) this.remove(prev.peerId); return; }
    const m = this.byConn.get(pm.connectionId);
    if (m) this.upsert(m);
  }
  setPresence(flags) {
    const me = this.members.get(this.peerId);
    if (me) Object.assign(me, pickFlags(flags));
    this.roomCh.presence.update(this.selfData(flags)).catch(() => {});
    this.emit('members', this.list());
  }
  signal(to, data) {
    this.sigCh.publish('signal', { to, from: this.peerId, data }).catch(() => {});
  }
  close() { try { this.ably.close(); } catch (_) { /* ignore */ } }
}

export function createRealtime(driver, opts) {
  return driver === 'ably' ? new AblyTransport(opts) : new SocketTransport(opts);
}
