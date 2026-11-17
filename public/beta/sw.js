// Beta offline shell, separate from the main app's (scope /beta/, cache fareit-beta-…).
const CACHE = 'fareit-beta-v14';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'model.js',
  'places.js',
  'db.js',
  'sync.js',
  'formula.js',
  'lab.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('fareit-beta-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (!url.pathname.startsWith('/beta/')) return; // only the beta's own files

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
