// Offline support: cache the app shell, serve it cache-first, refresh in the background.
// API calls (/api/…), Supabase, YouTube and thumbnails always go to the network.
const CACHE = 'breakout-v5';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/styles.css',
  'js/analyse.js', 'js/app.js', 'js/backend.js', 'js/db.js', 'js/discover.js', 'js/gemini.js', 'js/overlay.js', 'js/rows.js', 'js/score.js', 'js/sheets.js', 'js/store.js', 'js/tracker.js', 'js/util.js', 'js/views.js', 'js/youtube.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the HTTP cache so a new version never installs old files.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('breakout-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      const network = fetch(request).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
        return res;
      });
      if (cached) { network.catch(() => {}); return cached; }
      return network.catch(() => caches.match('index.html'));
    }),
  );
});
