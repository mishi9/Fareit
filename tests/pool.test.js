import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { resetSchemaFlag, cleanJob } from '../worker/index.js';
import { toPoolRow, fromPoolRow, isShareable, pushJobs, pullJobs } from '../public/sync.js';
import { predict, priorNet, DEFAULT_SETTINGS } from '../public/model.js';

const S = DEFAULT_SETTINGS;
const at = (iso) => new Date(iso).getTime();

// Minimal D1 stand-in on top of SQLite, so the real SQL runs.
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    exec: () => db.prepare(sql).run(...args),
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) s.exec(); return []; } };
}

const now = Date.now();
function job(over = {}) {
  return {
    id: 'job-0000000001', ts: now - 3600 * 1000, ride: 'standard', band: '10-15', zone: 'E', decision: 'took',
    km: 12.34, trip_min: 20, drive_min: 19.5, fare: 18.4, pricing: 'surge',
    pickup_lat: 1.30481, pickup_lng: 103.83179, drop_lat: 1.34961, drop_lng: 103.95681, ...over,
  };
}

function client(env) {
  return {
    post: (body, ip = '1.2.3.4') => worker.fetch(new Request('https://fareit.test/api/jobs', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body),
    }), env).then(async (r) => ({ status: r.status, body: await r.json() })),
    get: (since = 0) => worker.fetch(new Request(`https://fareit.test/api/jobs?since=${since}`), env)
      .then(async (r) => ({ status: r.status, body: await r.json() })),
  };
}

test.beforeEach(() => resetSchemaFlag());

// ---------- model: minimum fare, ride type, robustness ----------

test('no prediction goes below the S$6.20 minimum fare', () => {
  assert.equal(priorNet(1, 3, S), 6.2);
  const p = predict({ band: '0-3', zone: 'E', ts: at('2026-11-16T14:00:00+08:00') }, [], S);
  assert.equal(p.net, 6.2);
  assert.ok(p.lo >= 6.2 && p.hi >= 6.2);
});

test('the card fare is take-home: no commission in the formula', () => {
  assert.equal('commission' in DEFAULT_SETTINGS, false);
  const p = priorNet(45.8, 52, S);
  assert.ok(Math.abs(p - 33.2) / 33.2 < 0.02, `prior ${p.toFixed(2)}`);
});

test('other ride types count for much less', () => {
  const ts = at('2026-11-16T18:00:00+08:00');
  const base = { status: 'reconciled', km: 12, tripMin: 20, zone: 'E', band: '12-15', ts };
  const trips = [1, 2, 3, 4, 5].map((i) => ({ ...base, id: `p${i}`, rideType: 'premium', fare: priorNet(12, 20, S) * 2 }));
  const asStandard = predict({ band: '12-15', zone: 'E', ts, ride: 'standard' }, trips, S);
  const asPremium = predict({ band: '12-15', zone: 'E', ts, ride: 'premium' }, trips, S);
  assert.ok(asPremium.net / asPremium.prior > asStandard.net / asStandard.prior + 0.15);
});

test('one absurd shared fare cannot blow up a prediction', () => {
  const ts = at('2026-11-16T18:00:00+08:00');
  const junk = { id: 'x', status: 'reconciled', shared: true, km: 3, tripMin: 8, zone: 'E', band: '3-6', ts, fare: 400 };
  const p = predict({ band: '0-3', zone: 'E', ts }, [junk], S);
  assert.ok(p.net < p.prior * 3.4, `net ${p.net.toFixed(2)}`);
  assert.equal(p.shared, 1);
});

// ---------- what leaves the phone ----------

test('a pool row carries no addresses and rounds place and time', () => {
  const t = {
    id: 'abc-123-def-456', ts: at('2026-11-18T02:47:00+08:00'), status: 'reconciled', rideType: 'standard',
    band: '10-15', zone: 'E', decision: 'cancelled', km: 12.345, tripMin: 20, driveMin: 19.4, fare: 24.5,
    pickupText: '2 Orchard Turn', dropText: '111 Tampines St 11', payment: 'cashless',
    pickup: { label: 'ION ORCHARD', address: '2 ORCHARD TURN ION ORCHARD SINGAPORE 238801', postal: '238801', lat: 1.304051, lng: 103.831829 },
    drop: { label: '111 TAMPINES', postal: '521111', lat: 1.346914, lng: 103.947416 },
    tapLoc: { lat: 1.30481, lng: 103.83179 },
  };
  const row = toPoolRow(t);
  const text = JSON.stringify(row);
  for (const secret of ['Orchard', 'ORCHARD', '238801', '521111', 'Tampines', 'TAMPINES']) assert.ok(!text.includes(secret), secret);
  assert.equal(row.pickup_lat, 1.3);
  assert.equal(row.pickup_lng, 103.83);
  assert.equal(row.drop_lat, 1.35);
  assert.equal(new Date(row.ts).getMinutes() % 5, 0);
  assert.equal(row.decision, 'cancelled');
  assert.equal(row.fare, 24.5);
  const back = fromPoolRow(row);
  assert.equal(back.shared, true);
  assert.equal(back.status, 'reconciled');
  assert.equal(back.pickup.lat, 1.3);
});

test('only finished jobs are shared', () => {
  assert.equal(isShareable({ status: 'pending', fare: 10, km: 3 }), false);
  assert.equal(isShareable({ status: 'reconciled', fare: 10, km: 3 }), true);
  assert.equal(isShareable({ status: 'reconciled', fare: 10 }), false); // waiting for road distance
  assert.equal(isShareable({ status: 'nofare', decision: 'cancelled' }), true);
});

