// The beta became the main app. Phones that still have the old beta's offline worker pick this
// up: it clears the beta's cache, unregisters itself and sends any open beta page to the app.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('fareit-beta-')).map((k) => caches.delete(k)));
    await self.registration.unregister();
    const pages = await self.clients.matchAll({ type: 'window' });
    for (const page of pages) page.navigate(page.url.replace('/beta/', '/'));
  })());
});
