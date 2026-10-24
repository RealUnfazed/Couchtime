'use strict';

const { HttpError } = require('./errors');

// Turns whatever the user pasted into { provider, mediaId, url, start }.
// provider: "youtube" | "vimeo" | "file" (any other http(s) link, played by a <video> tag, HLS included).

function parseTime(v) {
  if (!v) return 0;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(v);
  if (!m) return 0;
  return (parseInt(m[1] || 0, 10) * 3600) + (parseInt(m[2] || 0, 10) * 60) + parseInt(m[3] || 0, 10);
}

function parseMedia(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new HttpError(400, 'Paste a link first.');
  if (raw.length > 2000) throw new HttpError(400, 'That link is too long.');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;

  let u;
  try { u = new URL(raw); } catch (_) { throw new HttpError(400, 'That does not look like a link.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'Only http and https links work.');

  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');

  // YouTube
  let ytId = null;
  if (host === 'youtu.be') {
    ytId = u.pathname.split('/')[1];
  } else if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') ytId = u.searchParams.get('v');
    else {
      const m = /^\/(?:embed|shorts|live|v)\/([\w-]{11})/.exec(u.pathname);
      if (m) ytId = m[1];
    }
  }
  if (ytId && /^[\w-]{11}$/.test(ytId)) {
    return {
      provider: 'youtube',
      mediaId: ytId,
      url: `https://www.youtube.com/watch?v=${ytId}`,
      start: parseTime(u.searchParams.get('t') || u.searchParams.get('start')),
    };
  }

  // Vimeo (public and unlisted links)
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = /^\/(?:video\/)?(\d{5,12})(?:\/([0-9a-f]{6,}))?/i.exec(u.pathname);
    if (m) {
      const hash = m[2] || u.searchParams.get('h') || '';
      return {
        provider: 'vimeo',
        mediaId: m[1],
        url: hash ? `https://vimeo.com/${m[1]}/${hash}` : `https://vimeo.com/${m[1]}`,
        start: 0,
      };
    }
  }

  // Anything else: let the browser try to play it as a video file / stream.
  return { provider: 'file', mediaId: u.href, url: u.href, start: 0 };
}

function fileTitle(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return (last || u.hostname).slice(0, 120);
  } catch (_) {
    return 'Video';
  }
}

async function oembed(endpoint, url) {
  try {
    const res = await fetch(`${endpoint}${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return '';
    const j = await res.json();
    return String(j.title || '').slice(0, 120);
  } catch (_) {
    return '';
  }
}

// Only fixed, well-known hosts are ever contacted here, never the user-supplied URL itself.
async function resolveTitle(media) {
  if (media.provider === 'youtube') return (await oembed('https://www.youtube.com/oembed?format=json&url=', media.url)) || 'YouTube video';
  if (media.provider === 'vimeo') return (await oembed('https://vimeo.com/api/oembed.json?url=', media.url)) || 'Vimeo video';
  return fileTitle(media.url);
}

module.exports = { parseMedia, resolveTitle };
