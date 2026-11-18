// Fareit Worker: serves the PWA from ./public, proxies OneMap (Singapore Land Authority), and
// keeps the shared training pool that every phone contributes to and learns from.
//
//   GET  /api/status                         -> { map, pool, keyRequired, authorized }
//   GET  /api/search?q=...                   -> { results: [{ label, address, postal, lat, lng }] }
//   GET  /api/route?from=lat,lng&to=lat,lng  -> { km, min, source: "onemap" }
//   GET  /api/near?at=lat,lng                -> { label, address, postal, lat, lng } nearest address
//   GET  /api/area?at=lat,lng                -> { area } planning area (e.g. "Tampines")
//   POST /api/jobs   { device, jobs: [...] } -> { accepted, rejected }   add/update anonymous jobs
//   GET  /api/jobs?since=REV&limit=N         -> { jobs, next, more }     page through the pool
//   POST /api/jobs/delete { device, ids }    -> { deleted, missing }     remove your own jobs
//   POST /api/formula { device, trips }      -> { accepted, rejected }   beta formula dataset
//   GET  /api/formula?since=REV              -> { trips, next, more }    (separate from the pool)
//   POST /api/formula/delete { device, ids } -> { deleted, missing }
//   POST /api/queue { device, readings }     -> { accepted, rejected }   airport queue readings
//   GET  /api/queue?since=REV                -> { readings, next, more }
//   POST /api/queue/delete { device, ids }   -> { deleted, missing }
//
// Invite-only access (when the INVITE_ONLY variable is "1"): every /api call except the ones
// below needs a phone's access key in x-agaration-key. A phone gets one by redeeming a one-time
// invite link, or, for the owner, with the owner code. No names or contact details anywhere.
//   POST /api/access/open { token }           -> { expires_at }   starts the invite's 60-minute window
//   POST /api/access/redeem { token, device } -> { key, kind }   within 60 min of first opening; one phone at a time
//   POST /api/owner/claim { code, device }    -> { key, kind }   10 tries an hour per connection
//   GET  /api/access                          -> { ok, kind }    is this phone's key still good
//   GET  /api/manifest?invite=TOKEN           -> manifest whose start_url carries the invite
//   GET  /api/flights                         -> Changi arrivals per terminal (Radar at the airport)
//   GET  /api/events                          -> { venues, events }   events the owner has added
//   POST /api/events { name, venue, starts_at, ends_at } -> { venues, events }   owner only
//   POST /api/events/delete { id }            -> { venues, events }   owner only
//   GET  /api/info                            -> taxis at Changi (data.gov.sg); with LTA_KEY, LTA DataMall:
//                                                road incidents, expressway travel times, MRT disruptions, flood alerts
//   GET  /api/surge                           -> { points }  surge-tagged trips, last 30 min (about 1 km)
//   POST /api/invites/create { label }        -> { token }       owner only
//   GET  /api/invites                         -> { invites }     owner only
//   POST /api/invites/revoke { token }        -> { revoked }     owner only: the invite and its phone
//   POST /api/invites/purge { token }         -> { removed }     owner only: delete everything that phone sent
//   POST /api/access/purge-mine               -> { removed }     a tester removes everything they sent (keeps access)
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

