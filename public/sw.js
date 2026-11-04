'use strict';

/*
  Couchtime service worker.

  What it is for
    - lets browsers offer to install the site as an app
    - shows a friendly "cannot reach Couchtime" page instead of the browser's error page
    - keeps the static files (CSS, JavaScript, fonts, icons) so repeat visits start faster

  What it deliberately leaves alone, so nothing can go stale or out of sync
    - /api/*       rooms, chat, playback state, TURN credentials: always live, never saved
    - /socket.io/* realtime on a VPS: never touched
    - every request to another site (Ably, YouTube, Vimeo, video files, hls.js): never touched
    - video and audio range requests, and anything that is not a plain GET

  Static files use "network first": a new deploy shows up on the very next load, and the saved copy
  is only used when the network fails. Fonts never change, so they come from the saved copy.

  If you change PRECACHE below, bump VERSION so the old cache is thrown away.
*/

const VERSION = 'v1';
const CACHE = `couchtime-${VERSION}`;
const OFFLINE = '/offline.html';
const PRECACHE = [
  OFFLINE,
  '/css/app.css',
  '/fonts/bricolage.woff2',
  '/fonts/figtree.woff2',
  '/icons/icon.svg',
  '/icons/icon-192.png',
];
const STATIC_KINDS = new Set(['style', 'script', 'font', 'image', 'manifest']);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // "reload" skips the browser's own HTTP cache so a fresh install never saves stale copies.
    await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('couchtime-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
  if (url.pathname === '/sw.js') return;

  if (req.mode === 'navigate') {
    event.respondWith(page(req));
  } else if (STATIC_KINDS.has(req.destination)) {
    event.respondWith(url.pathname.startsWith('/fonts/') ? savedFirst(event, req) : networkFirst(event, req));
  }
});

// Pages are never saved (a room page is only useful live). If the network is gone, show the offline page.
async function page(req) {
  try {
    return await fetch(req);
  } catch (_) {
    const cache = await caches.open(CACHE);
    return (await cache.match(OFFLINE)) || new Response('Cannot reach Couchtime. Check your connection.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

function remember(event, cache, req, res) {
  // Only plain, complete, same-site answers are worth keeping. Never errors, redirects or partial content.
  if (res.status === 200 && res.type === 'basic') event.waitUntil(cache.put(req, res.clone()).catch(() => {}));
}

async function networkFirst(event, req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    remember(event, cache, req, res);
    return res;
  } catch (err) {
    const saved = await cache.match(req);
    if (saved) return saved;
    throw err;
  }
}

async function savedFirst(event, req) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(req);
  if (saved) return saved;
  const res = await fetch(req);
  remember(event, cache, req, res);
  return res;
}
