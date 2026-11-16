// Fareit Worker: serves the PWA from ./public, proxies OneMap (Singapore Land Authority), and
// keeps the shared training pool that every phone contributes to and learns from.
//
//   GET  /api/status                         -> { map, pool, keyRequired, authorized }
//   GET  /api/search?q=...                   -> { results: [{ label, address, postal, lat, lng }] }
//   GET  /api/route?from=lat,lng&to=lat,lng  -> { km, min, source: "onemap" }
//   GET  /api/near?at=lat,lng                -> { label, address, postal, lat, lng } nearest address
//   POST /api/jobs   { device, jobs: [...] } -> { accepted, rejected }   add/update anonymous jobs
//   GET  /api/jobs?since=REV&limit=N         -> { jobs, next, more }     page through the pool
//   POST /api/jobs/delete { device, ids }    -> { deleted, missing }     remove your own jobs
//   POST /api/formula { device, trips }      -> { accepted, rejected }   beta formula dataset
//   GET  /api/formula?since=REV              -> { trips, next, more }    (separate from the pool)
//   POST /api/formula/delete { device, ids } -> { deleted, missing }
//
// No accounts. Each phone sends a random device id so it can correct its own rows and nobody
// else's. The pool holds no addresses, names or exact places: pickup and drop are rounded to
// about 1 km and times to 5 minutes before they leave the phone, and again here.
//
// Bindings and secrets:
//   DB (D1)                        the shared pool, created on deploy
//   ONEMAP_EMAIL, ONEMAP_PASSWORD  free OneMap account, used to get and refresh the API token
//   HASH_SALT (optional)           salt for the hashed IP used only for rate limiting
//   APP_KEY (optional)             if set, the app must send it as x-fareit-key. Leave it unset
//                                  for an open, collective app.

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

// Nearest address to a point (where the driver was when they tapped), for prefilling the pickup.
async function near(at, env) {
  let token;
  try {
    token = await getToken(env);
  } catch {
    return json({ error: 'Signing in to OneMap failed.' }, 503);
  }
  if (!token) return json({ error: 'OneMap isn’t set up on the server yet.' }, 503);
  for (const buffer of [150, 500]) {
    const url = new URL(`${OM}/api/public/revgeocode`);
    url.searchParams.set('location', `${at.lat},${at.lng}`);
    url.searchParams.set('buffer', String(buffer));
    url.searchParams.set('addressType', 'All');
    url.searchParams.set('otherFeatures', 'N');
    const res = await fetch(url, { headers: { Authorization: token } });
    if (res.status === 401) {
      resetTokenCache();
      return json({ error: 'OneMap session expired. Try again.' }, 502);
    }
    if (!res.ok) return json({ error: 'Address lookup failed.' }, 502);
    const data = await res.json();
    const nil = (v) => (v && v !== 'NIL' && v !== 'null' ? String(v) : '');
    const hit = (data.GeocodeInfo || data.GeoCodeInfo || [])
      .map((r) => ({ r, lat: Number(r.LATITUDE), lng: Number(r.LONGITUDE) }))
      .filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng))[0];
    if (!hit) continue;
    const { r } = hit;
    const street = [nil(r.BLOCK), nil(r.ROAD)].filter(Boolean).join(' ');
    const label = nil(r.BUILDINGNAME) || street || 'Near where you tapped';
    const postal = nil(r.POSTALCODE) || null;
    return json({ label, address: [street, postal].filter(Boolean).join(' '), postal, lat: hit.lat, lng: hit.lng });
  }
  return json({ error: 'No address near that point.' }, 404);
}

