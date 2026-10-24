// The sync engine: keeps this browser's player on the same second as the room.
//
// The server stores one anchor: { playing, position, updatedAt, rate, version }.
// Every client derives the same "expected position" from it, so play/pause/seek only need to be
// sent once, and people who join late (or reconnect) land on the right second automatically.
//
// Two directions:
//   remote -> local   receive(state) applies a new anchor to the player
//   local  -> remote  reconcile() notices what the user did (pressed pause, dragged the scrubber,
//                     changed speed) and sends it, unless they are not allowed to control playback

import { api, serverNow } from './api.js';
import { createPlayer } from './players.js';

const keyOf = (s) => `${s.provider}|${s.mediaId}`;
const now = () => performance.now();

export class SyncController {
  constructor({ host, roomId, canControl, ui }) {
    this.host = host;
    this.roomId = roomId;
    this.canControl = canControl; // () => boolean
    this.ui = ui;                 // { setEmpty, setLoading, showTap, setStatus, toast, onMedia }

    this.state = null;
    this.player = null;
    this.audio = { volume: 1, muted: false }; // this viewer's own volume: never sent to the room
    this.mediaKey = null;
    this.loading = false;
    this.chain = Promise.resolve();

    this.suppressUntil = 0;  // ignore the player while we are the one moving it
    this.holdUntil = 0;      // ignore the player while our own request is in flight
    this.awaiting = false;   // we asked the player to play but it has not started (autoplay blocked?)
    this.awaitSince = 0;
    this.last = null;        // previous tick, for spotting seeks
    this.lastHardSync = 0;
    this.endedFor = -1;
    this.pokeTimer = null;
    this.timer = setInterval(() => this.reconcile(), 500);
  }

  destroy() {
    clearInterval(this.timer);
    clearTimeout(this.pokeTimer);
    if (this.player) this.player.destroy();
  }

  // ------------------------------------------------------------ remote -> local

  expected(state = this.state) {
    if (!state) return 0;
    if (!state.playing) return state.position;
    return state.position + ((serverNow() - state.updatedAt) / 1000) * (state.rate || 1);
  }

  receive(state, { force = false } = {}) {
    this.chain = this.chain.then(() => this.apply(state, force)).catch((e) => console.error('[sync]', e));
    return this.chain;
  }

  async apply(state, force) {
    const cur = this.state;
    if (cur && !force && state.version <= cur.version) return; // stale or duplicate
    this.state = state;
    this.ui.onMedia && this.ui.onMedia(state);

    if (!state.provider) {
      this.clear();
      return;
    }
    if (keyOf(state) !== this.mediaKey) {
      await this.load(state);
      return;
    }
    this.syncPlayer();
  }

  clear() {
    if (this.player) { this.player.destroy(); this.player = null; }
    this.mediaKey = null;
    this.awaiting = false;
    this.ui.showTap(false);
    this.ui.setEmpty(true);
    this.ui.setStatus('ok');
  }

  async load(state) {
    this.mediaKey = keyOf(state);
    this.loading = true;
    this.ui.setEmpty(false);
    this.ui.setLoading(true);
    this.ui.showTap(false);
    try {
      if (!this.player || this.player.provider !== state.provider || !this.player.reusable) {
        if (this.player) this.player.destroy();
        this.player = createPlayer(state.provider, this.host, {
          poke: () => this.poke(),
          error: (msg) => this.ui.toast(msg, 'error'),
          audio: () => this.audio,
        });
      }
      this.suppress(2500);
      await this.player.load({ provider: state.provider, mediaId: state.mediaId, url: state.url }, this.expected(), state.playing);
      this.player.setAudio(this.audio.volume, this.audio.muted);
      this.awaiting = state.playing;
      this.awaitSince = now();
    } catch (err) {
      this.mediaKey = null;
      this.ui.toast(err.message || 'The video could not be loaded.', 'error');
    } finally {
      this.loading = false;
      this.ui.setLoading(false);
      this.last = null;
    }
    this.syncPlayer(); // the room may have moved on while the player was loading
  }

  // Volume belongs to each viewer, so it only ever touches the local player.
  setAudio(volume, muted) {
    this.audio = { volume, muted };
    if (this.player) this.player.setAudio(volume, muted);
  }

  suppress(ms) { this.suppressUntil = now() + ms; this.last = null; this.pausedSince = 0; this.playingSince = 0; }

  // Move the local player to whatever the shared anchor says.
  syncPlayer() {
    const p = this.player;
    const s = this.state;
    if (!p || !s || this.loading) return;
    this.suppress(700);
    this.holdUntil = 0;

    const ps = p.playState();
    const exp = this.expected(s);
    if (s.playing) {
      if (ps !== 'playing' && ps !== 'buffering') {
        if (!this.awaiting) { this.awaiting = true; this.awaitSince = now(); }
        p.play();
      }
      if (Math.abs(p.getTime() - exp) > 0.4) p.seek(exp);
    } else {
      this.awaiting = false;
      this.ui.showTap(false);
      if (ps === 'playing' || ps === 'buffering') p.pause();
      if (Math.abs(p.getTime() - s.position) > 0.3) p.seek(s.position);
    }
    if (Math.abs(p.getRate() - s.rate) > 0.01) p.setRate(s.rate);
  }

  // The "click to join" overlay: a real click satisfies the browser's autoplay policy.
  tapToPlay() {
    this.ui.showTap(false);
    this.awaiting = false;
    if (!this.player || !this.state) return;
    this.suppress(1500);
    this.player.play();
    if (this.state.playing) this.player.seek(this.expected());
  }

