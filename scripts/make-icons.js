'use strict';

/*
  Regenerates the app icons in public/icons from the same artwork as the logo inside the app
  (an amber rounded square with a dark play button). Run it again if you change the colors below.

    node scripts/make-icons.js

  Needs playwright-core (already a devDependency) and a Chromium. Set CHROME_PATH to a Chromium or
  Chrome binary if Playwright's own browser is not installed.
*/

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, '..', 'public', 'icons');
const AMBER = '#ffb547';
const INK = '#2b1a02';
const PLAY = 'M12 8l12 8-12 8z';

// scale > 1 enlarges the play button around the center of the square
const art = ({ rounded, scale = 1 }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32"${rounded ? ' rx="8"' : ''} fill="${AMBER}"/>
<g transform="translate(16 16) scale(${scale}) translate(-16 -16)"><path d="${PLAY}" fill="${INK}"/></g>
</svg>`;

const FILES = [
  // Browsers and the install dialog. Transparent corners.
  { name: 'icon.svg', svg: art({ rounded: true }) },
  { name: 'icon-192.png', size: 192, svg: art({ rounded: true }) },
  { name: 'icon-512.png', size: 512, svg: art({ rounded: true }) },
  // Android adaptive icons crop to a circle or squircle, so the artwork fills the square and the
  // play button stays inside the middle 80 percent that is never cropped.
  { name: 'icon-maskable-512.png', size: 512, svg: art({ rounded: false, scale: 1.25 }) },
  // iPhone home screen: no transparency allowed, iOS rounds the corners itself.
  { name: 'apple-touch-icon.png', size: 180, svg: art({ rounded: false, scale: 1.1 }) },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  for (const f of FILES) {
    if (!f.size) { fs.writeFileSync(path.join(OUT, f.name), f.svg.trim() + '\n'); console.log('wrote', f.name); continue; }
    const page = await browser.newPage({ viewport: { width: f.size, height: f.size }, deviceScaleFactor: 1 });
    const uri = `data:image/svg+xml;base64,${Buffer.from(f.svg).toString('base64')}`;
    await page.setContent(`<body style="margin:0;background:transparent"><img src="${uri}" width="${f.size}" height="${f.size}" style="display:block"></body>`);
    await page.waitForFunction(() => document.querySelector('img').complete);
    fs.writeFileSync(path.join(OUT, f.name), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: f.size, height: f.size } }));
    await page.close();
    console.log('wrote', f.name, `${f.size}x${f.size}`);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