import { inAirportZone } from '../public/airport-zone.js';
import { plausible } from '../public/sanity.js';

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
// The planning area a point is in (OneMap), e.g. "Tampines", "Downtown Core". Falls back to the
// nearest road name if the planning area lookup isn't available.
const titleCase = (s) => String(s).toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
async function area(at, env) {
  let token;
  try {
    token = await getToken(env);
  } catch {
    return json({ error: 'Signing in to OneMap failed.' }, 503);
  }
  if (!token) return json({ error: 'OneMap isn’t set up on the server yet.' }, 503);
  const cacheHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=86400' };
  try {
    const url = new URL(`${OM}/api/public/popapi/getPlanningarea`);
    url.searchParams.set('latitude', String(at.lat));
    url.searchParams.set('longitude', String(at.lng));
    const res = await fetch(url, { headers: { Authorization: token } });
    if (res.ok) {
      const data = await res.json();
      const name = (Array.isArray(data) ? data : [data]).map((d) => d && (d.pln_area_n || d.planning_area)).find(Boolean);
      if (name) return new Response(JSON.stringify({ area: titleCase(name), source: 'planning-area' }), { headers: cacheHeaders });
    }
  } catch { /* fall back to the road */ }
  const r = await near(at, env);
  if (!r.ok) return r;
  const n = await r.json();
  const road = String(n.address || n.label || '').replace(/^\d+\w?\s+/, '').replace(/\s+\d{6}$/, '');
  return new Response(JSON.stringify({ area: road ? titleCase(road) : null, source: 'road' }), { headers: cacheHeaders });
}

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
    deleted INTEGER,
    card_min REAL, pickup_km REAL,
    lat REAL, lng REAL
  )`,
  'CREATE INDEX IF NOT EXISTS formula_rev ON formula_trips(rev)',
  // Airport queue readings (beta): cars ahead and Grab's estimated wait when a driver joins the
  // queue, and the actual wait once they get a job. Numbers and time only.
  `CREATE TABLE IF NOT EXISTS airport_queue (
    id TEXT PRIMARY KEY,
    device TEXT NOT NULL,
    ip_hash TEXT,
    received_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    rev INTEGER NOT NULL,
    ts INTEGER,
    cars_ahead INTEGER, est_wait_min REAL, actual_wait_min REAL,
    deleted INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS queue_rev ON airport_queue(rev)',
  // Invite-only access. An invite is a one-time token; redeeming it gives one phone a key (only
  // its hash is stored). label is the owner's own note (e.g. "brother"), optional.
  `CREATE TABLE IF NOT EXISTS invites (
    token TEXT PRIMARY KEY, label TEXT, created_at INTEGER NOT NULL,
    used_at INTEGER, used_device TEXT, revoked INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS access_keys (
    key_hash TEXT PRIMARY KEY, device TEXT, kind TEXT NOT NULL, invite TEXT,
    created_at INTEGER NOT NULL, revoked INTEGER DEFAULT 0
  )`,
  'CREATE TABLE IF NOT EXISTS owner_attempts (ip_hash TEXT, at INTEGER)',
  // Which invite each sending phone came in on (by the device id its trips carry), so anything
  // odd in the data can be traced to a tester's code name. Only the owner ever sees this.
  'CREATE TABLE IF NOT EXISTS phones (device TEXT PRIMARY KEY, who TEXT NOT NULL, last_at INTEGER)',
  // Shared copies of outside data (e.g. the arrivals list), so every phone shares one fetch.
  'CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, at INTEGER NOT NULL, value TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, venue TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
    starts_at INTEGER, ends_at INTEGER NOT NULL, created_at INTEGER NOT NULL, deleted INTEGER DEFAULT 0
  )`,
];
let schemaReady = null;
// Pools created before a column existed get it added; on newer ones it's already there.
const addColumn = (db, def, table = 'jobs') => Promise.resolve().then(() => db.prepare(`ALTER TABLE ${table} ADD COLUMN ${def}`).run()).catch(() => {});
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.batch(SCHEMA.map((s) => db.prepare(s)))
      .then(() => addColumn(db, 'pricing TEXT'))
      .then(() => addColumn(db, 'card_km REAL'))
      .then(() => addColumn(db, 'deleted INTEGER'))
      .then(() => addColumn(db, 'card_min REAL', 'formula_trips'))
      .then(() => addColumn(db, 'pickup_km REAL', 'formula_trips'))
      .then(() => addColumn(db, 'lat REAL', 'formula_trips'))
      .then(() => addColumn(db, 'lng REAL', 'formula_trips'))
      .then(() => addColumn(db, 'rain INTEGER', 'formula_trips'))
      .then(() => addColumn(db, 'animal TEXT', 'invites'))
      .then(() => addColumn(db, 'opened_at INTEGER', 'invites'))
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

// ---------- batched writes ----------
// Who owns each id, in one query for the whole upload instead of one per row.
async function owners(db, table, ids) {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const marks = unique.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await db.prepare(`SELECT id, device, deleted FROM ${table} WHERE id IN (${marks})`).bind(...unique).all();
  return new Map(results.map((r) => [r.id, r]));
}
// All of an upload's writes in one round trip, as one transaction: all saved or none (phones
// retry the whole upload, and writes overwrite, so a retry never duplicates).
async function writeAll(db, statements) {
  if (statements.length) await db.batch(statements);
}

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
  const rows = jobs.map((raw) => ({ raw, row: cleanJob(raw, now) }));
  const known = await owners(env.DB, 'jobs', rows.filter((x) => x.row).map((x) => x.row.id));
  const writes = [];
  for (const { raw, row } of rows) {
    if (!row) { rejected.push(raw && raw.id); continue; }
    const existing = known.get(row.id);
    if (existing && existing.device !== device) { rejected.push(row.id); continue; }
    if (!existing) {
      if (budget <= 0) { rejected.push(row.id); continue; }
      budget--;
      known.set(row.id, { device }); // a repeat of the same id later in this upload is an edit
    }
    writes.push(env.DB.prepare(UPSERT).bind(
      row.id, device, ipHash, now, row.ts, row.ride, row.band, row.zone, row.decision, row.km, row.trip_min,
      row.drive_min, row.fare, row.payment, row.pickup_lat, row.pickup_lng, row.drop_lat, row.drop_lng, row.pricing, row.card_km,
    ));
    accepted.push(row.id);
  }
  await writeAll(env.DB, writes);
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
  const known = await owners(env.DB, 'jobs', ids);
  const writes = [];
  for (const id of new Set(ids)) {
    const row = known.get(id);
    if (!row) { missing.push(id); continue; } // never reached the pool: nothing to remove
    if (row.device !== device) { missing.push(id); continue; }
    if (row.deleted !== 1) writes.push(env.DB.prepare(TOMBSTONE).bind(id, device, now));
    deleted.push(id);
  }
  await writeAll(env.DB, writes);
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
  const cardMin = n(t.card_min);
  const pickupKm = n(t.pickup_km);
  const where = cleanPoint(n(t.lat), n(t.lng)); // inside Singapore, about 1 km
  if (!where) return null;
  if (!Number.isFinite(ts) || ts < now - 365 * 86400 * 1000 || ts > now + 10 * 60 * 1000) return null;
  // min is the trip time from the pickup (optional); card_min is the job card's total, which also
  // includes the drive to the pickup.
  // paid may be missing on a quick Got a job entry (km and earnings only), but not both.
  if (!(km >= 0.3 && km <= 100) || !inRange(min, 1, 240) || !inRange(paid, 2, 400)) return null;
  if (paid === null && earned === null) return null;
  if (!inRange(cardMin, 1, 300) || !inRange(pickupKm, 0, 50)) return null;
  if (!inRange(erp, 0, 50) || !inRange(earned, 0.5, 400) || !inRange(predicted, 0, 1000) || !inRange(predictedEarned, 0, 1000)) return null;
  if (!['normal', 'surge', 'airport'].includes(t.surge)) return null;
  // Safeguard: what no real trip looks like (e.g. 10 km at S$99) is refused (public/sanity.js).
  if (!plausible({ km, min, paid, earned, erp }).ok) return null;
  // rain: 1 if it was raining (or forecast rain) near the pickup when saved, 0 if dry, null if unknown.
  const rain = t.rain === 1 || t.rain === true ? 1 : t.rain === 0 || t.rain === false ? 0 : null;
  return {
    id: String(t.id), ts: Math.round(ts / 60000) * 60000, km: r2(km), min: r2(min), erp: r2(erp), paid: r2(paid),
    earned: r2(earned), surge: t.surge, predicted: r2(predicted), predicted_earned: r2(predictedEarned),
    card_min: r2(cardMin), pickup_km: r2(pickupKm), lat: where[0], lng: where[1], rain,
  };
}

const FORMULA_UPSERT = `INSERT INTO formula_trips (id, device, ip_hash, received_at, updated_at, rev, ts, km, min, erp, paid,
    earned, surge, predicted, predicted_earned, deleted, card_min, pickup_km, lat, lng, rain)
  VALUES (?1, ?2, ?3, ?4, ?4, (SELECT COALESCE(MAX(rev), 0) + 1 FROM formula_trips), ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14, ?15, ?16, ?17, ?18)
  ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, rev = excluded.rev, ts = excluded.ts, km = excluded.km,
    min = excluded.min, erp = excluded.erp, paid = excluded.paid, earned = excluded.earned, surge = excluded.surge,
    predicted = excluded.predicted, predicted_earned = excluded.predicted_earned, deleted = 0,
    card_min = excluded.card_min, pickup_km = excluded.pickup_km, lat = excluded.lat, lng = excluded.lng, rain = excluded.rain
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
  const cleaned = trips.map((raw) => ({ raw, t: cleanFormulaTrip(raw, now) }));
  const known = await owners(env.DB, 'formula_trips', cleaned.filter((x) => x.t).map((x) => x.t.id));
  const writes = [];
  for (const { raw, t } of cleaned) {
    if (!t) { rejected.push(raw && raw.id); continue; }
    const existing = known.get(t.id);
    if (existing && existing.device !== device) { rejected.push(t.id); continue; }
    if (!existing) {
      if (budget <= 0) { rejected.push(t.id); continue; }
      budget--;
      known.set(t.id, { device });
    }
    writes.push(env.DB.prepare(FORMULA_UPSERT).bind(
      t.id, device, ipHash, now, t.ts, t.km, t.min, t.erp, t.paid, t.earned, t.surge, t.predicted, t.predicted_earned,
      t.card_min, t.pickup_km, t.lat, t.lng, t.rain,
    ));
    accepted.push(t.id);
  }
  await writeAll(env.DB, writes);
  return json({ accepted, rejected });
}