// ---------- shared training pool ----------
// 3 km bands (0-3 … 42-45, 45+), plus the old 5/10 km bands still on phones and in the pool.
const BANDS = [...Array.from({ length: 15 }, (_, i) => `${i * 3}-${i * 3 + 3}`), '45+', '0-5', '5-10', '10-15', '15-20', '20-30', '30-40', '40+'];
const ZONES = ['N', 'S', 'E', 'W', 'C', 'AIRPORT', 'WLC', 'TUAS', 'CF'];
const RIDES = ['standard', 'premium', 'xl', 'taxi'];
const MAX_JOBS_PER_POST = 50;
const MAX_NEW_JOBS_PER_IP_PER_DAY = 300;
const MAX_PAGE = 2000;
const FIVE_MIN = 5 * 60 * 1000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    device TEXT NOT NULL,
    ip_hash TEXT,
    received_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    rev INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    ride TEXT NOT NULL,
    band TEXT, zone TEXT, decision TEXT,
    km REAL, trip_min REAL, drive_min REAL, fare REAL, payment TEXT, pricing TEXT, card_km REAL,
    pickup_lat REAL, pickup_lng REAL, drop_lat REAL, drop_lng REAL
  )`,
  'CREATE INDEX IF NOT EXISTS jobs_rev ON jobs(rev)',
  'CREATE INDEX IF NOT EXISTS jobs_ip ON jobs(ip_hash, received_at)',
  // The beta formula dataset: exact trips for working out Grab's fare formula. Separate from the
  // jobs pool and never used by the main app. Numbers only: no places, no addresses.
  `CREATE TABLE IF NOT EXISTS formula_trips (
    id TEXT PRIMARY KEY,
    device TEXT NOT NULL,
    ip_hash TEXT,
    received_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    rev INTEGER NOT NULL,
    ts INTEGER,
    km REAL, min REAL, erp REAL, paid REAL, earned REAL, surge TEXT,
    predicted REAL, predicted_earned REAL,
    deleted INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS formula_rev ON formula_trips(rev)',
];
let schemaReady = null;
// Pools created before a column existed get it added; on newer ones it's already there.
const addColumn = (db, def) => Promise.resolve().then(() => db.prepare(`ALTER TABLE jobs ADD COLUMN ${def}`).run()).catch(() => {});
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.batch(SCHEMA.map((s) => db.prepare(s)))
      .then(() => addColumn(db, 'pricing TEXT'))
      .then(() => addColumn(db, 'card_km REAL'))
      .then(() => addColumn(db, 'deleted INTEGER'))
      .catch((e) => {
        schemaReady = null;
        throw e;
      });
  }
  return schemaReady;
}
export function resetSchemaFlag() {
  schemaReady = null;
}

const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const inRange = (v, lo, hi) => v === null || v === undefined || (Number.isFinite(v) && v >= lo && v <= hi);
const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);

function cleanPoint(lat, lng) {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return [null, null];
  if (!(lat >= SG.latMin && lat <= SG.latMax && lng >= SG.lngMin && lng <= SG.lngMax)) return undefined;
  return [r2(lat), r2(lng)];
}

// Returns a cleaned row, or null if anything is out of range.
export function cleanJob(j, now = Date.now()) {
  if (!j || typeof j !== 'object' || !ID_RE.test(String(j.id || ''))) return null;
  const ts = Number(j.ts);
  if (!Number.isFinite(ts) || ts < now - 180 * 86400 * 1000 || ts > now + 10 * 60 * 1000) return null;
  const ride = j.ride || 'standard';
  if (!RIDES.includes(ride)) return null;
  if (j.band != null && !BANDS.includes(j.band)) return null;
  if (j.zone != null && !ZONES.includes(j.zone)) return null;
  if (j.decision != null && !['took', 'cancelled'].includes(j.decision)) return null;
  if (j.payment != null && !['cash', 'cashless'].includes(j.payment)) return null;
  if (j.pricing != null && !['surge', 'normal', 'bad'].includes(j.pricing)) return null;
  const km = j.km == null ? null : Number(j.km);
  const tripMin = j.trip_min == null ? null : Number(j.trip_min);
  const driveMin = j.drive_min == null ? null : Number(j.drive_min);
  const fare = j.fare == null ? null : Number(j.fare);
  const cardKm = j.card_km == null ? null : Number(j.card_km);
  if (!inRange(cardKm, 0.5, 100)) return null;
  if (!inRange(km, 0.1, 80) || !inRange(tripMin, 1, 300) || !inRange(driveMin, 1, 300) || !inRange(fare, 2, 400)) return null;
  const pickup = cleanPoint(j.pickup_lat, j.pickup_lng);
  const drop = cleanPoint(j.drop_lat, j.drop_lng);
  if (!pickup || !drop) return null;
  const trainable = fare !== null && km !== null;
  if (!trainable && !j.decision) return null; // nothing useful in it
  return {
    id: j.id, ts: Math.round(ts / FIVE_MIN) * FIVE_MIN, ride, band: j.band ?? null, zone: j.zone ?? null,
    decision: j.decision ?? null, km: r2(km), trip_min: r2(tripMin), drive_min: r2(driveMin), fare: r2(fare),
    payment: j.payment ?? null, pricing: j.pricing ?? null, card_km: r2(cardKm), pickup_lat: pickup[0], pickup_lng: pickup[1], drop_lat: drop[0], drop_lng: drop[1],
  };
}

