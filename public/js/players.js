// Player adapters. Each one hides a different video technology behind the same small surface:
//
//   load(media, startAt, autoplay)   media = { provider, mediaId, url }
//   play() pause() seek(t)
//   getTime()      current position in seconds (synchronous)
//   playState()    'playing' | 'paused' | 'buffering' | 'ended' | 'unstarted'
//   getRate() setRate(r)
//   getDuration()  length in seconds, 0 when unknown (live streams)
//   getBuffered()  how far ahead the video has loaded, as a position in seconds
//   setAudio(volume 0..1, muted)   this viewer's own volume, never shared with the room
//   destroy()
//
// Every adapter hides the provider's own controls: the room draws one control bar (controls.js)
// that looks and behaves the same for YouTube, Vimeo and plain files.
//
// hooks.poke()    tell the sync engine "something changed, look now"
// hooks.error(m)  tell the UI the video cannot play
// hooks.audio()   this viewer's current { volume, muted }

import { loadScript } from './realtime.js';

const HLS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
const VIMEO_URL = 'https://player.vimeo.com/api/player.js';

// ---------------------------------------------------------------- YouTube

let ytReady = null;
function youtubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (!ytReady) {
    ytReady = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
      loadScript('https://www.youtube.com/iframe_api').catch((e) => { ytReady = null; reject(e); });
    });
  }
  return ytReady;
}

const YT_ERRORS = {
  2: 'YouTube says this link is invalid.',
  5: 'YouTube could not play this video in the browser.',
  100: 'This YouTube video was removed or is private.',
  101: 'The owner of this video does not allow it to be played outside YouTube.',
  150: 'The owner of this video does not allow it to be played outside YouTube.',
};

class YouTubePlayer {
  constructor(container, hooks) {
    this.provider = 'youtube';
    this.reusable = true;
    this.container = container;
    this.hooks = hooks;
    this.p = null;
    this.ready = false;
    this.raw = -1;
    this.audio = () => { const a = hooks.audio ? hooks.audio() : { volume: 1, muted: false }; return [a.volume, a.muted]; };
  }

  async load(media, startAt, autoplay) {
    await youtubeApi();
    if (!this.p) {
      const mount = document.createElement('div');
      this.container.replaceChildren(mount);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('YouTube took too long to start.')), 20000);
        this.p = new window.YT.Player(mount, {
          width: '100%',
          height: '100%',
          videoId: media.mediaId,
          playerVars: {
            autoplay: autoplay ? 1 : 0, start: Math.floor(startAt), playsinline: 1, origin: location.origin,
            controls: 0, disablekb: 1, fs: 0, rel: 0, iv_load_policy: 3, modestbranding: 1, cc_load_policy: 0,
          },
          events: {
            onReady: () => { clearTimeout(timer); this.ready = true; this.setAudio(...this.audio()); resolve(); },
            onStateChange: (e) => { this.raw = e.data; this.hooks.poke(); },
            onError: (e) => this.hooks.error(YT_ERRORS[e.data] || 'YouTube could not play this video.'),
            onPlaybackRateChange: () => this.hooks.poke(),
          },
        });
      });
    } else if (autoplay) {
      this.p.loadVideoById({ videoId: media.mediaId, startSeconds: startAt });
    } else {
      this.p.cueVideoById({ videoId: media.mediaId, startSeconds: startAt });
    }
  }

  play() { if (this.ready) this.p.playVideo(); }
  pause() { if (this.ready) this.p.pauseVideo(); }
  seek(t) { if (this.ready) this.p.seekTo(Math.max(0, t), true); }
  getTime() { return this.ready ? Number(this.p.getCurrentTime()) || 0 : 0; }
  getRate() { return this.ready ? this.p.getPlaybackRate() || 1 : 1; }
  setRate(r) { if (this.ready) this.p.setPlaybackRate(r); }
  getDuration() { return this.ready ? Number(this.p.getDuration()) || 0 : 0; }
  getBuffered() { return this.ready ? (Number(this.p.getVideoLoadedFraction()) || 0) * this.getDuration() : 0; }
  setAudio(volume, muted) {
    if (!this.ready) return;
    this.p.setVolume(Math.round(volume * 100));
    if (muted) this.p.mute(); else this.p.unMute();
  }
  playState() {
    if (!this.ready) return 'unstarted';
    switch (this.raw) {
      case 1: return 'playing';
      case 3: return 'buffering';
      case 0: return 'ended';
      case 2: case 5: return 'paused';
      default: return 'unstarted';
    }
  }
  destroy() { try { this.p && this.p.destroy(); } catch (_) { /* ignore */ } this.container.replaceChildren(); }
}

