'use strict';

/*
  End-to-end test: two real browsers in one room.

    1. start MongoDB and the app (npm start)
    2. npm run test:e2e            (BASE=http://localhost:3000 by default)

  Needs: playwright-core (already a devDependency), a Chromium binary, and ffmpeg (to make a tiny test video).
  Point CHROME_PATH at a Chromium/Chrome binary if Playwright's own is not installed.
  It checks synced play/pause/seek, chat, presence, the queue, permissions, kicking, voice, camera and screen share.
*/

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright-core');

const BASE = process.env.BASE || 'http://localhost:3000';
const FIXTURE_PORT = 4010;
let failed = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 9000, every = 150, label = '' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(every);
  }
  throw new Error(`timed out${label ? ` waiting for ${label}` : ''}${last instanceof Error ? `: ${last.message}` : ''}`);
}
async function step(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

// A tiny static server with Range support so <video> can seek.
function serveFile(file, port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const size = fs.statSync(file).size;
      const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
      const headers = { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
      if (range) {
        const start = range[1] ? parseInt(range[1], 10) : 0;
        const end = range[2] ? Math.min(parseInt(range[2], 10), size - 1) : size - 1;
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
        fs.createReadStream(file, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { ...headers, 'Content-Length': size });
        fs.createReadStream(file).pipe(res);
      }
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function makeFixture() {
  const file = path.join(os.tmpdir(), 'couchtime-test.webm');
  if (!fs.existsSync(file)) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=120',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=120',
      '-c:v', 'libvpx', '-b:v', '150k', '-g', '15', '-c:a', 'libvorbis', '-shortest', file]);
  }
  return file;
}

const fakeScreen = () => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 360;
    const x = c.getContext('2d');
    let n = 0;
    setInterval(() => { x.fillStyle = `hsl(${(n++ * 7) % 360},70%,45%)`; x.fillRect(0, 0, 640, 360); x.fillStyle = '#fff'; x.font = '48px sans-serif'; x.fillText(`SCREEN ${n}`, 40, 190); }, 50);
    return c.captureStream(20);
  };
};

// A stand-in for https://www.youtube.com/iframe_api that follows the documented player API closely
// enough to exercise our adapter. It keeps its own clock, so play, pause, seek and speed behave.
const FAKE_YT = `
(() => {
  const players = [];
  class Player {
    constructor(mount, opts) {
      this.opts = opts; this.t = opts.playerVars.start || 0; this.at = performance.now(); this.rate = 1; this.vol = 100; this.isMute = false;
      this.st = opts.playerVars.autoplay ? 1 : 5; this.video = opts.videoId; this.destroyed = false;
      this.el = document.createElement('div'); this.el.setAttribute('data-fake-yt', opts.videoId);
      this.el.style.cssText = 'position:absolute;inset:0;background:#123;color:#fff;display:grid;place-items:center;font:24px sans-serif';
      this.el.textContent = 'fake YouTube ' + opts.videoId;
      mount.replaceWith(this.el);
      players.push(this); window.__yt = this;
      setTimeout(() => { opts.events.onReady({ target: this }); opts.events.onStateChange({ data: this.st }); }, 40);
    }
    now() { return this.st === 1 ? this.t + ((performance.now() - this.at) / 1000) * this.rate : this.t; }
    set(st) { this.t = this.now(); this.at = performance.now(); this.st = st; this.opts.events.onStateChange({ data: st }); }
    playVideo() { if (this.st !== 1) this.set(1); }
    pauseVideo() { if (this.st === 1) this.set(2); }
    seekTo(s) { this.t = s; this.at = performance.now(); this.opts.events.onStateChange({ data: this.st }); }
    getCurrentTime() { return this.now(); }
    getDuration() { return 200; }
    getVideoLoadedFraction() { return 0.5; }
    getPlaybackRate() { return this.rate; }
    setPlaybackRate(r) { this.t = this.now(); this.at = performance.now(); this.rate = r; this.opts.events.onPlaybackRateChange({ data: r }); }
    setVolume(v) { this.vol = v; }
    mute() { this.isMute = true; }
    unMute() { this.isMute = false; }
    loadVideoById(o) { this.video = o.videoId; this.t = o.startSeconds || 0; this.at = performance.now(); this.set(1); }
    cueVideoById(o) { this.video = o.videoId; this.t = o.startSeconds || 0; this.at = performance.now(); this.set(5); }
    destroy() { this.destroyed = true; this.el.remove(); }
  }
  window.YT = { Player };
  setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 10);
})();`;

