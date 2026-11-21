// Offline shell: the app opens and predicts with no signal. /api calls always go to the network.
// Version v0.MINOR.PATCH (beta): a new feature or change goes up a minor, a bug fix a patch.
// Phones from before v0.70.0 read the version as "agaration-v" + a number: this keeps them updating.
// (legacy marker: agaration-v70)
const CACHE = 'agaration-0.77.3';
const SHELL = [
  './',
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
  'cpf.js',
  'rain.js',
  'notices.js',
  'arrivals.js',
  'erp.js',
  'me.js',
  'animals.js',
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
  // Pages are kept under './' (the server redirects /index.html to /, and browsers refuse to open a
  // page from a saved copy marked as redirected: that was the ERR_FAILED / blank-page bug).
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const key = req.mode === 'navigate' ? './' : req;
      const cached = clean(await cache.match(key));
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok && !res.redirected) cache.put(key, res.clone());
          return res.redirected ? clean(res) : res;
        })
        .catch(() => cached || (req.mode === 'navigate' ? offlinePage() : Response.error()));
      return cached || fresh;
    }),
  );
});

// A saved copy that came through a redirect, rebuilt as a plain response the browser will accept.
function clean(res) {
  if (!res || !res.redirected) return res;
  return res.blob().then((body) => new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers }));
}
// No copy and no signal: a short page instead of the browser's error screen.
function offlinePage() {
  return new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agaration</title><body style="font:16px system-ui;padding:24px;background:#131615;color:#eef1ee"><h2>No connection</h2><p>Agaration will open when you have signal again.</p><button onclick="location.reload()" style="font:inherit;padding:10px 16px">Try again</button>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