// ---------------------------------------------------------------- Vimeo

class VimeoPlayer {
  constructor(container, hooks) {
    this.provider = 'vimeo';
    this.reusable = false; // a fresh player per video is the most reliable path with Vimeo
    this.container = container;
    this.hooks = hooks;
    this.p = null;
    this.t = 0;
    this.tAt = performance.now();
    this.st = 'paused';
    this.buffering = false;
    this.rate = 1;
    this.dur = 0;
    this.buf = 0;
  }

  async load(media, startAt, autoplay) {
    await loadScript(VIMEO_URL);
    const mount = document.createElement('div');
    Object.assign(mount.style, { position: 'absolute', inset: '0' });
    this.container.replaceChildren(mount);
    const p = new window.Vimeo.Player(mount, { url: media.url, autopause: false, playsinline: true, responsive: false, controls: false });
    this.p = p;
    const set = (fn) => (d) => { fn(d || {}); this.hooks.poke(); };
    const stamp = (s) => { if (typeof s === 'number') { this.t = s; this.tAt = performance.now(); } };

    p.on('play', set((d) => { stamp(d.seconds); this.st = 'playing'; }));
    p.on('playing', set((d) => { stamp(d.seconds); this.st = 'playing'; this.buffering = false; }));
    p.on('pause', set((d) => { stamp(d.seconds); this.st = 'paused'; }));
    p.on('ended', set((d) => { stamp(d.seconds); this.st = 'ended'; }));
    p.on('bufferstart', set(() => { this.buffering = true; }));
    p.on('bufferend', set(() => { this.buffering = false; }));
    p.on('timeupdate', (d) => stamp(d.seconds));
    p.on('seeked', set((d) => stamp(d.seconds)));
    p.on('playbackratechange', set((d) => { this.rate = d.playbackRate || 1; }));
    p.on('progress', (d) => { if (d && typeof d.seconds === 'number') this.buf = d.seconds; });
    p.on('error', (e) => this.hooks.error((e && e.message) || 'Vimeo could not play this video.'));

    await p.ready();
    p.getDuration().then((d) => { this.dur = Number(d) || 0; }).catch(() => {});
    this.setAudio(...this.audioNow());
    const frame = mount.querySelector('iframe');
    if (frame) Object.assign(frame.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', border: '0' });
    this.t = startAt;
    this.tAt = performance.now();
    if (startAt > 0) await p.setCurrentTime(startAt).catch(() => {});
    if (autoplay) p.play().catch(() => {});
  }

  play() { if (this.p) this.p.play().catch(() => {}); }
  pause() { if (this.p) this.p.pause().catch(() => {}); }
  seek(t) {
    if (!this.p) return;
    this.t = t;
    this.tAt = performance.now();
    this.p.setCurrentTime(Math.max(0, t)).catch(() => {});
  }
  getTime() {
    return this.st === 'playing' && !this.buffering ? this.t + ((performance.now() - this.tAt) / 1000) * this.rate : this.t;
  }
  getRate() { return this.rate; }
  setRate(r) { if (this.p) this.p.setPlaybackRate(r).catch(() => {}); }
  getDuration() { return this.dur; }
  getBuffered() { return this.buf; }
  audioNow() { const a = this.hooks.audio ? this.hooks.audio() : { volume: 1, muted: false }; return [a.volume, a.muted]; }
  setAudio(volume, muted) {
    if (!this.p) return;
    this.p.setVolume(muted ? 0 : volume).catch(() => {});
  }
  playState() {
    if (!this.p) return 'unstarted';
    if (this.st === 'ended') return 'ended';
    if (this.buffering && this.st === 'playing') return 'buffering';
    return this.st;
  }
  destroy() { try { this.p && this.p.destroy(); } catch (_) { /* ignore */ } this.container.replaceChildren(); }
}

// ---------------------------------------------------------------- Video files, audio files, HLS streams

class FilePlayer {
  constructor(container, hooks) {
    this.provider = 'file';
    this.reusable = true;
    this.container = container;
    this.hooks = hooks;
    this.v = null;
    this.hls = null;
  }