export const TRUST_MIN_CHECKED = 10;
export const TRUST_MAX_FAR_OFF = 0.1;
async function getFormula(url, env) {
  const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(url.searchParams.get('limit')) || MAX_PAGE));
  await ensureSchema(env.DB);
  const { results } = await env.DB.prepare(
    `SELECT rev, id, ts, km, min, erp, paid, earned, surge, predicted, predicted_earned, card_min, pickup_km, lat, lng, rain, deleted, device
       FROM formula_trips WHERE rev > ?1 ORDER BY rev LIMIT ?2`,
  ).bind(since, limit + 1).all();
  const more = results.length > limit;
  // d: an opaque tag per phone, so one phone's trips can be capped together; never the device id.
  // tr: the phone has earned trust (TRUST_MIN_CHECKED+ fares checked, under TRUST_MAX_FAR_OFF far
  // off the estimate), so its trips may count more in an area (e.g. a driver on a shift).
  const devices = [...new Set(results.filter((r) => r.deleted !== 1).map((r) => r.device))];
  const trusted = new Set();
  for (let i = 0; i < devices.length; i += 50) {
    const chunk = devices.slice(i, i + 50);
    const { results: rel } = await env.DB.prepare(`SELECT device, COUNT(*) AS checked,
        SUM(CASE WHEN ABS(paid / predicted - 1) > 0.4 THEN 1 ELSE 0 END) AS far
      FROM formula_trips WHERE deleted IS NOT 1 AND predicted > 0 AND paid > 0
        AND device IN (${chunk.map((_, j) => `?${j + 1}`).join(',')}) GROUP BY device`).bind(...chunk).all();
    for (const r of rel) if (r.checked >= TRUST_MIN_CHECKED && r.far / r.checked < TRUST_MAX_FAR_OFF) trusted.add(r.device);
  }
  const tags = new Map();
  const tag = async (dev) => { if (!tags.has(dev)) tags.set(dev, (await sha256(`trip:${env.HASH_SALT || ''}:${dev}`)).slice(0, 10)); return tags.get(dev); };
  const trips = [];
  for (const r of results.slice(0, limit)) {
    if (r.deleted === 1) { trips.push({ rev: r.rev, id: r.id, deleted: 1 }); continue; }
    const { deleted, device, ...rest } = r;
    trips.push({ ...rest, d: await tag(device), ...(trusted.has(device) ? { tr: 1 } : {}) });
  }
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
  const known = await owners(env.DB, 'formula_trips', ids);
  const writes = [];
  for (const id of new Set(ids)) {
    const row = known.get(id);
    if (!row || row.device !== device) { missing.push(id); continue; }
    writes.push(env.DB.prepare(`UPDATE formula_trips SET deleted = 1, updated_at = ?2, rev = (SELECT COALESCE(MAX(rev), 0) + 1 FROM formula_trips),
        km = NULL, min = NULL, erp = NULL, paid = NULL, earned = NULL, surge = NULL, predicted = NULL, predicted_earned = NULL,
        card_min = NULL, pickup_km = NULL, lat = NULL, lng = NULL
      WHERE id = ?1`).bind(id, Date.now()));
    deleted.push(id);
  }
  await writeAll(env.DB, writes);
  return json({ deleted, missing });
}

// ---------- beta airport queue ----------
export function cleanQueueReading(q, now = Date.now()) {
  if (!q || typeof q !== 'object' || !ID_RE.test(String(q.id || ''))) return null;
  const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const ts = n(q.ts);
  const cars = n(q.cars_ahead);
  const est = n(q.est_wait_min);
  const actual = n(q.actual_wait_min);
  if (!Number.isFinite(ts) || ts < now - 365 * 86400 * 1000 || ts > now + 10 * 60 * 1000) return null;
  if (cars === null && est === null) return null;
  if (!inRange(cars, 0, 1000) || !inRange(est, 0, 720) || !inRange(actual, 0, 1440)) return null;
  return {
    id: String(q.id), ts: Math.round(ts / 60000) * 60000,
    cars_ahead: cars === null ? null : Math.round(cars), est_wait_min: r2(est), actual_wait_min: r2(actual),
  };
}

const QUEUE_UPSERT = `INSERT INTO airport_queue (id, device, ip_hash, received_at, updated_at, rev, ts, cars_ahead,
    est_wait_min, actual_wait_min, deleted)
  VALUES (?1, ?2, ?3, ?4, ?4, (SELECT COALESCE(MAX(rev), 0) + 1 FROM airport_queue), ?5, ?6, ?7, ?8, 0)
  ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, rev = excluded.rev, ts = excluded.ts,
    cars_ahead = excluded.cars_ahead, est_wait_min = excluded.est_wait_min, actual_wait_min = excluded.actual_wait_min,
    deleted = 0
  WHERE airport_queue.device = excluded.device`;

async function postQueue(request, env) {
  const { body, error } = await readJson(request);
  if (error) return error;
  const device = String(body.device || '');
  if (!ID_RE.test(device)) return json({ error: 'Missing device id.' }, 400);
  const readings = Array.isArray(body.readings) ? body.readings.slice(0, FORMULA_MAX_PER_POST) : [];
  if (!readings.length) return json({ accepted: [], rejected: [] });
  await ensureSchema(env.DB);
  const now = Date.now();
  const ipHash = await hashIp(request, env);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM airport_queue WHERE ip_hash = ?1 AND received_at > ?2')
    .bind(ipHash, now - 86400 * 1000).first();
  let budget = FORMULA_MAX_NEW_PER_IP_PER_DAY - Number((recent && recent.n) || 0);
  const accepted = [];
  const rejected = [];
  const cleaned = readings.map((raw) => ({ raw, q: cleanQueueReading(raw, now) }));
  const known = await owners(env.DB, 'airport_queue', cleaned.filter((x) => x.q).map((x) => x.q.id));
  const writes = [];
  for (const { raw, q } of cleaned) {
    if (!q) { rejected.push(raw && raw.id); continue; }
    const existing = known.get(q.id);
    if (existing && existing.device !== device) { rejected.push(q.id); continue; }
    if (!existing) {
      if (budget <= 0) { rejected.push(q.id); continue; }
      budget--;
      known.set(q.id, { device });
    }
    writes.push(env.DB.prepare(QUEUE_UPSERT).bind(q.id, device, ipHash, now, q.ts, q.cars_ahead, q.est_wait_min, q.actual_wait_min));
    accepted.push(q.id);
  }
  await writeAll(env.DB, writes);
  return json({ accepted, rejected });
}

async function getQueue(url, env) {
  const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(url.searchParams.get('limit')) || MAX_PAGE));
  await ensureSchema(env.DB);
  const { results } = await env.DB.prepare(
    `SELECT rev, id, ts, cars_ahead, est_wait_min, actual_wait_min, deleted
       FROM airport_queue WHERE rev > ?1 ORDER BY rev LIMIT ?2`,
  ).bind(since, limit + 1).all();
  const more = results.length > limit;
  const readings = results.slice(0, limit).map((r) => {
    if (r.deleted === 1) return { rev: r.rev, id: r.id, deleted: 1 };
    const { deleted, ...rest } = r;
    return rest;
  });
  return json({ readings, next: readings.length ? readings[readings.length - 1].rev : since, more });
}