const vid = (page) => page.evaluate(() => {
  const v = document.querySelector('#host video');
  return v ? { t: v.currentTime, paused: v.paused, src: v.currentSrc, w: v.videoWidth } : null;
});

// The bar fades out while a video plays and nobody is moving the mouse, so bring it back before using it.
const bar = async (page, selector) => { await page.hover('#stage'); await page.click(`#ctl ${selector}`); };
const seekBar = (page, fraction) => page.evaluate((f) => {
  const el = document.querySelector('#ctl .ctl-seek');
  el.value = String(Math.round(f * 1000));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, fraction);
const fakeYt = (page) => page.evaluate(() => { const y = window.__yt; return y && !y.destroyed ? { st: y.st, t: y.now(), rate: y.rate, vol: y.vol, muted: y.isMute, video: y.video, controls: y.opts.playerVars.controls } : null; });

async function joinRoom(page, url, name) {
  await page.goto(url);
  await page.waitForSelector('#g-nick, #gate .modal button[type=submit]');
  const nick = await page.$('#g-nick');
  if (nick) { await nick.fill(name); }
  await page.click('#gate button[type=submit]');
  await page.waitForSelector('#room-main:not([hidden])');
}

(async () => {
  const file = makeFixture();
  const fixtures = await serveFile(file, FIXTURE_PORT);
  const VIDEO = `http://127.0.0.1:${FIXTURE_PORT}/test.webm`;

  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const mk = async () => {
    const ctx = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1368, height: 768 } });
    await ctx.addInitScript(fakeScreen);
    await ctx.route('https://www.youtube.com/iframe_api', (route) => route.fulfill({ contentType: 'text/javascript', body: FAKE_YT }));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`        [pageerror] ${e.message}`));
    return { ctx, page };
  };
  const A = await mk();
  const B = await mk();
  let roomUrl = '';
  let roomId = '';

  console.log(`\nCouchtime e2e against ${BASE}\n`);

  await step('Alice creates a room from the landing page', async () => {
    await A.page.goto(BASE);
    await A.page.fill('#nick', 'Alice');
    await A.page.click('#create-btn');
    await A.page.waitForURL(/\/r\/[a-z0-9]+$/);
    roomUrl = A.page.url();
    roomId = roomUrl.split('/').pop();
    await A.page.waitForSelector('#gate .modal');
  });

  await step('Alice and Bob both enter through the join gate', async () => {
    await A.page.click('#gate button[type=submit]');
    await A.page.waitForSelector('#room-main:not([hidden])');
    await joinRoom(B.page, roomUrl, 'Bob');
  });

  await step('presence: both people see each other', async () => {
    await A.page.click('#tab-people');
    await waitFor(async () => (await A.page.$$eval('#people-list .person', (n) => n.length)) === 2);
    await B.page.click('#tab-people');
    await waitFor(async () => (await B.page.$$eval('#people-list .person', (n) => n.length)) === 2);
    const names = await A.page.$$eval('#people-list .nm > span:first-child', (n) => n.map((x) => x.textContent).sort());
    if (names.join() !== 'Alice,Bob') throw new Error(`names: ${names}`);
  });

  await step('Alice loads a video and it starts for Bob too', async () => {
    await A.page.fill('#link-input', VIDEO);
    await A.page.click('#play-now');
    await waitFor(async () => { const v = await vid(B.page); return v && !v.paused && v.t > 0.5; }, { timeout: 15000 });
    const [a, b] = [await vid(A.page), await vid(B.page)];
    if (Math.abs(a.t - b.t) > 1.5) throw new Error(`positions differ: ${a.t} vs ${b.t}`);
  });

  await step('pause from one browser pauses the other at the same frame', async () => {
    await A.page.evaluate(() => document.querySelector('#host video').pause());
    await waitFor(async () => (await vid(B.page)).paused, { timeout: 6000 });
    await sleep(1100);
    const [a, b] = [await vid(A.page), await vid(B.page)];
    if (Math.abs(a.t - b.t) > 0.6) throw new Error(`paused at different places: ${a.t} vs ${b.t}`);
  });

  await step('seeking while paused moves both players', async () => {
    await B.page.evaluate(() => { document.querySelector('#host video').currentTime = 60; });
    await waitFor(async () => Math.abs((await vid(A.page)).t - 60) < 1, { timeout: 6000 });
  });

  await step('play from the other browser resumes everyone', async () => {
    await B.page.evaluate(() => document.querySelector('#host video').play());
    await waitFor(async () => !(await vid(A.page)).paused, { timeout: 6000 });
    await sleep(1200);
    const [a, b] = [await vid(A.page), await vid(B.page)];
    if (Math.abs(a.t - b.t) > 1.5) throw new Error(`drifted: ${a.t} vs ${b.t}`);
  });

  await step('seeking while playing keeps both in step', async () => {
    await A.page.evaluate(() => { document.querySelector('#host video').currentTime = 20; });
    await waitFor(async () => { const b = await vid(B.page); return Math.abs(b.t - 21) < 2.5 && !b.paused; }, { timeout: 7000 });
  });

  await step('someone who joins late lands on the right second', async () => {
    const C = await mk();
    await joinRoom(C.page, roomUrl, 'Cleo');
    await waitFor(async () => { const c = await vid(C.page); const a = await vid(A.page); return c && !c.paused && Math.abs(c.t - a.t) < 2.5; }, { timeout: 15000 });
    await C.ctx.close();
  });

  await step('chat messages reach the other browser', async () => {
    await A.page.click('#tab-chat');
    await B.page.click('#tab-chat');
    await A.page.fill('#chat-input', 'hello from Alice <b>not bold</b>');
    await A.page.press('#chat-input', 'Enter');
    await waitFor(async () => (await B.page.$$eval('#chat-log .msg .txt', (n) => n.map((x) => x.textContent))).some((t) => t === 'hello from Alice <b>not bold</b>'));
    const bold = await B.page.$$('#chat-log .msg .txt b');
    if (bold.length) throw new Error('chat HTML was not escaped');
  });

  await step('queue: add, show on both, auto-advance when the video ends', async () => {
    await B.page.fill('#link-input', `${VIDEO}?second`);
    await B.page.click('#queue-add');
    await A.page.click('#tab-queue');
    await waitFor(async () => (await A.page.$$eval('#queue-list .q-item', (n) => n.length)) === 1);
    await A.page.evaluate(() => { const v = document.querySelector('#host video'); v.currentTime = v.duration - 1.5; });
    await waitFor(async () => { const v = await vid(B.page); return v && v.src.endsWith('?second') && !v.paused && v.t > 0.3; }, { timeout: 15000 });
    await waitFor(async () => (await A.page.$$eval('#queue-list .q-item', (n) => n.length)) === 0);
  });

  await step('control bar: the pause button pauses everyone, play resumes them', async () => {
    await bar(A.page, '.ctl-play');
    await waitFor(async () => (await vid(B.page)).paused && (await vid(A.page)).paused, { timeout: 6000, label: 'both paused' });
    await sleep(900);
    const [a, b] = [await vid(A.page), await vid(B.page)];
    if (Math.abs(a.t - b.t) > 0.6) throw new Error(`paused at different places: ${a.t} vs ${b.t}`);
    await bar(B.page, '.ctl-play');
    await waitFor(async () => !(await vid(A.page)).paused && !(await vid(B.page)).paused, { timeout: 6000, label: 'both playing again' });
  });

  await step('control bar: the seek bar moves everyone to the same second', async () => {
    await A.page.hover('#stage');
    await seekBar(A.page, 0.5);
    await waitFor(async () => { const [a, b] = [await vid(A.page), await vid(B.page)]; return Math.abs(a.t - 60) < 4 && Math.abs(b.t - 60) < 4; }, { timeout: 8000, label: 'both near 1:00' });
    const label = await A.page.textContent('#ctl .ctl-time');
    if (!/^1:0\d \/ 2:00$/.test(label)) throw new Error(`time label reads "${label}"`);
  });

  await step('control bar: speed is shared, volume stays personal', async () => {
    await bar(A.page, '.ctl-rate');
    await A.page.click('#ctl .ctl-mi[data-rate="1.5"]');
    await waitFor(async () => (await B.page.evaluate(() => document.querySelector('#host video').playbackRate)) === 1.5, { timeout: 6000, label: 'Bob at 1.5x' });
    await bar(A.page, '.ctl-rate');
    await A.page.click('#ctl .ctl-mi[data-rate="1"]');
    await waitFor(async () => (await B.page.evaluate(() => document.querySelector('#host video').playbackRate)) === 1, { timeout: 6000, label: 'Bob back at 1x' });
    await bar(A.page, '.ctl-mute');
    const muted = (page) => page.evaluate(() => document.querySelector('#host video').muted);
    if (!(await muted(A.page))) throw new Error('Alice pressed mute but her video is not muted');
    if (await muted(B.page)) throw new Error('Alice muting herself muted Bob too');
    await bar(A.page, '.ctl-mute');
    if (await muted(A.page)) throw new Error('unmute did not work');
  });

  await step('keyboard: K pauses and resumes the room, the arrows seek', async () => {
    await A.page.evaluate(() => document.activeElement && document.activeElement.blur());
    await A.page.keyboard.press('k');
    await waitFor(async () => (await vid(B.page)).paused, { timeout: 6000, label: 'Bob paused by Alice\'s K key' });
    const before = (await vid(A.page)).t;
    await A.page.keyboard.press('l'); // +10 seconds
    await waitFor(async () => { const b = await vid(B.page); return b.t > before + 8; }, { timeout: 6000, label: 'Bob jumped ten seconds' });
    await A.page.keyboard.press('k');
    await waitFor(async () => !(await vid(B.page)).paused, { timeout: 6000, label: 'Bob playing again' });
  });

  // The YouTube adapter against a stand-in for the real IFrame API: the same control bar has to drive it.
  await step('YouTube: loads with its own controls off and stays in sync through the bar', async () => {
    await A.page.fill('#link-input', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await A.page.click('#play-now');
    await waitFor(async () => { const y = await fakeYt(B.page); return y && y.st === 1 && y.video === 'dQw4w9WgXcQ'; }, { timeout: 12000, label: 'Bob playing the YouTube video' });
    const y = await fakeYt(A.page);
    if (y.controls !== 0) throw new Error('YouTube was started with its own controls on');
    await bar(A.page, '.ctl-play');
    await waitFor(async () => (await fakeYt(B.page)).st === 2, { timeout: 6000, label: 'Bob paused' });
    await seekBar(A.page, 0.25);
    await waitFor(async () => Math.abs((await fakeYt(B.page)).t - 50) < 3, { timeout: 6000, label: 'Bob at 0:50' });
    await bar(B.page, '.ctl-play');
    await waitFor(async () => (await fakeYt(A.page)).st === 1, { timeout: 6000, label: 'Alice playing' });
    await bar(A.page, '.ctl-rate');
    await A.page.click('#ctl .ctl-mi[data-rate="2"]');
    await waitFor(async () => (await fakeYt(B.page)).rate === 2, { timeout: 6000, label: 'Bob at 2x' });
    await bar(A.page, '.ctl-mute');
    await waitFor(async () => (await fakeYt(A.page)).muted, { timeout: 3000, label: 'Alice muted' });
    if ((await fakeYt(B.page)).muted) throw new Error('muting one person muted the other');
    await bar(A.page, '.ctl-mute');
    const t = await A.page.evaluate(() => document.querySelector('#ctl .ctl-time').textContent);
    if (!/ \/ 3:20$/.test(t)) throw new Error(`YouTube duration missing from "${t}"`);
  });

  await step('back to a plain video file after YouTube', async () => {
    await A.page.fill('#link-input', VIDEO);
    await A.page.click('#play-now');
    await waitFor(async () => { const a = await vid(A.page); const b = await vid(B.page); return a && b && !a.paused && !b.paused && a.t > 0.8 && b.t > 0.8; }, { timeout: 15000, label: 'both really playing' });
  });

  await step('host-only mode blocks other people from controlling playback', async () => {
    const res = await A.page.evaluate(async (id) => (await fetch(`/api/rooms/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ control: 'host' }) })).status, roomId);
    if (res !== 200) throw new Error(`PATCH status ${res}`);
    await waitFor(async () => B.page.$eval('#play-now', (b) => b.disabled), { label: 'Play now to be disabled for Bob' });
    const status = await B.page.evaluate(async (id) => (await fetch(`/api/rooms/${id}/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause', position: 3 }) })).status, roomId);
    if (status !== 403) throw new Error(`expected 403, got ${status}`);
    // Bob pressing pause locally is undone: the room keeps playing.
    await B.page.evaluate(() => document.querySelector('#host video').pause());
    await waitFor(async () => !(await vid(B.page)).paused, { timeout: 8000, label: 'Bob\'s local pause to be undone' }).catch(async (e) => {
      const d = await B.page.evaluate(() => { const s = window.couchtime.sync; const v = document.querySelector('#host video'); return JSON.stringify({ video: v && { paused: v.paused, rs: v.readyState, err: v.error && v.error.code, t: v.currentTime, ended: v.ended, muted: v.muted, vol: v.volume }, tapHidden: document.querySelector('#tap').hidden, state: s.state, ps: s.player.playState(), awaiting: s.awaiting, pausedSince: s.pausedSince, supp: Math.round(s.suppressUntil - performance.now()), hold: Math.round(s.holdUntil - performance.now()), loading: s.loading, can: s.canControl() }); });
      throw new Error(`${e.message} ${d}`);
    });
    // Bob's control bar is dimmed, and pressing pause explains why instead of doing anything.
    if (!(await B.page.$eval('#ctl', (c) => c.classList.contains('locked')))) throw new Error('the bar is not marked as locked for Bob');
    await bar(B.page, '.ctl-play');
    await waitFor(async () => B.page.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => /Only the host/.test(t.textContent))), { timeout: 4000, label: 'the explanation toast' });
    await sleep(600);
    if ((await vid(A.page)).paused) throw new Error('Bob paused the room even though only the host may');
    await A.page.evaluate(async (id) => fetch(`/api/rooms/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ control: 'everyone' }) }), roomId);
    await waitFor(async () => !(await B.page.$eval('#play-now', (b) => b.disabled)), { label: 'Play now to be enabled again' });
  });

  await step('voice: both join the call and hear each other', async () => {
    await A.page.click('[aria-label="Join voice chat"]');
    await B.page.click('[aria-label="Join voice chat"]');
    await waitFor(async () => B.page.$('[aria-label="Mute microphone"]'));
    await waitFor(async () => {
      const ok = await A.page.evaluate(async () => {
        const a = document.querySelector('#audio-sink audio');
        if (!a || !a.srcObject) return false;
        const t = a.srcObject.getAudioTracks()[0];
        return !!t && !t.muted && t.readyState === 'live';
      });
      return ok;
    }, { timeout: 20000 });
    await waitFor(async () => B.page.evaluate(() => { const a = document.querySelector('#audio-sink audio'); const t = a && a.srcObject && a.srcObject.getAudioTracks()[0]; return !!t && !t.muted; }), { timeout: 20000 });
  });

  await step('mute shows up for the other person', async () => {
    await A.page.click('[aria-label="Mute microphone"]');
    await B.page.click('#tab-people');
    await waitFor(async () => (await B.page.$$eval('#people-list .person', (rows) => rows.some((r) => r.textContent.includes('Alice') && r.querySelector('[title="Muted"]')))));
  });

  await step('camera: Bob turns it on and Alice sees live video', async () => {
    await B.page.click('[aria-label="Turn camera on"]');
    await waitFor(async () => A.page.evaluate(() => [...document.querySelectorAll('#strip video')].some((v) => !v.hidden && v.videoWidth > 0)), { timeout: 20000 });
  });

  await step('layout: call tiles keep a readable size on a 1368x768 screen and other window shapes', async () => {
    const sizes = [[1368, 768], [1920, 1080], [1280, 720], [1024, 600], [390, 844]];
    for (const [w, h] of sizes) {
      await A.page.setViewportSize({ width: w, height: h });
      await sleep(300);
      const m = await A.page.evaluate(() => {
        const t = document.querySelector('#strip .tile').getBoundingClientRect();
        const s = document.querySelector('#stage').getBoundingClientRect();
        return { tw: t.width, th: t.height, sw: s.width, sh: s.height, vw: innerWidth };
      });
      if (m.tw < 100 || m.th < 62) throw new Error(`${w}x${h}: tile is ${Math.round(m.tw)}x${Math.round(m.th)}`);
      if (m.sh < 200) throw new Error(`${w}x${h}: the video is only ${Math.round(m.sh)}px tall`);
      if (m.sw > m.vw + 1) throw new Error(`${w}x${h}: the video is wider than the window`);
    }
    await A.page.setViewportSize({ width: 1368, height: 768 });
    await sleep(300);
  });

  await step('full screen keeps the cameras, chat and controls on top of the video', async () => {
    await B.page.click('#tab-chat');
    await A.page.hover('#stage');
    await A.page.keyboard.press('f');
    await waitFor(async () => A.page.evaluate(() => document.body.classList.contains('is-full')), { timeout: 4000, label: 'full screen' });
    const inside = await A.page.evaluate(() => ({ strip: document.querySelector('#strip').parentElement.id, fs: document.fullscreenElement ? document.fullscreenElement.id : 'fake' }));
    if (inside.strip !== 'stage') throw new Error(`cameras are not over the video (parent: ${inside.strip})`);
    await B.page.fill('#chat-input', 'can you see this over the video?');
    await B.page.press('#chat-input', 'Enter');
    await waitFor(async () => A.page.evaluate(() => [...document.querySelectorAll('#cf-log .cf-line')].some((l) => l.textContent.includes('can you see this over the video?'))), { timeout: 6000, label: 'the chat line over the video' });
    // Enter opens a box over the video, and what is typed there reaches the other person.
    await A.page.keyboard.press('Enter');
    await A.page.keyboard.type('yes, loud and clear');
    await A.page.keyboard.press('Enter');
    await waitFor(async () => (await B.page.$$eval('#chat-log .msg .txt', (n) => n.map((x) => x.textContent))).includes('yes, loud and clear'), { timeout: 6000, label: 'the reply from full screen' });
    await waitFor(async () => A.page.evaluate(() => document.querySelector('#cf-form').hidden), { timeout: 4000, label: 'the chat box to close after sending' });
    await A.page.keyboard.press('f');
    await waitFor(async () => A.page.evaluate(() => !document.body.classList.contains('is-full')), { timeout: 4000, label: 'leaving full screen' });
    const back = await A.page.evaluate(() => document.querySelector('#strip').parentElement.id);
    if (back !== 'stage-col') throw new Error(`cameras did not return under the video (parent: ${back})`);
  });

  await step('theater mode hides the side panel and gives the video more room', async () => {
    const before = await A.page.evaluate(() => document.querySelector('#stage').getBoundingClientRect().height);
    await A.page.keyboard.press('t');
    await waitFor(async () => A.page.evaluate(() => document.querySelector('#room-main').classList.contains('theater')), { timeout: 3000 });
    await sleep(300);
    const after = await A.page.evaluate(() => ({ side: getComputedStyle(document.querySelector('.side')).display, h: document.querySelector('#stage').getBoundingClientRect().height, strip: document.querySelector('#strip').parentElement.id }));
    if (after.side !== 'none') throw new Error('the side panel is still showing');
    if (after.h < before + 60) throw new Error(`the video did not grow (${Math.round(before)} -> ${Math.round(after.h)})`);
    if (after.strip !== 'stage') throw new Error('cameras are not over the video in theater mode');
    await A.page.keyboard.press('t');
    await waitFor(async () => A.page.evaluate(() => !document.querySelector('#room-main').classList.contains('theater')), { timeout: 3000 });
  });

  await step('screen share: Alice shares and Bob gets it on the stage', async () => {
    await A.page.click('[aria-label="Share your screen"]');
    await waitFor(async () => B.page.evaluate(() => { const v = document.querySelector('#screen-video'); return !document.querySelector('#screen-view').hidden && v.videoWidth > 0; }), { timeout: 25000 });
    await A.page.click('[aria-label="Stop sharing your screen"]');
    await waitFor(async () => B.page.$eval('#screen-view', (n) => n.hidden), { timeout: 8000 });
  });

  await step('leaving the call closes the connection', async () => {
    await B.page.click('[aria-label="Leave the voice call"]');
    await waitFor(async () => A.page.evaluate(() => document.querySelectorAll('#audio-sink audio').length === 0), { timeout: 10000 });
  });

  await step('the host can remove someone, who then cannot come back', async () => {
    const uid = await B.page.evaluate(async () => (await (await fetch('/api/auth/me')).json()).me.id);
    const status = await A.page.evaluate(async ({ id, uid }) => (await fetch(`/api/rooms/${id}/kick`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid }) })).status, { id: roomId, uid });
    if (status !== 200) throw new Error(`kick status ${status}`);
    await waitFor(async () => (await B.page.textContent('#gate')).includes('removed'), { timeout: 8000 });
    await B.page.reload();
    await waitFor(async () => (await B.page.textContent('#gate')).includes('removed'));
  });

  await step('accounts: register, custom address, permanent room, password', async () => {
    const C = await mk();
    const post = (u, data) => C.ctx.request.post(BASE + u, { data });
    const name = `user${Date.now().toString(36)}`;
    let r = await post('/api/auth/register', { username: name, password: 'correct horse battery', displayName: 'Dana' });
    if (r.status() !== 201) throw new Error(`register ${r.status()}`);
    r = await post('/api/auth/register', { username: name, password: 'another long password' });
    if (r.status() !== 409) throw new Error(`duplicate register ${r.status()}`);
    r = await post('/api/rooms', { name: 'Forever', slug: `club-${name}`, permanent: true, password: 'sesame' });
    if (r.status() !== 201) throw new Error(`create ${r.status()} ${await r.text()}`);
    const slug = (await r.json()).room.id;
    // someone else without the password
    const D = await mk();
    await post.call(null, '/api/auth/logout', {});
    const guest = await D.ctx.request.post(`${BASE}/api/auth/guest`, { data: { name: 'Eve' } });
    if (!guest.ok()) throw new Error('guest');
    let g = await D.ctx.request.get(`${BASE}/api/rooms/${slug}`);
    if ((await g.json()).access !== false) throw new Error('locked room leaked access');
    g = await D.ctx.request.post(`${BASE}/api/rooms/${slug}/join`, { data: { password: 'nope' } });
    if (g.status() !== 401) throw new Error(`wrong password gave ${g.status()}`);
    g = await D.ctx.request.post(`${BASE}/api/rooms/${slug}/join`, { data: { password: 'sesame' } });
    if (!g.ok()) throw new Error('right password rejected');
    g = await D.ctx.request.get(`${BASE}/api/rooms/${slug}`);
    if (!(await g.json()).access) throw new Error('no access after password');
    r = await D.ctx.request.post(`${BASE}/api/rooms`, { data: { name: 'x', slug: 'abcdef' } });
    if (r.status() !== 403) throw new Error(`guest custom address gave ${r.status()}`);
    await C.ctx.close(); await D.ctx.close();
  });

  await step('cross-site writes are refused', async () => {
    const res = await A.ctx.request.post(`${BASE}/api/rooms`, { data: { name: 'x' }, headers: { Origin: 'https://evil.example' } });
    if (res.status() !== 403) throw new Error(`expected 403, got ${res.status()}`);
  });

  await browser.close();
  fixtures.close();
  console.log(failed ? `\n${failed} check(s) failed\n` : '\nAll checks passed\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
