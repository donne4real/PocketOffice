/* ==========================================================================
   sw.js — offline support for the HOSTED copy of PocketOffice (http/https).

   Opened from a folder (file://) the app is already fully offline and this
   file is never used: browsers do not run service workers there.

   What it does:
   - On install, saves the whole app (pages, styles, scripts, every library
     in lib/, the fonts) into a cache, so every tool works with no internet
     after the first visit — not just the tools you happened to open.
   - Network first: while online you always get the current files, and the
     cache is refreshed as you go. The cache is only used when the network
     is unavailable.
   - The list of files is read from index.html, js/libs.js and css/fonts.css
     rather than kept here by hand, so adding a script or library needs no
     change to this file.
   - The cache is named after the app version (js/version.js); an old
     version's cache is deleted when a new version takes over.
   ========================================================================== */

importScripts('js/version.js');   // defines PO_VERSION

const CACHE = 'pocketoffice-' + PO_VERSION.version;
const ALWAYS = [
  './', 'index.html', 'manifest.webmanifest', 'lib/pdf.worker.min.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

async function text(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(url + ' -> ' + r.status);
  return r.text();
}

// Every file the app can ask for, discovered from the app's own sources.
async function appFiles() {
  const urls = new Set(ALWAYS);
  const local = (u) => !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(u);
  for (const m of (await text('index.html')).matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"#?]+)"/g)) {
    if (local(m[1])) urls.add(m[1]);
  }
  for (const m of (await text('js/libs.js')).matchAll(/'(lib\/[^']+\.js)'/g)) urls.add(m[1]);
  for (const m of (await text('css/fonts.css')).matchAll(/url\(\s*['"]?\.\.\/([^'")]+)['"]?\s*\)/g)) urls.add(m[1]);
  return [...urls];
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const files = await appFiles();
    // All or nothing: a half-filled cache would mean a half-working app offline.
    await Promise.all(files.map(async (u) => {
      const r = await fetch(u, { cache: 'no-cache' });
      if (!r.ok) throw new Error(u + ' -> ' + r.status);
      await cache.put(u, r);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('pocketoffice-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
    for (const client of await self.clients.matchAll({ includeUncontrolled: true })) {
      client.postMessage({ type: 'po:offline-ready', version: PO_VERSION.version });
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh.ok && fresh.type === 'basic') {
        const copy = fresh.clone();
        event.waitUntil(caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}));
      }
      return fresh;
    } catch (err) {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: true }) ||
        (req.mode === 'navigate' ? await cache.match('index.html') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