async function deleteQueue(request, env) {
  const { body, error } = await readJson(request);
  if (error) return error;
  const device = String(body.device || '');
  if (!ID_RE.test(device)) return json({ error: 'Missing device id.' }, 400);
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((id) => ID_RE.test(id)).slice(0, FORMULA_MAX_PER_POST);
  await ensureSchema(env.DB);
  const deleted = [];
  const missing = [];
  const known = await owners(env.DB, 'airport_queue', ids);
  const writes = [];
  for (const id of new Set(ids)) {
    const row = known.get(id);
    if (!row || row.device !== device) { missing.push(id); continue; }
    writes.push(env.DB.prepare(`UPDATE airport_queue SET deleted = 1, updated_at = ?2, rev = (SELECT COALESCE(MAX(rev), 0) + 1 FROM airport_queue),
        cars_ahead = NULL, est_wait_min = NULL, actual_wait_min = NULL WHERE id = ?1`).bind(id, Date.now()));
    deleted.push(id);
  }
  await writeAll(env.DB, writes);
  return json({ deleted, missing });
}

// ---------- Events ----------
// Venues where crowds come out at once. Points are approximate (the event rule uses 1.5 km).
export const VENUES = [
  ['national-stadium', 'National Stadium', 1.3040, 103.8746],
  ['indoor-stadium', 'Singapore Indoor Stadium', 1.3007, 103.8746],
  ['star-theatre', 'The Star Theatre (Buona Vista)', 1.3071, 103.7883],
  ['esplanade', 'Esplanade', 1.2898, 103.8555],
  ['mbs', 'Marina Bay Sands (Expo, Arena)', 1.2826, 103.8590],
  ['bayfront', 'Bayfront Event Space / Floating Platform', 1.2888, 103.8592],
  ['f1', 'Marina Bay Street Circuit (F1)', 1.2914, 103.8640],
  ['gardens', 'Gardens by the Bay', 1.2816, 103.8636],
  ['padang', 'The Padang', 1.2925, 103.8521],
  ['capitol', 'Capitol Theatre', 1.2932, 103.8514],
  ['fort-canning', 'Fort Canning Park', 1.2946, 103.8457],
  ['suntec', 'Suntec Convention Centre', 1.2936, 103.8573],
  ['expo', 'Singapore Expo', 1.3352, 103.9584],
  ['changi-exhibition', 'Changi Exhibition Centre', 1.3346, 104.0157],
  ['rws', 'Resorts World Sentosa', 1.2540, 103.8238],
  ['siloso', 'Siloso Beach, Sentosa', 1.2550, 103.8130],
].map(([id, name, lat, lng]) => ({ id, name, lat, lng }));

async function eventsOut(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, venue, lat, lng, starts_at, ends_at FROM events
     WHERE deleted IS NOT 1 AND ends_at > ?1 ORDER BY ends_at LIMIT 500`,
  ).bind(Date.now() - 180 * 86400000).all();
  const names = Object.fromEntries(VENUES.map((v) => [v.id, v.name]));
  return json({ venues: VENUES, events: results.map((e) => ({ ...e, venue_name: names[e.venue] || e.venue })) });
}

async function addEvent(request, env) {
  const { body, error } = await readJson(request);
  if (error) return error;
  const name = String(body.name || '').trim().slice(0, 60);
  const venue = VENUES.find((v) => v.id === body.venue);
  const ends = Number(body.ends_at);
  const starts = body.starts_at == null ? null : Number(body.starts_at);
  const now = Date.now();
  if (!name || !venue) return json({ error: 'Add what it is and pick a venue.' }, 400);
  if (!Number.isFinite(ends) || ends < now - 2 * 86400000 || ends > now + 400 * 86400000) return json({ error: 'That end time doesn’t look right.' }, 400);
  if (starts !== null && (!Number.isFinite(starts) || starts > ends || ends - starts > 3 * 86400000)) return json({ error: 'The start should be before the end.' }, 400);
  const id = `ev-${randomKey().slice(0, 16)}`;
  await env.DB.prepare('INSERT INTO events (id, name, venue, lat, lng, starts_at, ends_at, created_at, deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)')
    .bind(id, name, venue.id, venue.lat, venue.lng, starts, ends, now).run();
  return eventsOut(env);
}

async function removeEvent(request, env) {
  const { body, error } = await readJson(request);
  if (error) return error;
  await env.DB.prepare('UPDATE events SET deleted = 1 WHERE id = ?1').bind(String(body.id || '')).run();
  return eventsOut(env);
}

// ---------- Live info (data.gov.sg, free, no key) ----------
// Available street taxis around Changi, fetched at most every 2 minutes
// and shared by every phone.
// Same airport zone as the app (inside the airport boundary, near a terminal).
export function changiTaxis(coords) {
  return coords.filter(([lng, lat]) => inAirportZone(lat, lng)).length;
}

// ---------- LTA DataMall (needs the LTA_KEY secret) ----------
// Per the DataMall API User Guide v6.11: key in the AccountKey header, JSON { value: [...] },
// 500 records per call ($skip for more).
const LTA = 'https://datamall2.mytransport.sg/ltaodataservice';
async function ltaGet(env, path, pages = 1) {
  const out = [];
  for (let p = 0; p < pages; p++) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${LTA}/${path}${p ? `${sep}$skip=${p * 500}` : ''}`, { headers: { AccountKey: env.LTA_KEY, accept: 'application/json' } });
    if (!res.ok) throw new Error(`LTA ${path} ${res.status}`);
    const body = await res.json();
    const v = body.value;
    if (!Array.isArray(v)) return v ?? body; // Train Service Alerts returns one object
    out.push(...v);
    if (v.length < 500) break;
  }
  return out;
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

export function cleanIncidents(rows) {
  return (rows || []).map((r) => ({ type: String(r.Type || ''), lat: num(r.Latitude), lng: num(r.Longitude), msg: String(r.Message || '').trim() }))
    .filter((r) => r.msg).slice(0, 300);
}
// One line per expressway and direction: total minutes to its far end, plus the slowest stretch.
export function cleanTravel(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const k = `${r.Name}|${r.Direction}`;
    const t = num(r.EstTime);
    if (t === null) continue;
    const e = by.get(k) || { name: String(r.Name), dir: num(r.Direction), to: String(r.FarEndPoint || ''), min: 0, slow: null };
    e.min += t;
    if (!e.slow || t > e.slow.min) e.slow = { from: String(r.StartPoint || ''), to: String(r.EndPoint || ''), min: t };
    by.set(k, e);
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name) || a.dir - b.dir);
}
// Disruptions only (Status 2, or any affected stretch), with LTA's message.
export function cleanTrain(v) {
  const o = Array.isArray(v) ? v[0] : v;
  if (!o) return { disrupted: false, lines: [], messages: [] };
  const segs = o.AffectedSegments || [];
  const msgs = (o.Message || []).map((m) => String(m.Content || '').trim()).filter(Boolean);
  const lines = segs.map((s) => ({ line: String(s.Line || ''), direction: String(s.Direction || ''), stations: String(s.Stations || ''), freeBus: String(s.FreePublicBus || '') }));
  return { disrupted: Number(o.Status) === 2 || lines.length > 0, major: Number(o.Status) === 2, lines, messages: msgs };
}
export function cleanFloods(rows, now = Date.now()) {
  return (rows || []).filter((r) => String(r.msgType || '').toLowerCase() === 'alert' && (!r.expires || Date.parse(r.expires) > now))
    .map((r) => {
      const [ll, km] = String(r.circle || '').trim().split(/\s+/);
      const [lat, lng] = String(ll || '').split(',').map(Number);
      return { headline: String(r.headline || 'Flood alert'), desc: String(r.description || ''), advice: String(r.instruction || ''),
        area: String(r.areaDesc || ''), lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null,
        severity: String(r.severity || ''), at: Date.parse(r.dateTime) || null };
    });
}
async function fetchLta(env) {
  const [inc, travel, train, flood] = await Promise.allSettled([
    ltaGet(env, 'TrafficIncidents'), ltaGet(env, 'EstTravelTimes', 3), ltaGet(env, 'TrainServiceAlerts'), ltaGet(env, 'PubFloodAlerts'),
  ]);
  const at = Date.now();
  const out = { at };
  if (inc.status === 'fulfilled') out.incidents = cleanIncidents(inc.value);
  if (travel.status === 'fulfilled') out.travel = cleanTravel(travel.value);
  if (train.status === 'fulfilled') out.train = cleanTrain(train.value);
  if (flood.status === 'fulfilled') out.floods = cleanFloods(flood.value);
  const failed = [inc, travel, train, flood].filter((x) => x.status === 'rejected').map((x) => String(x.reason?.message || x.reason));
  if (failed.length) out.errors = failed;
  return out;
}

