// Retires the old offline copy so this address always shows the "moved" page.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
    .then(() => self.registration.unregister())
    .then(() => self.clients.matchAll({ type: 'window' }))
    .then(list => list.forEach(c => c.navigate(c.url).catch(() => {}))));
});
