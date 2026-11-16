// Fareit Worker: serves the PWA from ./public and proxies OneMap (Singapore Land Authority).
//
//   GET /api/status                      -> { map, keyRequired, authorized }
//   GET /api/search?q=...                -> { results: [{ label, address, postal, lat, lng }] }
//   GET /api/route?from=lat,lng&to=lat,lng -> { km, min, source: "onemap" }
//
// Secrets (npx wrangler secret put NAME):
//   ONEMAP_EMAIL, ONEMAP_PASSWORD  your free OneMap account, used to get and refresh the API token
//   APP_KEY (optional)             if set, the app must send it as the x-fareit-key header
//
// Nothing about trips is stored here. Trips live on the phone.

const OM = 'https://www.onemap.gov.sg';
const SG = { latMin: 1.15, latMax: 1.48, lngMin: 103.55, lngMax: 104.1 };
const ROUTE_CACHE_SECONDS = 60 * 60 * 24 * 14;

let tokenCache = { token: null, exp: 0, pending: null };
export function resetTokenCache() {
  tokenCache = { token: null, exp: 0, pending: null };
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function authorized(request, env) {
  if (!env.APP_KEY) return true;
  return sameString(request.headers.get('x-fareit-key') || '', env.APP_KEY);
}

async function getToken(env) {
  if (!env.ONEMAP_EMAIL || !env.ONEMAP_PASSWORD) return null;
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.exp - 60 * 60 * 1000) return tokenCache.token;
  if (!tokenCache.pending) {
    tokenCache.pending = (async () => {
      const res = await fetch(`${OM}/api/auth/post/getToken`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: env.ONEMAP_EMAIL, password: env.ONEMAP_PASSWORD }),
      });
      if (!res.ok) throw new Error(`OneMap sign-in failed (${res.status})`);
      const data = await res.json();
      if (!data.access_token) throw new Error('OneMap sign-in returned no token');
      const expSeconds = Number(data.expiry_timestamp);
      tokenCache.token = data.access_token;
      tokenCache.exp = Number.isFinite(expSeconds) && expSeconds > 0 ? expSeconds * 1000 : now + 2 * 24 * 3600 * 1000;
      return tokenCache.token;
    })().finally(() => {
      tokenCache.pending = null;
    });
  }
  return tokenCache.pending;
}

function parsePoint(s) {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(String(s || '').trim());
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (lat < SG.latMin || lat > SG.latMax || lng < SG.lngMin || lng > SG.lngMax) return null;
  return { lat, lng };
}

async function search(q, env) {
  const token = await getToken(env).catch(() => null);
  const url = new URL(`${OM}/api/common/elastic/search`);
  url.searchParams.set('searchVal', q);
  url.searchParams.set('returnGeom', 'Y');
  url.searchParams.set('getAddrDetails', 'Y');
  url.searchParams.set('pageNum', '1');
  const res = await fetch(url, { headers: token ? { Authorization: token } : {} });
  if (!res.ok) return json({ error: 'Address search is unavailable right now.' }, 502);
  const data = await res.json();
  const results = (data.results || [])
    .slice(0, 8)
    .map((r) => ({
      label: r.BUILDING && r.BUILDING !== 'NIL' ? `${r.BUILDING}` : r.SEARCHVAL,
      address: r.ADDRESS,
      postal: r.POSTAL && r.POSTAL !== 'NIL' ? r.POSTAL : null,
      lat: Number(r.LATITUDE),
      lng: Number(r.LONGITUDE),
    }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  return json({ results });
}

async function route(from, to, env) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const round = (p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
  const cacheKey = new Request(`https://fareit.cache/route?from=${round(from)}&to=${round(to)}`);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let token;
  try {
    token = await getToken(env);
  } catch {
    return json({ error: 'Signing in to OneMap failed. Check ONEMAP_EMAIL and ONEMAP_PASSWORD on the server.' }, 503);
  }
  if (!token) return json({ error: 'OneMap isn’t set up on the server yet. Add ONEMAP_EMAIL and ONEMAP_PASSWORD.' }, 503);

  const url = new URL(`${OM}/api/public/routingsvc/route`);
  url.searchParams.set('start', `${from.lat},${from.lng}`);
  url.searchParams.set('end', `${to.lat},${to.lng}`);
  url.searchParams.set('routeType', 'drive');
  const res = await fetch(url, { headers: { Authorization: token } });
  if (res.status === 401) {
    resetTokenCache();
    return json({ error: 'OneMap session expired. Try again.' }, 502);
  }
  if (!res.ok) return json({ error: 'Route lookup failed.' }, 502);
  const data = await res.json();
  const sum = data.route_summary;
  if (!sum || !Number.isFinite(Number(sum.total_distance))) return json({ error: 'OneMap found no driving route between those places.' }, 404);

  const body = { km: Number((Number(sum.total_distance) / 1000).toFixed(2)), min: Number((Number(sum.total_time) / 60).toFixed(1)), source: 'onemap' };
  const out = new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${ROUTE_CACHE_SECONDS}` },
  });
  if (cache) await cache.put(cacheKey, out.clone()).catch(() => {});
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    if (url.pathname === '/api/status') {
      return json({ ok: true, map: Boolean(env.ONEMAP_EMAIL && env.ONEMAP_PASSWORD), keyRequired: Boolean(env.APP_KEY), authorized: authorized(request, env) });
    }
    if (!authorized(request, env)) return json({ error: 'Access key missing or wrong. Set it in Fareit under Settings.' }, 401);

    try {
      if (url.pathname === '/api/search') {
        const q = (url.searchParams.get('q') || '').trim();
        if (q.length < 2 || q.length > 120) return json({ error: 'Search needs 2 to 120 characters.' }, 400);
        return await search(q, env);
      }
      if (url.pathname === '/api/route') {
        const from = parsePoint(url.searchParams.get('from'));
        const to = parsePoint(url.searchParams.get('to'));
        if (!from || !to) return json({ error: 'from and to must be lat,lng points in Singapore.' }, 400);
        return await route(from, to, env);
      }
    } catch {
      return json({ error: 'OneMap couldn’t be reached.' }, 502);
    }
    return json({ error: 'Not found' }, 404);
  },
};
