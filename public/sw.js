// Offline shell: the app opens and predicts with no signal. /api calls always go to the network.
const CACHE = 'fareit-v12';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'model.js',
  'places.js',
  'db.js',
  'sync.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // Only this app's old caches: the beta's (fareit-beta-…) belong to the beta's worker.
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('fareit-v') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/beta/')) return; // the beta has its own service worker and cache

  // Stale-while-revalidate: answer from cache instantly, refresh in the background.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const key = req.mode === 'navigate' ? 'index.html' : req;
      const cached = await cache.match(key);
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
