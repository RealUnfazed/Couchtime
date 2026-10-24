// The room's own player controls: one control bar that looks and behaves the same for YouTube, Vimeo
// and plain video files, because the provider's own controls are switched off (see players.js).
//
//   - play / pause, seek bar, next in queue and speed go through sync.act(): they move this player
//     straight away and tell the room. People who may not control playback see them dimmed, and a
//     click explains why.
//   - volume and mute are personal: they never leave this browser.
//   - sync, chat, theater mode and full screen are local too.
//
// The bar fades out while the video plays and nobody touches it, like every other video player.

import { h, icon } from './ui.js';

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const AUDIO_KEY = 'couchtime.audio';
const HIDE_AFTER = 2800;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function clock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

function loadAudio() {
  try {
    const a = JSON.parse(localStorage.getItem(AUDIO_KEY));
    if (a && typeof a.volume === 'number') return { volume: clamp(a.volume, 0, 1), muted: !!a.muted };
  } catch (_) { /* private mode or blocked storage: start at full volume */ }
  return { volume: 1, muted: false };
}

function saveAudio(a) {
  try { localStorage.setItem(AUDIO_KEY, JSON.stringify(a)); } catch (_) { /* optional */ }
}

function setIcon(button, name, label) {
  button.replaceChildren(icon(name));
  button.title = label;
  button.setAttribute('aria-label', label);
}

export class PlayerControls {
  // stage:  the 16:9 box that holds the video
  // sync:   SyncController
  // hooks:  onResync(), onTheater(), onFullscreen(), onChat(viaKey) -> boolean
  constructor({ stage, sync, toast, hooks }) {
    this.stage = stage;
    this.sync = sync;
    this.toast = toast;
    this.hooks = hooks;
    this.el = stage.querySelector('#ctl');
    this.shield = stage.querySelector('#shield');
    this.flashEl = stage.querySelector('#flash');

    this.audio = loadAudio();
    this.queueSize = 0;
    this.dragging = false;
    this.dragPos = 0;
    this.hover = false;
    this.menuOpen = false;
    this.idle = null;
    this.lockedToastAt = 0;
    this.lastPlaying = null;
    this.theater = false;
    this.full = false;

    this.build();
    this.bind();
    this.sync.setAudio(this.audio.volume, this.audio.muted);
    this.paintAudio();
    this.timer = setInterval(() => this.tick(), 250);
    this.show();
  }

  destroy() {
    clearInterval(this.timer);
    clearTimeout(this.idle);
    document.removeEventListener('keydown', this.keyHandler);
    document.removeEventListener('pointerdown', this.outsideHandler);
  }

  // ------------------------------------------------------------ building