async function fetchLive(env = {}) {
  const get = async (path) => {
    const res = await fetch(`https://api.data.gov.sg/v1/transport/${path}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`data.gov.sg ${res.status}`);
    return res.json();
  };
  const out = {};
  const [taxis] = await Promise.allSettled([get('taxi-availability')]);
  if (taxis.status === 'fulfilled') {
    const f = taxis.value.features?.[0];
    const coords = f?.geometry?.coordinates || [];
    out.taxis = { changi: changiTaxis(coords), total: coords.length, at: Date.parse(f?.properties?.timestamp) || Date.now() };
  }
  if (env.LTA_KEY) {
    try { out.lta = await fetchLta(env); } catch { /* keep the last copy */ }
  }
  return out;
}

async function getInfo(env) {
  await ensureSchema(env.DB);
  const now = Date.now();
  const row = await env.DB.prepare("SELECT at, value FROM cache WHERE key = 'info'").first();
  let live = row ? JSON.parse(row.value) : null;
  if (!row || now - row.at >= 2 * 60000) {
    try {
      const fresh = await fetchLive(env);
      live = { ...(live || {}), ...fresh };
      await env.DB.prepare(`INSERT INTO cache (key, at, value) VALUES ('info', ?1, ?2)
        ON CONFLICT(key) DO UPDATE SET at = excluded.at, value = excluded.value`).bind(now, JSON.stringify(live)).run();
    } catch { /* keep the last copy */ }
  }
  const lta = live && live.lta ? live.lta : {};
  return json({ ...(live || {}), lta: { ...lta, ready: Boolean(env.LTA_KEY) } });
}

// ---------- Rain (NEA via data.gov.sg, free, no key) ----------
// Rain gauges (about 60-90 stations, 5-minute totals in mm) and the 2-hour forecast per town
// (47 areas). Fetched at most every RAIN_REFRESH_MIN minutes and shared by every phone.
const RAIN_REFRESH_MIN = 5;
const NEA = 'https://api-open.data.gov.sg/v2/real-time/api';
// Pure, for the tests: the two NEA answers -> what the phones need.
export function cleanRain(rainfall, forecast, now = Date.now()) {
  const out = { at: now, wet: [], stations: 0, areas: [], valid: null, readAt: null };
  const rd = rainfall && rainfall.data;
  if (rd && Array.isArray(rd.stations) && Array.isArray(rd.readings) && rd.readings.length) {
    const where = new Map(rd.stations.map((s) => [s.id, s.location || {}]));
    const latest = rd.readings[rd.readings.length - 1];
    out.readAt = Date.parse(latest.timestamp) || null;
    for (const r of latest.data || []) {
      const loc = where.get(r.stationId);
      const mm = Number(r.value);
      if (!loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude) || !Number.isFinite(mm)) continue;
      out.stations++;
      if (mm > 0) out.wet.push({ lat: loc.latitude, lng: loc.longitude, mm: Math.round(mm * 10) / 10 });
    }
  }
  const fd = forecast && forecast.data;
  if (fd && Array.isArray(fd.area_metadata) && Array.isArray(fd.items) && fd.items.length) {
    const item = fd.items[fd.items.length - 1];
    const f = new Map((item.forecasts || []).map((x) => [x.area, String(x.forecast || '')]));
    for (const a of fd.area_metadata) {
      const l = a.label_location || {};
      if (!Number.isFinite(l.latitude) || !Number.isFinite(l.longitude) || !f.has(a.name)) continue;
      out.areas.push({ name: String(a.name), lat: l.latitude, lng: l.longitude, f: f.get(a.name) });
    }
    const vp = item.valid_period || {};
    out.valid = { text: String(vp.text || ''), end: Date.parse(vp.end) || null };
  }
  return out;
}

async function getRain(env) {
  await ensureSchema(env.DB);
  const now = Date.now();
  const row = await env.DB.prepare("SELECT at, value FROM cache WHERE key = 'rain'").first();
  let rain = row ? JSON.parse(row.value) : null;
  if (!row || now - row.at >= RAIN_REFRESH_MIN * 60000) {
    const get = async (path) => {
      const res = await fetch(`${NEA}/${path}`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`NEA ${res.status}`);
      return res.json();
    };
    const [gauges, fc] = await Promise.allSettled([get('rainfall'), get('two-hr-forecast')]);
    if (gauges.status === 'fulfilled' || fc.status === 'fulfilled') {
      const fresh = cleanRain(gauges.status === 'fulfilled' ? gauges.value : null, fc.status === 'fulfilled' ? fc.value : null, now);
      // keep the last good half if one of the two failed
      if (gauges.status !== 'fulfilled' && rain) Object.assign(fresh, { wet: rain.wet, stations: rain.stations, readAt: rain.readAt });
      if (fc.status !== 'fulfilled' && rain) Object.assign(fresh, { areas: rain.areas, valid: rain.valid });
      rain = fresh;
      await env.DB.prepare(`INSERT INTO cache (key, at, value) VALUES ('rain', ?1, ?2)
        ON CONFLICT(key) DO UPDATE SET at = excluded.at, value = excluded.value`).bind(now, JSON.stringify(rain)).run();
    }
  }
  return json(rain || { at: null, wet: [], stations: 0, areas: [] });
}

// ---------- Surge reports ----------
// Where drivers have had surge in the last half hour: trips saved as Surge (about 1 km).
// Each point carries an opaque tag per phone (so one phone's trips count once), never the id.
export const SURGE_WINDOW_MS = 30 * 60000;

async function getSurge(env) {
  await ensureSchema(env.DB);
  const since = Date.now() - SURGE_WINDOW_MS;
  const trips = await env.DB.prepare(`SELECT device, ts, lat, lng FROM formula_trips WHERE surge = 'surge' AND deleted IS NOT 1
      AND lat IS NOT NULL AND lng IS NOT NULL AND ts > ?1 ORDER BY ts DESC LIMIT 500`).bind(since).all();
  const tags = new Map();
  const tag = async (d) => { if (!tags.has(d)) tags.set(d, (await sha256(`surge:${d}`)).slice(0, 10)); return tags.get(d); };
  const points = [];
  for (const r of trips.results) points.push({ lat: r.lat, lng: r.lng, ts: r.ts, d: await tag(r.device) });
  return json({ points });
}

// ---------- Changi arrivals ----------
// A flight data service is fetched at most every FLIGHTS_REFRESH_MIN minutes (default 30) for the
// next few hours of arrivals; every phone gets the shared copy. Counts per terminal are worked out
// on each request, so they roll forward between fetches. Flight counts only: no passenger numbers.
// A source is a function (env, fromMs, toMs) -> [{ t: landing ms, terminal: 'T1'..'T4' | null, cancelled }].
// The provider is picked once you've signed up for one (FLIGHTS_PROVIDER + FLIGHTS_KEY secret).
export const FLIGHT_SOURCES = {};
const FLIGHTS_AHEAD_MS = 4 * 3600 * 1000;

export function terminalOf(v) {
  const m = /([1-4])/.exec(String(v ?? ''));
  return m ? `T${m[1]}` : null;
}

// Landed in the last 30 min / landing in the next hour / the hour after, per terminal.
export function summarizeArrivals(list, now) {
  const terminals = {};
  for (const k of ['T1', 'T2', 'T3', 'T4']) terminals[k] = { landed: 0, next: 0, later: 0 };
  let unknown = 0;
  for (const a of list) {
    if (!a || a.cancelled || !Number.isFinite(a.t)) continue;
    const k = terminalOf(a.terminal);
    const dt = a.t - now;
    const slot = dt >= -30 * 60000 && dt < 0 ? 'landed' : dt >= 0 && dt < 3600000 ? 'next' : dt >= 3600000 && dt < 7200000 ? 'later' : null;
    if (!slot) continue;
    if (!k) { unknown++; continue; }
    terminals[k][slot]++;
  }
  return { terminals, unknown };
}

async function getFlights(env) {
  const source = FLIGHT_SOURCES[env.FLIGHTS_PROVIDER || ''];
  if (!source || !env.FLIGHTS_KEY) return json({ ready: false });
  await ensureSchema(env.DB);
  const now = Date.now();
  const refreshMs = Math.max(5, Number(env.FLIGHTS_REFRESH_MIN) || 30) * 60000;
  const row = await env.DB.prepare("SELECT at, value FROM cache WHERE key = 'flights'").first();
  let list = row ? JSON.parse(row.value) : null;
  let at = row ? row.at : 0;
  let stale = false;
  if (!row || now - row.at >= refreshMs) {
    try {
      list = (await source(env, now - 3600000, now + FLIGHTS_AHEAD_MS))
        .map((a) => ({ t: a.t, terminal: terminalOf(a.terminal), cancelled: Boolean(a.cancelled) }));
      at = now;
      await env.DB.prepare(`INSERT INTO cache (key, at, value) VALUES ('flights', ?1, ?2)
        ON CONFLICT(key) DO UPDATE SET at = excluded.at, value = excluded.value`).bind(at, JSON.stringify(list)).run();
    } catch {
      if (!list) return json({ error: 'Couldn’t get flights right now.' }, 502);
      stale = true;
    }
  }
  return json({ ready: true, updated_at: at, stale, ...summarizeArrivals(list, now) });
}

// ---------- invite-only access ----------
const OPEN_PATHS = new Set(['/api/status', '/api/access/open', '/api/access/redeem', '/api/owner/claim', '/api/manifest']);
// An invite link works for this long after it's first opened, then never again.
export const INVITE_WINDOW_MS = 60 * 60 * 1000;
const TOKEN_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L: easy to read out
const TOKEN_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const OWNER_TRIES_PER_HOUR = 10;
// Each invite gets an animal code name, for the owner's reference only (testers never see it).
export const ANIMALS = ['Otter', 'Fox', 'Panda', 'Koala', 'Tiger', 'Falcon', 'Badger', 'Heron', 'Lynx', 'Walrus',
  'Gecko', 'Hippo', 'Moose', 'Owl', 'Pelican', 'Rhino', 'Seal', 'Toucan', 'Wombat', 'Yak', 'Zebra', 'Bison',
  'Camel', 'Dingo', 'Eagle', 'Ferret', 'Gibbon', 'Hornbill', 'Ibis', 'Jaguar', 'Kingfisher', 'Lemur', 'Mongoose',
  'Narwhal', 'Ocelot', 'Pangolin', 'Quokka', 'Raccoon', 'Sloth', 'Tapir', 'Urchin', 'Vulture', 'Weasel', 'Beaver',
  'Cheetah', 'Dolphin', 'Elephant', 'Flamingo', 'Giraffe', 'Hedgehog', 'Iguana', 'Kangaroo', 'Llama', 'Meerkat',
  'Orca', 'Penguin', 'Rabbit', 'Squirrel', 'Turtle', 'Wolf'];
async function pickAnimal(db) {
  const { results } = await db.prepare('SELECT animal FROM invites WHERE animal IS NOT NULL').all();
  const used = new Set(results.map((r) => r.animal));
  const free = ANIMALS.filter((a) => !used.has(a));
  if (free.length) return free[crypto.getRandomValues(new Uint32Array(1))[0] % free.length];
  for (let n = 2; ; n++) { const a = ANIMALS.find((x) => !used.has(`${x} ${n}`)); if (a) return `${a} ${n}`; }
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const s = [...bytes].map((b) => TOKEN_CHARS[b % TOKEN_CHARS.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
const randomKey = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Which phone is calling, from its access key: { kind: 'owner' | 'driver', device } or null.
async function whoIs(request, env) {
  const key = request.headers.get('x-agaration-key') || '';
  if (!/^[0-9a-f]{64}$/.test(key) || !env.DB) return null;
  await ensureSchema(env.DB);
  const row = await env.DB.prepare('SELECT kind, device, invite, revoked FROM access_keys WHERE key_hash = ?1').bind(await sha256(key)).first();
  return row && row.revoked !== 1 ? { kind: row.kind, device: row.device, invite: row.invite } : null;
}

// Note which invite a sending phone came in on (its trips carry this device id).
async function notePhone(request, env, who) {
  try {
    const body = await request.clone().json();
    const device = String((body && body.device) || '');
    if (!ID_RE.test(device)) return;
    await env.DB.prepare(`INSERT INTO phones (device, who, last_at) VALUES (?1, ?2, ?3)
      ON CONFLICT(device) DO UPDATE SET who = excluded.who, last_at = excluded.last_at`)
      .bind(device, who.kind === 'owner' ? 'owner' : who.invite, Date.now()).run();
  } catch { /* tracing is best-effort; never block a save */ }
}

async function issueKey(env, device, kind, invite) {
  const key = randomKey();
  await env.DB.prepare('INSERT INTO access_keys (key_hash, device, kind, invite, created_at, revoked) VALUES (?1, ?2, ?3, ?4, ?5, 0)')
    .bind(await sha256(key), device, kind, invite, Date.now()).run();
  return key;
}

async function redeemInvite(request, env) {
  const { body, error } = await readJson(request);
  if (error) return error;
  const token = String(body.token || '').toUpperCase().trim();
  const device = String(body.device || '');
  if (!TOKEN_RE.test(token) || !ID_RE.test(device)) return json({ error: 'That invite link isn’t valid.' }, 400);
  await ensureSchema(env.DB);
  const inv = await openInvite(env, token);
  if (inv.error) return inv.error;
  // Within the window any phone can use it, but only the latest stays in: each use turns off the
  // phone before (e.g. Safari, once the Home Screen app lets itself in). A shared link kicks the
  // tester off, which they'd notice; after 60 minutes it can't be used at all.
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('UPDATE invites SET used_at = COALESCE(used_at, ?2), used_device = ?3 WHERE token = ?1').bind(token, now, device),
    env.DB.prepare('UPDATE access_keys SET revoked = 1 WHERE invite = ?1').bind(token),
  ]);
  return json({ key: await issueKey(env, device, 'driver', token), kind: 'driver' });
}

// The first time a link is opened starts its 60-minute window. Returns the invite, or { error }.
async function openInvite(env, token) {
  await ensureSchema(env.DB);
  const now = Date.now();
  const inv = await env.DB.prepare('SELECT opened_at, revoked FROM invites WHERE token = ?1').bind(token).first();
  if (!inv || inv.revoked === 1) return { error: json({ error: 'That invite link isn’t valid. Ask for a new one.' }, 404) };
  if (inv.opened_at && now > inv.opened_at + INVITE_WINDOW_MS) {
    return { error: json({ error: 'That invite link has expired (it works for 60 minutes after it’s first opened). Ask for a new one.', expired: true }, 410) };
  }
  if (!inv.opened_at) {
    await env.DB.prepare('UPDATE invites SET opened_at = ?2 WHERE token = ?1 AND opened_at IS NULL').bind(token, now).run();
    inv.opened_at = now;
  }
  return { ...inv, expires_at: inv.opened_at + INVITE_WINDOW_MS };
}

async function startInvite(request, env) {
  const { body, error } = await readJson(request);
  if (error) return error;
  const token = String(body.token || '').toUpperCase().trim();
  if (!TOKEN_RE.test(token)) return json({ error: 'That invite link isn’t valid.' }, 400);
  const inv = await openInvite(env, token);
  return inv.error || json({ expires_at: inv.expires_at });
}

async function claimOwner(request, env) {
  const { body, error } = await readJson(request);
  if (error) return error;
  const device = String(body.device || '');
  if (!ID_RE.test(device)) return json({ error: 'Missing device id.' }, 400);
  await ensureSchema(env.DB);
  const ipHash = await hashIp(request, env);
  const now = Date.now();
  const tries = await env.DB.prepare('SELECT COUNT(*) AS n FROM owner_attempts WHERE ip_hash = ?1 AND at > ?2').bind(ipHash, now - 3600 * 1000).first();
  if (Number((tries && tries.n) || 0) >= OWNER_TRIES_PER_HOUR) return json({ error: 'Too many tries. Wait an hour.' }, 429);
  await env.DB.prepare('INSERT INTO owner_attempts (ip_hash, at) VALUES (?1, ?2)').bind(ipHash, now).run();
  if (String(body.code || '').trim() !== String(env.OWNER_CODE || '804613')) return json({ error: 'That owner code isn’t right.' }, 403);
  return json({ key: await issueKey(env, device, 'owner', null), kind: 'owner' });
}

async function createInvite(request, env) {
  const { body, error } = await readJson(request);
  if (error) return error;
  const label = String(body.label || '').trim().slice(0, 40) || null;
  let token = randomToken();
  for (let i = 0; i < 3 && await env.DB.prepare('SELECT 1 AS x FROM invites WHERE token = ?1').bind(token).first(); i++) token = randomToken();
  const animal = await pickAnimal(env.DB);
  await env.DB.prepare('INSERT INTO invites (token, label, created_at, revoked, animal) VALUES (?1, ?2, ?3, 0, ?4)').bind(token, label, Date.now(), animal).run();
  return json({ token, label, animal });
}

async function listInvites(env) {
  // Invites made before code names existed get one now.
  const { results: unnamed } = await env.DB.prepare('SELECT token FROM invites WHERE animal IS NULL').all();
  for (const r of unnamed) await env.DB.prepare('UPDATE invites SET animal = ?2 WHERE token = ?1').bind(r.token, await pickAnimal(env.DB)).run();
  const count = (table) => `(SELECT COUNT(*) FROM ${table} WHERE deleted IS NOT 1 AND device IN (SELECT device FROM phones WHERE who = invites.token))`;
  const { results } = await env.DB.prepare(
    `SELECT token, label, animal, created_at, opened_at, used_at, revoked,
       ${count('jobs')} AS jobs, ${count('formula_trips')} AS trips, ${count('airport_queue')} AS queue,
       (SELECT COUNT(*) FROM formula_trips WHERE deleted IS NOT 1 AND predicted > 0 AND paid > 0
          AND device IN (SELECT device FROM phones WHERE who = invites.token)) AS checked,
       (SELECT COUNT(*) FROM formula_trips WHERE deleted IS NOT 1 AND predicted > 0 AND paid > 0 AND ABS(paid / predicted - 1) > 0.4
          AND device IN (SELECT device FROM phones WHERE who = invites.token)) AS far_off,
       (SELECT MAX(last_at) FROM phones WHERE who = invites.token) AS last_at
     FROM invites ORDER BY created_at DESC LIMIT 200`,
  ).all();
  return json({ invites: results.map((r) => ({ ...r, revoked: r.revoked === 1, expires_at: r.opened_at ? r.opened_at + INVITE_WINDOW_MS : null })) });
}

// Remove everything an invite's phone(s) sent: trips, jobs and queue readings, as tombstones so
// every other phone drops them on its next sync. One statement per row keeps each rev unique.
const PURGE_MAX = 2000;
async function purgeInvite(request, env) {
  const { body, error } = await readJson(request);
  if (error) return error;
  const token = String(body.token || '').toUpperCase().trim();
  if (!TOKEN_RE.test(token)) return json({ error: 'Not an invite.' }, 400);
  return purgeToken(env, token);
}

async function purgeToken(env, token) {
  const now = Date.now();
  const of = (table) => env.DB.prepare(`SELECT id, device FROM ${table} WHERE deleted IS NOT 1
    AND device IN (SELECT device FROM phones WHERE who = ?1) LIMIT ${PURGE_MAX}`).bind(token).all();
  const [ft, jb, qu] = await Promise.all([of('formula_trips'), of('jobs'), of('airport_queue')]);
  const writes = [
    ...ft.results.map((r) => env.DB.prepare(`UPDATE formula_trips SET deleted = 1, updated_at = ?2, rev = (SELECT COALESCE(MAX(rev), 0) + 1 FROM formula_trips),
        km = NULL, min = NULL, erp = NULL, paid = NULL, earned = NULL, surge = NULL, predicted = NULL, predicted_earned = NULL,
        card_min = NULL, pickup_km = NULL, lat = NULL, lng = NULL WHERE id = ?1`).bind(r.id, now)),
    ...jb.results.map((r) => env.DB.prepare(TOMBSTONE).bind(r.id, r.device, now)),
    ...qu.results.map((r) => env.DB.prepare(`UPDATE airport_queue SET deleted = 1, updated_at = ?2, rev = (SELECT COALESCE(MAX(rev), 0) + 1 FROM airport_queue),
        cars_ahead = NULL, est_wait_min = NULL, actual_wait_min = NULL WHERE id = ?1`).bind(r.id, now)),
  ];
  await writeAll(env.DB, writes);
  return json({ removed: { trips: ft.results.length, jobs: jb.results.length, queue: qu.results.length } });
}

async function revokeInvite(request, env) {
  const { body, error } = await readJson(request);
  if (error) return error;
  const token = String(body.token || '').toUpperCase().trim();
  if (!TOKEN_RE.test(token)) return json({ error: 'Not an invite.' }, 400);
  await env.DB.batch([
    env.DB.prepare('UPDATE invites SET revoked = 1 WHERE token = ?1').bind(token),
    env.DB.prepare('UPDATE access_keys SET revoked = 1 WHERE invite = ?1').bind(token),
  ]);
  return json({ revoked: token });
}

// The Home Screen app opens at start_url, so on an iPhone the invite has to travel in it: the
// Home Screen app keeps its own storage, separate from Safari, and redeems the invite itself.
function inviteManifest(url) {
  const token = String(url.searchParams.get('invite') || '').toUpperCase();
  const start = TOKEN_RE.test(token) ? `/?invite=${token}#window` : '/#window';
  return new Response(JSON.stringify({
    name: 'Agaration', short_name: 'Agaration', start_url: start, scope: '/', display: 'standalone',
    background_color: '#131615', theme_color: '#131615',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  }), { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }
    const isJobsPost = url.pathname === '/api/jobs' && request.method === 'POST';
    const isDelete = url.pathname === '/api/jobs/delete' && request.method === 'POST';
    const isFormulaWrite = ['/api/formula', '/api/formula/delete', '/api/queue', '/api/queue/delete',
      '/api/access/redeem', '/api/access/open', '/api/owner/claim', '/api/events', '/api/events/delete', '/api/invites/purge', '/api/access/purge-mine', '/api/invites/create', '/api/invites/revoke'].includes(url.pathname) && request.method === 'POST';
    if (request.method !== 'GET' && !isJobsPost && !isDelete && !isFormulaWrite) return json({ error: 'Method not allowed' }, 405);

    if (url.pathname === '/api/status') {
      return json({
        ok: true, map: Boolean(env.ONEMAP_EMAIL && env.ONEMAP_PASSWORD), pool: Boolean(env.DB),
        keyRequired: Boolean(env.APP_KEY), authorized: authorized(request, env), inviteOnly: env.INVITE_ONLY === '1',
      });
    }
    if (url.pathname === '/api/manifest') return inviteManifest(url);

    // Invite-only: everything else needs a phone that has been let in.
    let who = null;
    if (env.INVITE_ONLY === '1' && !OPEN_PATHS.has(url.pathname)) {
      if (!env.DB) return json({ error: 'The server isn’t set up yet.' }, 503);
      who = await whoIs(request, env);
      if (!who) return json({ error: 'Agaration is invite-only. Open your invite link to get in.', locked: true }, 401);
      if (request.method === 'POST' && ['/api/jobs', '/api/formula', '/api/queue'].includes(url.pathname)) await notePhone(request, env, who);
    }
    if (url.pathname.startsWith('/api/access/') || url.pathname === '/api/owner/claim' || url.pathname === '/api/access'
      || url.pathname.startsWith('/api/invites')) {
      if (!env.DB) return json({ error: 'The server isn’t set up yet.' }, 503);
      try {
        if (url.pathname === '/api/access/redeem') return await redeemInvite(request, env);
        if (url.pathname === '/api/access/open') return await startInvite(request, env);
        if (url.pathname === '/api/owner/claim') return await claimOwner(request, env);
        if (!who) who = await whoIs(request, env);
        if (url.pathname === '/api/access') return who ? json({ ok: true, kind: who.kind }) : json({ error: 'Not let in.', locked: true }, 401);
        // A tester takes out everything their phone(s) sent; the owner's data stays (use Remove trips per invite).
        if (url.pathname === '/api/access/purge-mine') {
          if (!who || who.kind !== 'driver' || !who.invite) return json({ error: 'Only testers can remove their trips here.' }, 403);
          return await purgeToken(env, who.invite);
        }
        if (!who || who.kind !== 'owner') return json({ error: 'Owner only.' }, 403);
        if (url.pathname === '/api/invites/create') return await createInvite(request, env);
        if (url.pathname === '/api/invites/revoke') return await revokeInvite(request, env);
        if (url.pathname === '/api/invites/purge') return await purgeInvite(request, env);
        if (url.pathname === '/api/invites') return await listInvites(env);
      } catch {
        return json({ error: 'The database couldn’t be reached.' }, 502);
      }
      return json({ error: 'Not found' }, 404);
    }
    if (url.pathname === '/api/rain') {
      if (!env.DB) return json({ at: null, wet: [], stations: 0, areas: [] });
      try { return await getRain(env); } catch { return json({ error: 'The database couldn’t be reached.' }, 502); }
    }
    if (url.pathname === '/api/surge') {
      if (!env.DB) return json({ points: [] });
      try { return await getSurge(env); } catch { return json({ error: 'The database couldn’t be reached.' }, 502); }
    }
    if (url.pathname === '/api/events' || url.pathname === '/api/events/delete' || url.pathname === '/api/info') {
      if (!env.DB) return json({ error: 'The server isn’t set up yet.' }, 503);
      try {
        if (url.pathname === '/api/info') return await getInfo(env);
        if (request.method === 'GET' && url.pathname === '/api/events') return await eventsOut(env);
        if (!who) who = await whoIs(request, env);
        if (!who || who.kind !== 'owner') return json({ error: 'Owner only.' }, 403);
        return url.pathname === '/api/events' ? await addEvent(request, env) : await removeEvent(request, env);
      } catch {
        return json({ error: 'The database couldn’t be reached.' }, 502);
      }
    }
    if (url.pathname === '/api/flights') {
      if (!env.DB) return json({ ready: false });
      try { return await getFlights(env); } catch { return json({ error: 'The database couldn’t be reached.' }, 502); }
    }
    if (!authorized(request, env)) return json({ error: 'Access key missing or wrong. Set it in Fareit under Settings.' }, 401);

    if (url.pathname === '/api/queue' || url.pathname === '/api/queue/delete') {
      if (!env.DB) return json({ error: 'The database isn’t set up on the server yet.' }, 503);
      try {
        if (url.pathname === '/api/queue/delete') return await deleteQueue(request, env);
        return request.method === 'POST' ? await postQueue(request, env) : await getQueue(url, env);
      } catch {
        return json({ error: 'The database couldn’t be reached.' }, 502);
      }
    }
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
      if (url.pathname === '/api/area') {
        const at = parsePoint(url.searchParams.get('at'));
        if (!at) return json({ error: 'at must be a lat,lng point in Singapore.' }, 400);
        return await area(at, env);
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
