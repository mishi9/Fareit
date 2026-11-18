// Offline shell: the app opens and predicts with no signal. /api calls always go to the network.
const CACHE = 'agaration-v57';
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
  'queue.js',
  'where.js',
  'airport-zone.js',
  'access.js',
  'flights.js',
  'events.js',
  'info.js',
  'jb.js',
  'ferries.js',
  'surge.js',
  'alerts.js',
  'glance.js',
  'sanity.js',
  'daypattern.js',
  'earnings.js',
  'rain.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // Old caches from before the rename (fareit-…) and older Agaration ones.
      .then((keys) => Promise.all(keys.filter((k) => (k.startsWith('fareit-') || k.startsWith('agaration-')) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/beta/')) return; // the old beta address only redirects here
  if (url.pathname.endsWith('/sw.js')) return; // always from the server: it says which version is the latest

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