async function hashIp(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || '';
  const data = new TextEncoder().encode(`${env.HASH_SALT || 'fareit'}:${ip}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const UPSERT = `INSERT INTO jobs (id, device, ip_hash, received_at, updated_at, rev, ts, ride, band, zone, decision,
    km, trip_min, drive_min, fare, payment, pickup_lat, pickup_lng, drop_lat, drop_lng, pricing, card_km)
  VALUES (?1, ?2, ?3, ?4, ?4, (SELECT COALESCE(MAX(rev), 0) + 1 FROM jobs), ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
  ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, rev = excluded.rev, ts = excluded.ts, ride = excluded.ride,
    band = excluded.band, zone = excluded.zone, decision = excluded.decision, km = excluded.km, trip_min = excluded.trip_min,
    drive_min = excluded.drive_min, fare = excluded.fare, payment = excluded.payment, pickup_lat = excluded.pickup_lat,
    pickup_lng = excluded.pickup_lng, drop_lat = excluded.drop_lat, drop_lng = excluded.drop_lng,
    pricing = excluded.pricing, card_km = excluded.card_km
  WHERE jobs.device = excluded.device`;

async function postJobs(request, env) {
  const text = await request.text();
  if (text.length > 100 * 1024) return json({ error: 'Too much data in one upload.' }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Upload must be JSON.' }, 400);
  }
  const device = String(body.device || '');
  if (!ID_RE.test(device)) return json({ error: 'Missing device id.' }, 400);
  const jobs = Array.isArray(body.jobs) ? body.jobs.slice(0, MAX_JOBS_PER_POST) : [];
  if (!jobs.length) return json({ accepted: [], rejected: [] });

  await ensureSchema(env.DB);
  const now = Date.now();
  const ipHash = await hashIp(request, env);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs WHERE ip_hash = ?1 AND received_at > ?2')
    .bind(ipHash, now - 86400 * 1000).first();
  let budget = MAX_NEW_JOBS_PER_IP_PER_DAY - Number((recent && recent.n) || 0);

  const accepted = [];
  const rejected = [];
  for (const raw of jobs) {
    const row = cleanJob(raw, now);
    if (!row) { rejected.push(raw && raw.id); continue; }
    const existing = await env.DB.prepare('SELECT device FROM jobs WHERE id = ?1').bind(row.id).first();
    if (existing && existing.device !== device) { rejected.push(row.id); continue; }
    if (!existing) {
      if (budget <= 0) { rejected.push(row.id); continue; }
      budget--;
    }
    await env.DB.prepare(UPSERT).bind(
      row.id, device, ipHash, now, row.ts, row.ride, row.band, row.zone, row.decision, row.km, row.trip_min,
      row.drive_min, row.fare, row.payment, row.pickup_lat, row.pickup_lng, row.drop_lat, row.drop_lng, row.pricing, row.card_km,
    ).run();
    accepted.push(row.id);
  }
  return json({ accepted, rejected });
}

// A phone can delete only its own jobs. The row stays as an empty tombstone with a new rev, so
// other phones see the deletion on their next pull and drop their copy.
const TOMBSTONE = `UPDATE jobs SET deleted = 1, updated_at = ?3, rev = (SELECT COALESCE(MAX(rev), 0) + 1 FROM jobs),
    band = NULL, zone = NULL, decision = NULL, km = NULL, trip_min = NULL, drive_min = NULL, fare = NULL, payment = NULL,
    pricing = NULL, card_km = NULL, pickup_lat = NULL, pickup_lng = NULL, drop_lat = NULL, drop_lng = NULL
  WHERE id = ?1 AND device = ?2 AND deleted IS NOT 1`;

async function deleteJobs(request, env) {
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json({ error: 'Upload must be JSON.' }, 400);
  }
  const device = String(body.device || '');
  if (!ID_RE.test(device)) return json({ error: 'Missing device id.' }, 400);
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((id) => ID_RE.test(id)).slice(0, MAX_JOBS_PER_POST);
  await ensureSchema(env.DB);
  const now = Date.now();
  const deleted = [];
  const missing = [];
  for (const id of ids) {
    const row = await env.DB.prepare('SELECT device, deleted FROM jobs WHERE id = ?1').bind(id).first();
    if (!row) { missing.push(id); continue; } // never reached the pool: nothing to remove
    if (row.device !== device) { missing.push(id); continue; }
    if (row.deleted !== 1) await env.DB.prepare(TOMBSTONE).bind(id, device, now).run();
    deleted.push(id);
  }
  return json({ deleted, missing });
}

async function getJobs(url, env) {
  const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(url.searchParams.get('limit')) || MAX_PAGE));
  await ensureSchema(env.DB);
  const { results } = await env.DB.prepare(
    `SELECT rev, id, ts, ride, band, zone, decision, km, trip_min, drive_min, fare, payment,
       pickup_lat, pickup_lng, drop_lat, drop_lng, pricing, card_km, deleted FROM jobs WHERE rev > ?1 ORDER BY rev LIMIT ?2`,
  ).bind(since, limit + 1).all();
  const more = results.length > limit;
  const jobs = results.slice(0, limit).map((r) => {
    if (r.deleted === 1) return { rev: r.rev, id: r.id, deleted: 1 };
    const { deleted, ...rest } = r;
    return rest;
  });
  return json({ jobs, next: jobs.length ? jobs[jobs.length - 1].rev : since, more });
}

// ---------- beta formula dataset ----------
const FORMULA_MAX_PER_POST = 50;
const FORMULA_MAX_NEW_PER_IP_PER_DAY = 200;

export function cleanFormulaTrip(t, now = Date.now()) {
  if (!t || typeof t !== 'object' || !ID_RE.test(String(t.id || ''))) return null;
  const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const ts = n(t.ts);
  const km = n(t.km);
  const min = n(t.min);
  const erp = n(t.erp) ?? 0;
  const paid = n(t.paid);
  const earned = n(t.earned);
  const predicted = n(t.predicted);
  const predictedEarned = n(t.predicted_earned);
  if (!Number.isFinite(ts) || ts < now - 365 * 86400 * 1000 || ts > now + 10 * 60 * 1000) return null;
  if (!(km >= 0.3 && km <= 100) || !(min >= 1 && min <= 240) || !(paid >= 2 && paid <= 400)) return null;
  if (!inRange(erp, 0, 50) || !inRange(earned, 0.5, 400) || !inRange(predicted, 0, 1000) || !inRange(predictedEarned, 0, 1000)) return null;
  if (!['normal', 'surge'].includes(t.surge)) return null;
  return {
    id: String(t.id), ts: Math.round(ts / 60000) * 60000, km: r2(km), min: r2(min), erp: r2(erp), paid: r2(paid),
    earned: r2(earned), surge: t.surge, predicted: r2(predicted), predicted_earned: r2(predictedEarned),
  };
}

const FORMULA_UPSERT = `INSERT INTO formula_trips (id, device, ip_hash, received_at, updated_at, rev, ts, km, min, erp, paid,
    earned, surge, predicted, predicted_earned, deleted)
  VALUES (?1, ?2, ?3, ?4, ?4, (SELECT COALESCE(MAX(rev), 0) + 1 FROM formula_trips), ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0)
  ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, rev = excluded.rev, ts = excluded.ts, km = excluded.km,
    min = excluded.min, erp = excluded.erp, paid = excluded.paid, earned = excluded.earned, surge = excluded.surge,
    predicted = excluded.predicted, predicted_earned = excluded.predicted_earned, deleted = 0
  WHERE formula_trips.device = excluded.device`;

async function readJson(request) {
  const text = await request.text();
  if (text.length > 100 * 1024) return { error: json({ error: 'Too much data in one upload.' }, 413) };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: json({ error: 'Upload must be JSON.' }, 400) };
  }
}

async function postFormula(request, env) {
  const { body, error } = await readJson(request);
  if (error) return error;
  const device = String(body.device || '');
  if (!ID_RE.test(device)) return json({ error: 'Missing device id.' }, 400);
  const trips = Array.isArray(body.trips) ? body.trips.slice(0, FORMULA_MAX_PER_POST) : [];
  if (!trips.length) return json({ accepted: [], rejected: [] });
  await ensureSchema(env.DB);
  const now = Date.now();
  const ipHash = await hashIp(request, env);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM formula_trips WHERE ip_hash = ?1 AND received_at > ?2')
    .bind(ipHash, now - 86400 * 1000).first();
  let budget = FORMULA_MAX_NEW_PER_IP_PER_DAY - Number((recent && recent.n) || 0);
  const accepted = [];
  const rejected = [];
  for (const raw of trips) {
    const t = cleanFormulaTrip(raw, now);
    if (!t) { rejected.push(raw && raw.id); continue; }
    const existing = await env.DB.prepare('SELECT device FROM formula_trips WHERE id = ?1').bind(t.id).first();
    if (existing && existing.device !== device) { rejected.push(t.id); continue; }
    if (!existing) {
      if (budget <= 0) { rejected.push(t.id); continue; }
      budget--;
    }
    await env.DB.prepare(FORMULA_UPSERT).bind(
      t.id, device, ipHash, now, t.ts, t.km, t.min, t.erp, t.paid, t.earned, t.surge, t.predicted, t.predicted_earned,
    ).run();
    accepted.push(t.id);
  }
  return json({ accepted, rejected });
}

async function getFormula(url, env) {
  const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(url.searchParams.get('limit')) || MAX_PAGE));
  await ensureSchema(env.DB);
  const { results } = await env.DB.prepare(
    `SELECT rev, id, ts, km, min, erp, paid, earned, surge, predicted, predicted_earned, deleted
       FROM formula_trips WHERE rev > ?1 ORDER BY rev LIMIT ?2`,
  ).bind(since, limit + 1).all();
  const more = results.length > limit;
  const trips = results.slice(0, limit).map((r) => {
    if (r.deleted === 1) return { rev: r.rev, id: r.id, deleted: 1 };
    const { deleted, ...rest } = r;
    return rest;
  });
  return json({ trips, next: trips.length ? trips[trips.length - 1].rev : since, more });
}

async function deleteFormula(request, env) {
  const { body, error } = await readJson(request);
  if (error) return error;
  const device = String(body.device || '');
  if (!ID_RE.test(device)) return json({ error: 'Missing device id.' }, 400);
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((id) => ID_RE.test(id)).slice(0, FORMULA_MAX_PER_POST);
  await ensureSchema(env.DB);
  const deleted = [];
  const missing = [];
  for (const id of ids) {
    const row = await env.DB.prepare('SELECT device FROM formula_trips WHERE id = ?1').bind(id).first();
    if (!row || row.device !== device) { missing.push(id); continue; }
    await env.DB.prepare(`UPDATE formula_trips SET deleted = 1, updated_at = ?2, rev = (SELECT COALESCE(MAX(rev), 0) + 1 FROM formula_trips),
        km = NULL, min = NULL, erp = NULL, paid = NULL, earned = NULL, surge = NULL, predicted = NULL, predicted_earned = NULL
      WHERE id = ?1`).bind(id, Date.now()).run();
    deleted.push(id);
  }
  return json({ deleted, missing });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }
    const isJobsPost = url.pathname === '/api/jobs' && request.method === 'POST';
    const isDelete = url.pathname === '/api/jobs/delete' && request.method === 'POST';
    const isFormulaWrite = (url.pathname === '/api/formula' || url.pathname === '/api/formula/delete') && request.method === 'POST';
    if (request.method !== 'GET' && !isJobsPost && !isDelete && !isFormulaWrite) return json({ error: 'Method not allowed' }, 405);

    if (url.pathname === '/api/status') {
      return json({
        ok: true, map: Boolean(env.ONEMAP_EMAIL && env.ONEMAP_PASSWORD), pool: Boolean(env.DB),
        keyRequired: Boolean(env.APP_KEY), authorized: authorized(request, env),
      });
    }
    if (!authorized(request, env)) return json({ error: 'Access key missing or wrong. Set it in Fareit under Settings.' }, 401);

    if (url.pathname === '/api/formula' || url.pathname === '/api/formula/delete') {
      if (!env.DB) return json({ error: 'The database isn’t set up on the server yet.' }, 503);
      try {
        if (url.pathname === '/api/formula/delete') return await deleteFormula(request, env);
        return request.method === 'POST' ? await postFormula(request, env) : await getFormula(url, env);
      } catch {
        return json({ error: 'The database couldn’t be reached.' }, 502);
      }
    }
    if (isDelete) {
      if (!env.DB) return json({ error: 'The shared pool isn’t set up on the server yet.' }, 503);
      try {
        return await deleteJobs(request, env);
      } catch {
        return json({ error: 'The shared pool couldn’t be reached.' }, 502);
      }
    }
    if (url.pathname === '/api/jobs') {
      if (!env.DB) return json({ error: 'The shared pool isn’t set up on the server yet.' }, 503);
      try {
        return isJobsPost ? await postJobs(request, env) : await getJobs(url, env);
      } catch {
        return json({ error: 'The shared pool couldn’t be reached.' }, 502);
      }
    }

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
      if (url.pathname === '/api/near') {
        const at = parsePoint(url.searchParams.get('at'));
        if (!at) return json({ error: 'at must be a lat,lng point in Singapore.' }, 400);
        return await near(at, env);
      }
    } catch {
      return json({ error: 'OneMap couldn’t be reached.' }, 502);
    }
    return json({ error: 'Not found' }, 404);
  },
};
