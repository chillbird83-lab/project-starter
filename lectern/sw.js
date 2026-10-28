// Lectern moved to https://chillbird83-lab.github.io/lectern/. This replaces its old offline worker on
// phones that opened it here: it deletes the old cache, unregisters itself and sends open windows to the
// new address. Recordings are unaffected — they live in the site's IndexedDB, which both addresses share.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    await caches.delete('lectern-v1');
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: 'window' });
    await Promise.all(windows.map((w) => w.navigate('../../lectern/').catch(() => {})));
  })());
});