  build() {
    const b = (cls, ic, label, onclick) => h('button', { class: `ctl-btn ${cls}`, type: 'button', title: label, 'aria-label': label, onclick }, icon(ic));

    this.seek = h('input', { class: 'ctl-seek', type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Seek' });
    this.playBtn = b('ctl-play', 'play', 'Play', () => this.togglePlay());
    this.nextBtn = b('ctl-next', 'skip', 'Play the next video in the queue', () => this.next());
    this.muteBtn = b('ctl-mute', 'volume', 'Mute', () => this.toggleMute());
    this.vol = h('input', { class: 'ctl-vol', type: 'range', min: 0, max: 100, step: 1, value: 100, 'aria-label': 'Volume' });
    this.time = h('span', { class: 'ctl-time' }, '0:00');

    this.rateBtn = h('button', { class: 'ctl-btn ctl-rate', type: 'button', title: 'Playback speed', 'aria-label': 'Playback speed', 'aria-haspopup': 'true', onclick: () => this.toggleMenu() }, '1x');
    this.menu = h('div', { class: 'ctl-menu', role: 'menu', hidden: true },
      ...RATES.map((r) => h('button', { class: 'ctl-mi', type: 'button', role: 'menuitemradio', dataset: { rate: String(r) }, onclick: () => this.pickRate(r) }, r === 1 ? 'Normal' : `${r}x`)));
    this.rateWrap = h('div', { class: 'ctl-rate-wrap' }, this.rateBtn, this.menu);

    this.syncBtn = b('ctl-sync', 'refresh', 'Sync with the room', () => this.hooks.onResync());
    this.chatBtn = b('ctl-chat', 'chat', 'Chat (Enter)', () => this.hooks.onChat(false));
    this.theaterBtn = b('ctl-theater', 'theater', 'Theater mode (T)', () => this.hooks.onTheater());
    this.fullBtn = b('ctl-full', 'maximize', 'Full screen (F)', () => this.hooks.onFullscreen());

    this.el.replaceChildren(
      this.seek,
      h('div', { class: 'ctl-row' },
        this.playBtn, this.nextBtn,
        h('div', { class: 'ctl-volwrap' }, this.muteBtn, this.vol),
        this.time,
        h('span', { class: 'spacer' }),
        this.rateWrap, this.syncBtn, this.chatBtn, this.theaterBtn, this.fullBtn));
    setIcon(this.playBtn, 'play', 'Play');
  }

  bind() {
    const stage = this.stage;

    // Showing and hiding the bar.
    for (const ev of ['pointermove', 'pointerdown', 'focusin']) stage.addEventListener(ev, () => this.show());
    stage.addEventListener('pointerleave', () => this.schedule(700));
    this.el.addEventListener('pointerenter', () => { this.hover = true; });
    this.el.addEventListener('pointerleave', () => { this.hover = false; this.schedule(); });

    // Clicking the picture plays and pauses, like everywhere else. On a touch screen the first tap
    // only brings the bar back.
    this.shield.addEventListener('pointerdown', (e) => { this.ptype = e.pointerType; this.wasHidden = stage.classList.contains('ui-hidden'); });
    this.shield.addEventListener('click', () => {
      if (this.ptype === 'touch' && this.wasHidden) return;
      if (!this.sync.canControl() && this.sync.state && this.sync.state.playing) return; // nothing to do for a viewer
      this.togglePlay();
    });
    this.flashEl.addEventListener('animationend', () => { this.flashEl.hidden = true; });

    // Seek bar: dragging only previews, letting go sends it.
    this.seek.addEventListener('input', () => {
      if (!this.allowed(true)) { this.tick(); return; }
      const dur = this.sync.player ? this.sync.player.getDuration() : 0;
      this.dragging = true;
      this.dragPos = (Number(this.seek.value) / 1000) * dur;
      this.paintSeek(this.dragPos, dur, this.sync.player.getBuffered());
    });
    this.seek.addEventListener('change', () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.sync.act('seek', { position: this.dragPos });
    });
    this.seek.addEventListener('pointercancel', () => { this.dragging = false; });

    // Volume.
    this.vol.addEventListener('input', () => {
      const v = Number(this.vol.value) / 100;
      this.setAudio(v, v === 0);
    });

    // Keyboard shortcuts and closing the speed menu.
    this.keyHandler = (e) => this.onKey(e);
    this.outsideHandler = (e) => { if (this.menuOpen && !this.rateWrap.contains(e.target)) this.closeMenu(); };
    document.addEventListener('keydown', this.keyHandler);
    document.addEventListener('pointerdown', this.outsideHandler);
  }

  // ------------------------------------------------------------ visibility

  show() {
    this.stage.classList.remove('ui-hidden');
    this.schedule();
  }

  schedule(ms = HIDE_AFTER) {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      const s = this.sync.state;
      const busy = this.hover || this.dragging || this.menuOpen || this.el.querySelector(':focus-visible');
      if (s && s.playing && !busy) this.stage.classList.add('ui-hidden');
      else if (s && s.playing) this.schedule(); // still busy: look again later
    }, ms);
  }

  // ------------------------------------------------------------ permissions

  // `quiet` skips the explanation toast when the person is only brushing past a control.
  allowed(explain = true) {
    if (this.sync.canControl()) return true;
    const t = Date.now();
    if (explain && t - this.lockedToastAt > 3000) {
      this.lockedToastAt = t;
      this.toast('Only the host can control playback in this room.');
    }
    return false;
  }

  refresh() {
    this.el.classList.toggle('locked', !this.sync.canControl());
    this.paintNext();
    this.tick();
  }

  setQueueSize(n) {
    this.queueSize = n;
    this.paintNext();
  }

  paintNext() {
    this.nextBtn.hidden = !(this.queueSize > 0 && this.sync.canControl());
  }

  setTheater(on) {
    this.theater = on;
    this.theaterBtn.setAttribute('aria-pressed', String(on));
    this.theaterBtn.classList.toggle('on', on);
    setIcon(this.theaterBtn, 'theater', on ? 'Leave theater mode (T)' : 'Theater mode (T)');
  }

  setFullscreen(on) {
    this.full = on;
    this.fullBtn.setAttribute('aria-pressed', String(on));
    setIcon(this.fullBtn, on ? 'minimize' : 'maximize', on ? 'Leave full screen (F)' : 'Full screen (F)');
    this.show();
  }

  // ------------------------------------------------------------ actions

  flash(kind) {
    const f = this.flashEl;
    f.replaceChildren(icon(kind));
    f.hidden = false;
    f.classList.remove('go');
    void f.offsetWidth; // restart the animation
    f.classList.add('go');
  }

  async togglePlay() {
    const s = this.sync;
    const p = s.player;
    if (!p || !s.state || s.loading) return;
    const ps = p.playState();
    const localPlaying = ps === 'playing' || ps === 'buffering';

    // The room is playing but this browser is not (autoplay was blocked, or the video is still
    // starting): the press means "join in". That is purely local.
    if (s.state.playing && !localPlaying) {
      this.flash('play');
      s.tapToPlay();
      return;
    }
    if (!this.allowed()) return;

    const cur = p.getTime();
    const dur = p.getDuration();
    if (localPlaying) {
      this.flash('pause');
      await s.act('pause', { position: cur });
    } else {
      const restart = ps === 'ended' || (dur > 0 && cur >= dur - 0.5);
      this.flash('play');
      await s.act('play', { position: restart ? 0 : cur });
    }
    this.tick();
  }

  seekBy(delta) {
    const p = this.sync.player;
    if (!p || !this.sync.state || !this.allowed()) return;
    const dur = p.getDuration();
    const to = clamp(p.getTime() + delta, 0, dur > 1 ? dur - 0.5 : Infinity);
    this.sync.act('seek', { position: to });
    this.show();
  }

  next() {
    if (!this.allowed()) return;
    this.sync.command('next');
  }

  toggleMenu() {
    if (!this.menuOpen && !this.allowed()) return;
    if (this.menuOpen) this.closeMenu(); else this.openMenu();
  }

  openMenu() {
    const rate = this.sync.state ? this.sync.state.rate : 1;
    for (const mi of this.menu.children) mi.setAttribute('aria-checked', String(Number(mi.dataset.rate) === rate));
    this.menu.hidden = false;
    this.menuOpen = true;
  }

  closeMenu() {
    this.menu.hidden = true;
    this.menuOpen = false;
    this.schedule();
  }

  pickRate(r) {
    this.closeMenu();
    if (this.allowed()) this.sync.act('rate', { rate: r });
  }

  // ------------------------------------------------------------ volume (personal, never sent)

  setAudio(volume, muted) {
    this.audio = { volume: clamp(volume, 0, 1), muted: !!muted };
    this.sync.setAudio(this.audio.volume, this.audio.muted);
    saveAudio(this.audio);
    this.paintAudio();
  }

  toggleMute() {
    const a = this.audio;
    const muted = !(a.muted || a.volume === 0);
    this.setAudio(muted ? a.volume : a.volume || 0.6, muted);
  }

  paintAudio() {
    const { volume, muted } = this.audio;
    const silent = muted || volume === 0;
    setIcon(this.muteBtn, silent ? 'volumeOff' : volume < 0.5 ? 'volumeLow' : 'volume', silent ? 'Unmute (M)' : 'Mute (M)');
    const shown = silent ? 0 : volume;
    this.vol.value = String(Math.round(shown * 100));
    this.vol.style.setProperty('--fill', `${shown * 100}%`);
  }

  // ------------------------------------------------------------ keyboard

  onKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape' && this.menuOpen) { this.closeMenu(); return; }
    if (document.querySelector('.scrim') || !this.sync.state) return;
    const t = e.target;
    const tag = t && t.tagName;
    const typing = tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)
      || (tag === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit'].includes(t.type));
    if (typing) return;
    const onControl = tag === 'BUTTON' || tag === 'A' || tag === 'INPUT'; // they already use Space, Enter and the arrows
    const k = e.key;
    let used = true;

    if (k === 'f' || k === 'F') this.hooks.onFullscreen();
    else if (k === 't' || k === 'T') this.hooks.onTheater();
    else if (k === 'm' || k === 'M') this.toggleMute();
    else if (k === 'Enter' && !onControl) used = this.hooks.onChat(true);
    else if (k === 'k' || k === 'K' || (k === ' ' && !onControl)) this.togglePlay();
    else if (k === 'j' || k === 'J') this.seekBy(-10);
    else if (k === 'l' || k === 'L') this.seekBy(10);
    else if ((k === 'ArrowLeft' || k === 'ArrowRight') && !onControl) this.seekBy(k === 'ArrowLeft' ? -5 : 5);
    else if ((k === 'ArrowUp' || k === 'ArrowDown') && !onControl) this.setAudio(this.audio.volume + (k === 'ArrowUp' ? 0.1 : -0.1), false);
    else used = false;

    if (used) { e.preventDefault(); this.show(); }
  }

  // ------------------------------------------------------------ painting

  paintSeek(cur, dur, buf) {
    const frac = dur ? clamp(cur / dur, 0, 1) : 0;
    const bufFrac = dur ? clamp(buf / dur, frac, 1) : 0;
    this.seek.style.setProperty('--fill', `${frac * 100}%`);
    this.seek.style.setProperty('--buf', `${bufFrac * 100}%`);
    if (!this.dragging) this.seek.value = String(Math.round(frac * 1000));
    this.time.textContent = dur ? `${clock(cur)} / ${clock(dur)}` : clock(cur);
  }

  tick() {
    try {
      const s = this.sync;
      const p = s.player;
      const st = s.state;
      const have = !!(p && st && st.provider);
      this.el.classList.toggle('is-empty', !have);
      this.el.classList.toggle('locked', !s.canControl());
      if (!have) return;

      const ps = p.playState();
      const playing = ps === 'playing' || ps === 'buffering';
      if (playing !== this.lastPlaying) {
        this.lastPlaying = playing;
        setIcon(this.playBtn, playing ? 'pause' : 'play', playing ? 'Pause (K)' : 'Play (K)');
      }

      const dur = p.getDuration();
      const cur = this.dragging ? this.dragPos : clamp(p.getTime(), 0, dur || Infinity);
      this.el.classList.toggle('is-live', !dur);
      this.paintSeek(cur, dur, p.getBuffered());

      const rate = st.rate || 1;
      this.rateBtn.textContent = `${rate}x`;
    } catch (_) { /* the player may be mid-swap; the next tick will paint */ }
  }
}