  // ------------------------------------------------------------ local -> remote

  poke() {
    clearTimeout(this.pokeTimer);
    this.pokeTimer = setTimeout(() => this.reconcile(), 120);
  }

  async reconcile() {
    const p = this.player;
    const s = this.state;
    const t = now();
    if (!p || !s || this.loading) return;

    const ps = p.playState();
    const cur = p.getTime();
    const rate = p.getRate();

    // Seeing the video play proves autoplay worked, even if it happened while we were not listening for user actions.
    if (ps === 'playing') {
      this.awaiting = false;
      this.ui.showTap(false);
    }

    // While we are moving the player ourselves (or waiting on our own request), do not treat its
    // changes as user actions. Keep the baseline fresh so a seek right after this window is still noticed.
    if (t < this.suppressUntil || t < this.holdUntil) {
      this.last = { t: cur, at: t, playing: ps === 'playing', rate };
      return;
    }

    // 1. Did the user drag the scrubber? Time jumped by more than playback can explain.
    if (this.last) {
      const dt = (t - this.last.at) / 1000;
      const predicted = this.last.t + (this.last.playing ? dt * this.last.rate : 0);
      if (dt < 3 && Math.abs(cur - predicted) > 1.2) {
        this.last = { t: cur, at: t, playing: ps === 'playing', rate };
        this.send('seek', { position: cur });
        return;
      }
    }

    // 2. Did the user press play or pause?
    if (ps !== 'paused') this.pausedSince = 0;
    if (ps !== 'playing') this.playingSince = 0;
    if (ps === 'playing') {
      this.awaiting = false;
      this.ui.showTap(false);
      if (!s.playing) {
        // Same caution as for pause: a player that is still catching up with a remote pause may briefly say "playing".
        if (!this.playingSince) {
          this.playingSince = t;
          setTimeout(() => this.reconcile(), 300);
          return;
        }
        if (t - this.playingSince < 250) return;
        this.playingSince = 0;
        this.last = null;
        this.send('play', { position: cur });
        return;
      }
    } else if (ps === 'paused' && s.playing && !this.awaiting) {
      // Some players report a brief "paused" while seeking. Only believe a pause that sticks.
      if (!this.pausedSince) {
        this.pausedSince = t;
        setTimeout(() => this.reconcile(), 300);
        return;
      }
      if (t - this.pausedSince < 250) return;
      this.pausedSince = 0;
      this.last = null;
      this.send('pause', { position: cur });
      return;
    } else if (ps === 'ended' && s.playing && this.endedFor !== s.version) {
      this.endedFor = s.version;
      this.holdUntil = t + 1500;
      api(`/rooms/${this.roomId}/state`, { method: 'POST', body: { action: 'ended', version: s.version } })
        .then((res) => res.state && this.receive(res.state))
        .catch(() => {});
      return;
    }

    // 3. Did the user change playback speed?
    if (this.last && Math.abs(rate - this.last.rate) > 0.01 && Math.abs(rate - s.rate) > 0.01 && ps !== 'unstarted') {
      this.last = { t: cur, at: t, playing: ps === 'playing', rate };
      this.send('rate', { rate });
      return;
    }

    // 4. Drifted away because of buffering or a slow device? Jump back (at most every 5 seconds).
    if (s.playing && ps === 'playing' && t - this.lastHardSync > 5000) {
      if (Math.abs(cur - this.expected(s)) > 1.6) {
        this.lastHardSync = t;
        this.suppress(1200);
        p.seek(this.expected(s));
        return;
      }
    }

    // 5. "Click to join" if autoplay was blocked.
    if (this.awaiting && ps !== 'playing' && ps !== 'buffering' && t - this.awaitSince > 1800) this.ui.showTap(true);

    this.ui.setStatus(this.awaiting || ps === 'buffering' ? 'wait' : 'ok');
    this.last = { t: cur, at: t, playing: ps === 'playing', rate };
  }

  async send(action, extra = {}) {
    if (!this.canControl()) {
      this.ui.toast('Only the host can control playback in this room.');
      this.syncPlayer();
      return null;
    }
    this.holdUntil = now() + 2000;
    try {
      const res = await api(`/rooms/${this.roomId}/state`, { method: 'POST', body: { action, ...extra } });
      if (res.state) await this.receive(res.state);
      this.holdUntil = 0;
      return res;
    } catch (err) {
      this.holdUntil = 0;
      this.ui.toast(err.message, 'error');
      this.syncPlayer();
      return null;
    }
  }

  // Used by the link bar and queue.
  command(action, extra) { return this.send(action, extra); }

  // A deliberate action from the room's own control bar (or a keyboard shortcut): move this player
  // straight away so it feels instant, then tell the room. Returns false when it was not allowed.
  async act(action, extra = {}) {
    const p = this.player;
    if (!p || !this.state || this.loading) return false;
    if (!this.canControl()) {
      this.ui.toast('Only the host can control playback in this room.');
      return false;
    }
    this.suppress(1500);
    this.awaiting = false;
    this.ui.showTap(false);
    const moved = typeof extra.position === 'number' && Math.abs(p.getTime() - extra.position) > 0.3;
    if (action === 'play') { p.play(); if (moved) p.seek(extra.position); }
    else if (action === 'pause') { p.pause(); if (moved) p.seek(extra.position); }
    else if (action === 'seek') p.seek(extra.position);
    else if (action === 'rate') p.setRate(extra.rate);
    return !!(await this.send(action, extra));
  }
}
