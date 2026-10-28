// Offline support: cache the app shell, serve it cache-first, refresh in the background.
// API calls (/api/…) and Supabase always go to the network.
const CACHE = 'shoebox-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/styles.css',
  'js/app.js', 'js/backend.js', 'js/categories.js', 'js/dates.js', 'js/db.js', 'js/export.js', 'js/extract.js', 'js/format.js',
  'js/image.js', 'js/overlay.js', 'js/sheets.js', 'js/store.js', 'js/tax.js', 'js/util.js', 'js/views.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('shoebox-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
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