  ensureElement() {
    if (this.v) return;
    const v = document.createElement('video');
    v.controls = false;
    v.playsInline = true;
    v.preload = 'auto';
    Object.assign(v.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', background: '#000' });
    ['play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'ended', 'ratechange', 'stalled', 'canplay']
      .forEach((ev) => v.addEventListener(ev, () => this.hooks.poke()));
    v.addEventListener('error', () => {
      const code = v.error && v.error.code;
      this.hooks.error(code === 4
        ? 'The browser cannot play this link. Use a direct .mp4, .webm or .m3u8 link that allows playback from other sites.'
        : 'The video failed to load.');
    });
    this.container.replaceChildren(v);
    this.v = v;
    const a = this.hooks.audio ? this.hooks.audio() : { volume: 1, muted: false };
    this.setAudio(a.volume, a.muted);
  }

  async load(media, startAt, autoplay) {
    this.ensureElement();
    const v = this.v;
    if (this.hls) { this.hls.destroy(); this.hls = null; }

    const isHls = /\.m3u8(\?|#|$)/i.test(media.url);
    const nativeHls = v.canPlayType('application/vnd.apple.mpegurl');
    if (isHls && !nativeHls) {
      await loadScript(HLS_URL);
      if (!window.Hls || !window.Hls.isSupported()) throw new Error('This browser cannot play HLS streams.');
      const hls = new window.Hls({ startPosition: startAt > 0 ? startAt : -1 });
      this.hls = hls;
      hls.on(window.Hls.Events.ERROR, (_e, data) => {
        if (data && data.fatal) this.hooks.error('The stream failed to load. It must allow playback from other sites (CORS).');
      });
      hls.loadSource(media.url);
      hls.attachMedia(v);
    } else {
      v.src = media.url;
      if (startAt > 0) v.addEventListener('loadedmetadata', () => { try { v.currentTime = startAt; } catch (_) { /* ignore */ } }, { once: true });
    }
    if (autoplay) v.play().catch(() => {}); // blocked autoplay is handled by the "click to join" overlay
  }

  play() { if (this.v) this.v.play().catch(() => {}); }
  pause() { if (this.v) this.v.pause(); }
  seek(t) { if (this.v) { try { this.v.currentTime = Math.max(0, t); } catch (_) { /* not seekable yet */ } } }
  getTime() { return this.v ? this.v.currentTime || 0 : 0; }
  getRate() { return this.v ? this.v.playbackRate : 1; }
  setRate(r) { if (this.v) this.v.playbackRate = r; }
  getDuration() { const d = this.v ? this.v.duration : 0; return Number.isFinite(d) ? d : 0; }
  getBuffered() {
    const v = this.v;
    if (!v) return 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.currentTime >= v.buffered.start(i) - 0.1 && v.currentTime <= v.buffered.end(i) + 0.1) return v.buffered.end(i);
    }
    return 0;
  }
  setAudio(volume, muted) { if (this.v) { this.v.volume = Math.min(1, Math.max(0, volume)); this.v.muted = !!muted; } }
  playState() {
    const v = this.v;
    if (!v || !v.currentSrc && !this.hls) return 'unstarted';
    if (v.ended) return 'ended';
    if (v.paused) return 'paused';
    if (v.readyState < 3 || v.seeking) return 'buffering';
    return 'playing';
  }
  destroy() {
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    if (this.v) { this.v.pause(); this.v.removeAttribute('src'); this.v.load(); }
    this.container.replaceChildren();
  }
}

export function createPlayer(provider, container, hooks) {
  if (provider === 'youtube') return new YouTubePlayer(container, hooks);
  if (provider === 'vimeo') return new VimeoPlayer(container, hooks);
  return new FilePlayer(container, hooks);
}
