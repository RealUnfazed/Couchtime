# Couchtime

Watch videos together in sync. Make a room, send the link, and everyone's player stays on the same second. Includes chat, a queue, voice, camera and screen share, optional accounts, and room moderation.

Node.js + MongoDB. Runs on your own machine, on any VPS, or on Vercel, and every piece it needs has a free tier that covers a handful of friends.

## What it does

- **Rooms with invite links.** Guests join with just a nickname. Rooms can have a password, and the host picks who may control playback (everyone, host and moderators, or host only).
- **Synced playback.** Play, pause, seek, speed and "change the video" are shared. People who join late or reconnect land on the right second. Sources: YouTube, Vimeo, and direct video or audio links (`.mp4`, `.webm`, `.m3u8` HLS and more).
- **One player for every source.** The room draws its own control bar (play, seek bar with buffering, volume, speed, sync, theater, full screen) and switches off YouTube's, Vimeo's and the browser's own controls, so every video looks and behaves the same. Details in [The player](#the-player).
- **Queue.** Add links, the next one starts when the current one ends.
- **Chat.** History is kept for 7 days, links are clickable, everything is escaped.
- **Voice, camera, screen share.** WebRTC between browsers, with speaking indicators. Screen share can include tab audio.
- **Accounts (optional).** Rooms that never expire, your own room address (`/r/movie-club`), the same name and color everywhere. Rooms you made as a guest move into your account when you sign in.
- **Moderation.** Host can promote moderators and remove people.
- **Installable app (PWA).** Install it from the browser to get its own window and icon, with a friendly offline page. See [Install it as an app](#install-it-as-an-app).

## The one tricky part: Vercel has no WebSockets

Vercel runs your code as short-lived functions, so it cannot hold a WebSocket open. The app solves this by splitting the job:

```
              Browser                                  Server (Express)
   ┌──────────────────────────┐   HTTPS (REST)    ┌─────────────────────────┐
   │ play / pause / seek /    │ ───────────────►  │ checks permissions,     │
   │ chat / queue             │                   │ saves to MongoDB,       │
   │                          │                   │ then broadcasts ──┐     │
   │                          │ ◄───────────────  │                   │     │
   └───────────▲──────────────┘                   └───────────────────┼─────┘
               │      realtime events (state, chat, presence)         │
               └──────────────────────────────────────────────────────┘
                 Socket.IO (local / VPS)      or      Ably (Vercel)
```

- **Local or VPS:** a built-in Socket.IO server does the broadcasting. Nothing else to sign up for.
- **Vercel:** [Ably](https://ably.com/) does the broadcasting. The Ably free plan is 6,000,000 messages a month and 200 simultaneous connections, with no credit card ([source](https://ably.com/docs/platform/pricing/free)). Your Ably key stays on the server, browsers only get short-lived tokens limited to one room.

The switch is automatic (`REALTIME_DRIVER` is `ably` on Vercel and `socketio` everywhere else), and the browser code is identical for both.

Voice and screen share go **directly between browsers** (WebRTC), so they use no Vercel or Ably capacity at all. Only the setup handshake goes through the realtime channel.

## The player

The control bar sits on the bottom of the picture and fades out while a video plays. Move the mouse (or tap on a phone) to bring it back.

| Control | What it does | Shared with the room? |
|---|---|---|
| Play / pause, click on the picture | Plays or pauses everyone. It reacts instantly here, then the room follows. | yes |
| Seek bar | Drag or click to jump everyone to that second. Shows how far the video has buffered. | yes |
| Speed | 0.5x to 2x | yes |
| Next | Starts the next video in the queue (only shown when there is one) | yes |
| Volume, mute | Your own volume. It is remembered in your browser. | no |
| Sync | Reloads the video and lines it up with the room again | no |
| Chat | Opens a one-line box over the picture (or the chat tab) | no |
| Theater | Hides the side panel so the video gets the whole page. Cameras and chat float over the picture. | no |
| Full screen | The whole player goes full screen, **including** the control bar, the newest chat lines and everyone's camera, so you never lose your friends. Phones that refuse element full screen get a page-sized version. | no |

Keyboard (not while typing in a box): `Space` or `K` play/pause, `J` / `L` back or forward 10 seconds, `←` / `→` 5 seconds, `↑` / `↓` volume, `M` mute, `F` full screen, `T` theater, `Enter` chat over the picture.

If the room is set so that only the host may control playback, everyone else sees the bar dimmed and pressing a shared control explains why. Volume, full screen and theater still work for them.

Every provider is hidden behind the same small adapter (`public/js/players.js`), so adding another source means one class with `play`, `pause`, `seek`, `getTime`, `getDuration`, `getBuffered`, `setAudio` and friends.

## Install it as an app

Couchtime is a progressive web app: a manifest, icons and a service worker, with no app store involved.

- **Chrome, Edge, Android:** use the **Install** button in the top bar, or the install icon in the address bar. On Android, "Add to Home screen" works too.
- **iPhone and iPad (Safari):** Share, then **Add to Home Screen**. There is no Install button on iOS, because Safari does not offer one to pages. Not tested on iOS: screen sharing is not available in Safari at all, and voice in a home-screen app may behave differently from Safari, so use Safari if a call misbehaves.
- It needs `https://` or `localhost`. Vercel gives you https. A plain `http://192.168.x.x` address cannot install or run a service worker.

What the service worker (`public/sw.js`) does:

| It does | It never touches |
|---|---|
| Keeps the static files (CSS, JavaScript, fonts, icons) for faster repeat visits | `/api/*`: rooms, chat, playback state, TURN credentials are always live |
| Loads those files **network first**, so a new deploy shows up on the next load and the saved copy is only a fallback | `/socket.io/*` and every other website: Ably, YouTube, Vimeo, hls.js and your video files |
| Shows an "offline" page, which reloads itself when the connection returns, instead of the browser's error page | Video and audio range requests |

So there is no offline mode for watching: a room needs the internet to keep everyone in sync. The worker is there for installation, speed and a friendlier failure.

Things to know when you change the app:

- **Rename it:** edit `name`, `short_name` and the titles in `public/manifest.webmanifest` and `public/offline.html`, plus `APP_NAME` and the `<title>` in the two HTML files.
- **New icons:** edit the colors in `scripts/make-icons.js`, then run `node scripts/make-icons.js`. It writes `public/icons/` (needs `playwright-core` and a Chromium, set `CHROME_PATH` if needed).
- **Changing the saved file list** in `PRECACHE` inside `public/sw.js`: bump `VERSION` in that file, so the old cache is removed. Normal code changes need nothing, because of network first.
- **Updates:** browsers re-check `sw.js` on every visit. The Vercel config and the local server both send it with `Cache-Control: no-cache` so a new version is picked up straight away.

## Run it locally

You need Node 20 or newer and a MongoDB.

```bash
npm install
cp .env.example .env          # defaults work for local use
docker compose up -d          # starts MongoDB (or put an Atlas URL in .env instead)
npm start                     # http://localhost:3000
```

No Docker? Use a free [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) cluster and paste its connection string into `MONGODB_URI`.

Open two browser windows (one normal, one private) to try it as two people. Camera, microphone and screen share work on `localhost` and on any `https://` address, but browsers block them on plain `http://` addresses like `http://192.168.1.20:3000`.

## Deploy on Vercel (free)

1. **Database.** Create a free MongoDB Atlas cluster (Free tier, 512 MB). Under *Database Access* create a user, under *Network Access* allow `0.0.0.0/0` (Vercel's addresses change), then copy the connection string.
2. **Realtime.** Create a free Ably account and make an app. Under *API Keys* create a key with the capabilities `publish`, `subscribe` and `presence`, restricted to the channels `room:*,sig:*`, and copy it (it looks like `xxxxxx.yyyyyy:zzzzzzzz`). The Root key also works but can do far more than this app needs. Do **not** use the "Subscribe only" key: it cannot publish, so changes would be saved but never reach other people.
3. **Push this folder to a GitHub repo.**
4. **Import it in Vercel.** Framework preset: *Other*. Leave build settings empty.
5. **Add environment variables** (Project, Settings, Environment Variables). `.env.example.vercel` is a ready-made template: fill it in, then import it or paste its lines there. Vercel does not read a `.env` file from the repository, so never commit your real values.

   | Name | Value |
   |---|---|
   | `MONGODB_URI` | your Atlas connection string, with `/couchtime` as the database name |
   | `JWT_SECRET` | a long random string: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
   | `ABLY_API_KEY` | the Ably key |
   | `REALTIME_DRIVER` | `ably` |
   | `TURN_PROVIDER` and its keys | optional, see the next section |

6. **Deploy**, then open `https://your-app.vercel.app/api/health`. It shows what is connected and lists anything still missing.

Vercel's Hobby plan is free but for **non-commercial, personal use only** ([Vercel Hobby plan](https://vercel.com/docs/plans/hobby)). For a friends-and-family watch room that is fine. A paid or public product needs the Pro plan, or run `server.js` on your own VPS instead.

## STUN and TURN (voice and screen share)

Two browsers need help finding each other:

- **STUN** tells each browser its public address. It is free and already configured (Cloudflare and Google servers). It works for most home networks.
- **TURN** relays the call when a direct path is impossible, which happens on some mobile networks, strict routers and office Wi-Fi. Without it, some connections simply fail. Voice is light, but screen share is video, so relays carry real traffic.

Pick **one** TURN provider and set its variables:

| Provider | Free amount | Variables |
|---|---|---|
| **Cloudflare** | Its pricing page lists a 1,000 GB free allowance for TURN and SFU together ([pricing](https://developers.cloudflare.com/realtime/sfu/pricing)). Its TURN page says TURN is free when used with its SFU and $0.05 per GB otherwise ([TURN](https://developers.cloudflare.com/realtime/turn/)). Check the current terms on your account first, and note it may ask for a payment method. | `TURN_PROVIDER=cloudflare`, `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`. Create a TURN key in the Cloudflare dashboard under Realtime. |
| **Metered Open Relay** (pricing page says no credit card) | The Open Relay page promises 20 GB a month ([site](https://www.metered.ca/tools/openrelay/)), but Metered's own pricing page lists a 500 MB free tier ([pricing](https://www.metered.ca/stun-turn)). Check the allowance in your dashboard after signing up. Works on ports 80 and 443, so it gets through strict networks. | `TURN_PROVIDER=metered`, `METERED_APP` (the `name` in `name.metered.live`), `METERED_API_KEY` |
| **ExpressTURN** (sign-up asks only for email and password) | 1,000 GB a month on the free plan, plain TURN on port 3478 only ([site](https://www.expressturn.com/)) | `TURN_PROVIDER=static`, `TURN_URLS=turn:free.expressturn.com:3478?transport=udp,turn:free.expressturn.com:3478?transport=tcp`, `TURN_USERNAME`, `TURN_CREDENTIAL` (from the ExpressTURN dashboard) |
| **Your own coturn** | whatever your server has | `TURN_PROVIDER=coturn`, `TURN_URLS`, `TURN_SECRET` (uses coturn's `use-auth-secret`) |
| **Any other TURN** | varies | `TURN_PROVIDER=static`, `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` |

The server hands out short-lived credentials through `GET /api/ice`, so no TURN secret is ever shipped to the browser. If the TURN lookup fails, calls quietly fall back to STUN only.

## Settings reference

| Variable | Default | Notes |
|---|---|---|
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/couchtime` | Required on Vercel |
| `JWT_SECRET` | dev placeholder | **Required in production** |
| `REALTIME_DRIVER` | `ably` on Vercel, else `socketio` | |
| `ABLY_API_KEY` | none | Needed when the driver is `ably` |
| `TURN_PROVIDER` | none (STUN only) | `cloudflare`, `metered`, `coturn`, `static` |
| `APP_NAME` | `Couchtime` | Shown in the UI. Also edit `<title>` in the two HTML files, and the name in `manifest.webmanifest` and `offline.html`, if you rename it. |
| `ROOM_IDLE_HOURS` | `24` | Guest rooms are deleted after this long without visitors |
| `CHAT_KEEP_DAYS` | `7` | Chat history lifetime |
| `PORT` | `3000` | Local server only |

## Is it really free for about 10 people?

| Part | Free allowance | What 10 regular viewers use |
|---|---|---|
| Vercel Hobby | 1M function invocations, 100 GB transfer ([limits](https://vercel.com/docs/plans/hobby)) | A few thousand requests a month. Every button press is one request. |
| MongoDB Atlas | 512 MB storage, 100 operations a second ([limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/)) | Kilobytes. Chat and guest rooms delete themselves. |
| Ably | 6M messages a month, 200 connections | One chat line in a 10-person room is 11 messages, so about 500,000 lines would fit if chat were all you did. |
| TURN | Depends on the provider, from a few GB (Metered) to 1,000 GB (ExpressTURN, Cloudflare). See the table above. | Voice is roughly 30 MB an hour for a person whose call is relayed. Most calls connect directly and use none. |

Atlas pauses a free cluster after 30 days with no connections at all. Opening the site once resumes it.

## How the sync works

The server stores one anchor per room: `playing`, `position`, `updatedAt`, `rate` and a `version`. The real position is `position + (now - updatedAt) * rate`, and every browser computes it with a clock corrected against the server's, so device clocks being off by seconds does not matter.

- Pressing play, pause or seek (on the control bar, with the keyboard, or on the picture) moves your own player first so it feels instant, then sends one small request. The server checks permissions, bumps `version`, saves, and broadcasts the new anchor. Everyone applies it.
- Each browser also watches its own player. If the person pressed pause, dragged the scrubber or changed speed, that becomes a request. If they are not allowed to control playback, the player snaps back and a message explains why.
- If a browser drifts more than about 1.6 seconds (buffering, a slow phone), it jumps back to the right second. At most once every 5 seconds, so it cannot fight itself.
- If the browser blocks autoplay, a "Click to join the video" button appears. A real click satisfies the browser's rules.
- The player only listens to events with a newer `version`, so late or duplicate messages are harmless. On reconnect, or when you come back to the tab, the browser re-reads the room.

## Limits worth knowing

- **Calls are a mesh.** Every person connects to every other person, which is simple and needs no media server, but it works well only up to about 6 people in the call. Sharing a screen sends it once per viewer, so the sharer's upload matters. For bigger groups you would add an SFU such as LiveKit.
- **Netflix, Disney+ and similar sites cannot be embedded.** Their video is copy-protected. Share a browser tab with "Share tab audio" ticked instead.
- **YouTube** videos whose owners disable embedding show an error in the room. Pick another upload. Because the room draws the controls, YouTube's own quality, captions and subtitle menus are not available, and YouTube may still show its "more videos" tiles while a video is paused.
- **Direct links** must be reachable by every viewer's browser and allow playback from other sites. For `.m3u8` streams the server must send CORS headers.
- **Removing someone** blocks them in the API and disconnects them. On Ably their browser leaves when it receives the removal notice, which a modified client could ignore, but it still cannot read chat history or change playback.
- **Rate limits** are kept in each server instance's memory. On Vercel that is a speed bump against spam, not a hard guarantee.
- **No Content Security Policy** is set, because the page loads the YouTube, Vimeo and Ably scripts. Add one if you host this publicly.

## Project layout

```
server.js            long-running entry (local, VPS): Express + Socket.IO
api/index.js         Vercel entry: the same Express app
vercel.json          routes /api/* to the function and /r/:id to the room page, and sets headers for sw.js and the manifest
src/app.js           middleware, routes, error handling
src/routes/          auth, rooms (state, queue, chat, moderation), health/ice/realtime token
src/realtime/        socketio.js and ably.js behind one small interface
src/lib/             media link parsing, TURN credentials, access rules
src/models/          User, Room, Message (Mongoose)
public/              the whole front end: plain HTML, CSS and ES modules, no build step
public/js/sync.js    the sync engine
public/js/players.js YouTube, Vimeo and file/HLS adapters
public/js/controls.js the control bar, keyboard shortcuts, volume
public/js/pwa.js     registers the service worker, the Install button
public/sw.js         the service worker (static files, offline page)
public/manifest.webmanifest  app name, colors and icons for installing
public/offline.html  shown when the network is gone
public/icons/        app icons, made by scripts/make-icons.js
public/js/rtc.js     voice, camera and screen share
scripts/make-icons.js  regenerates public/icons
test/e2e.js          two real browsers in one room (see below)
```

## Tests

With the app and MongoDB running:

```bash
BASE=http://localhost:3000 npm run test:e2e
```

It opens two browsers (sized like a 1368x768 laptop screen) and checks synced play, pause, seek and late joining, the control bar and keyboard shortcuts, the YouTube adapter (against a stand-in for YouTube's player API, since the real one needs the internet), chat, the queue and auto-advance, host-only mode, voice, camera and screen share between the two, that camera tiles keep a readable size from 1920x1080 down to a phone, full screen and theater mode, removing a person, accounts, room passwords, cross-site request blocking, and the PWA pieces (manifest and icons, service worker takeover, Chrome's installability check, that live data is never saved, the offline page and the Install button). It needs `ffmpeg` (to make a small test video) and a Chromium. Set `CHROME_PATH` if Playwright's own browser is not installed.

## Credits

Fonts are self-hosted: [Bricolage Grotesque](https://github.com/ateliertriay/bricolage) and [Figtree](https://github.com/erikdkennedy/figtree), both under the SIL Open Font License 1.1.