// ---------- pool server ----------

test('a job goes in and comes back out without its device or IP', async () => {
  const api = client({ DB: fakeD1() });
  const res = await api.post({ device: 'device-aaaaaaaa', jobs: [job()] });
  assert.deepEqual(res.body, { accepted: ['job-0000000001'], rejected: [] });
  const out = await api.get();
  assert.equal(out.body.jobs.length, 1);
  const row = out.body.jobs[0];
  assert.equal(row.device, undefined);
  assert.equal(row.ip_hash, undefined);
  assert.equal(row.pickup_lat, 1.3);
  assert.equal(row.km, 12.34);
  assert.equal(row.ts % (5 * 60 * 1000), 0);
});

test('a phone can correct its own job but not someone else’s', async () => {
  const api = client({ DB: fakeD1() });
  await api.post({ device: 'device-aaaaaaaa', jobs: [job()] });
  const first = await api.get();
  const hijack = await api.post({ device: 'device-bbbbbbbb', jobs: [job({ fare: 99 })] });
  assert.deepEqual(hijack.body.rejected, ['job-0000000001']);
  const fix = await api.post({ device: 'device-aaaaaaaa', jobs: [job({ fare: 21 })] });
  assert.deepEqual(fix.body.accepted, ['job-0000000001']);
  const changes = await api.get(first.body.next);
  assert.equal(changes.body.jobs.length, 1);
  assert.equal(changes.body.jobs[0].fare, 21);
});

test('junk is refused', async () => {
  const api = client({ DB: fakeD1() });
  const res = await api.post({ device: 'device-aaaaaaaa', jobs: [
    job({ id: 'too-expensive-1', fare: 900 }),
    job({ id: 'not-in-singapore', pickup_lat: 3.139, pickup_lng: 101.687 }),
    job({ id: 'from-the-future', ts: now + 86400 * 1000 }),
    job({ id: 'bad-zone-xxxxxx', zone: 'MARS' }),
    job({ id: 'nothing-useful-1', fare: null, km: null, decision: null }),
    job({ id: 'cancelled-no-fare', fare: null, km: null, decision: 'cancelled' }),
  ] });
  assert.deepEqual(res.body.accepted, ['cancelled-no-fare']);
  assert.equal(res.body.rejected.length, 5);
  assert.equal(cleanJob({ id: 'short' }), null);
});

test('one connection can add at most 300 new jobs a day', async () => {
  const api = client({ DB: fakeD1() });
  let accepted = 0;
  for (let b = 0; b < 7; b++) {
    const jobs = Array.from({ length: 50 }, (_, i) => job({ id: `bulk-${b}-${String(i).padStart(4, '0')}` }));
    accepted += (await api.post({ device: 'device-aaaaaaaa', jobs })).body.accepted.length;
  }
  assert.equal(accepted, 300);
  const other = await api.post({ device: 'device-cccccccc', jobs: [job({ id: 'other-ip-job-1' })] }, '5.6.7.8');
  assert.equal(other.body.accepted.length, 1);
});

test('pages through a large pool', async () => {
  const env = { DB: fakeD1() };
  const api = client(env);
  for (let b = 0; b < 3; b++) {
    const jobs = Array.from({ length: 50 }, (_, i) => job({ id: `page-${b}-${String(i).padStart(4, '0')}` }));
    await api.post({ device: 'device-aaaaaaaa', jobs }, `10.0.0.${b}`);
  }
  const first = await worker.fetch(new Request('https://fareit.test/api/jobs?since=0&limit=100'), env).then((r) => r.json());
  assert.equal(first.jobs.length, 100);
  assert.equal(first.more, true);
  const rest = await worker.fetch(new Request(`https://fareit.test/api/jobs?since=${first.next}&limit=100`), env).then((r) => r.json());
  assert.equal(rest.jobs.length, 50);
  assert.equal(rest.more, false);
});

test('without a database the pool says so', async () => {
  const res = await client({}).get();
  assert.equal(res.status, 503);
});

// ---------- phone sync against the server ----------

test('phones push their jobs and learn from each other', async () => {
  const env = { DB: fakeD1() };
  const call = (path, body) => worker.fetch(new Request(`https://fareit.test${path}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), env).then((r) => r.json());

  const mine = [{ id: 'trip-mine-0001', ts: now - 7200 * 1000, status: 'reconciled', rideType: 'standard', band: '10-15', zone: 'E', km: 12, tripMin: 20, fare: 18 }];
  const sent = await pushJobs({ trips: mine, device: 'device-phone-a', post: (b) => call('/api/jobs', b), save: async () => {} });
  assert.equal(sent, 1);
  assert.equal(await pushJobs({ trips: mine, device: 'device-phone-a', post: (b) => call('/api/jobs', b), save: async () => {} }), 0, 'unchanged jobs are not re-sent');

  const stored = [];
  const { total, cursor } = await pullJobs({ since: 0, get: (c) => call(`/api/jobs?since=${c}`), store: async (rows) => stored.push(...rows) });
  assert.equal(total, 1);
  assert.ok(cursor > 0);
  assert.equal(stored[0].shared, true);
  const p = predict({ band: '12-15', zone: 'E', ts: now }, stored, S);
  assert.equal(p.basis, 1);
  assert.equal(p.shared, 1);
});
