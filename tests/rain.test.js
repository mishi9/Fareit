import test from 'node:test';
import assert from 'node:assert/strict';
import { rainAt, rainTag, isWet, isThunder, RAIN_NEAR_KM } from '../public/rain.js';
import { timeOfDay, rainLift, bandOutlook, passengerFare, fitWeights, timeEstimator, withBase, fitCommission, driverEarns } from '../public/formula.js';
import { cleanRain, cleanFormulaTrip } from '../worker/index.js';

const now = Date.parse('2026-11-19T00:45:00+08:00');
const novena = { lat: 1.3204, lng: 103.8438 };
const data = {
  at: now, readAt: now, stations: 3,
  wet: [{ lat: 1.3220, lng: 103.8460, mm: 0.4 }], // ~0.3 km from Novena
  areas: [{ name: 'Novena', lat: 1.327, lng: 103.826, f: 'Thundery Showers' }, { name: 'Bedok', lat: 1.321, lng: 103.924, f: 'Cloudy' }],
  valid: { text: '12.30 am to 2.30 am', end: now + 105 * 60000 },
};

test('rain words: anything wet counts, thunder is told apart', () => {
  for (const f of ['Light Rain', 'Moderate Rain', 'Heavy Rain', 'Passing Showers', 'Showers', 'Thundery Showers', 'Heavy Thundery Showers with Gusty Winds']) assert.ok(isWet(f), f);
  for (const f of ['Fair', 'Fair (Night)', 'Partly Cloudy (Day)', 'Cloudy', 'Hazy', 'Windy']) assert.ok(!isWet(f), f);
  assert.ok(isThunder('Heavy Thundery Showers'));
  assert.ok(!isThunder('Light Rain'));
});

test('raining near you: a gauge with rain within 3 km, else your town\'s forecast, else nothing', () => {
  const r = rainAt(novena, data, now);
  assert.equal(r.kind, 'now');
  assert.equal(r.area, 'Novena');
  // gauge too far, forecast wet -> forecast
  const far = { ...data, wet: [{ lat: 1.40, lng: 103.90, mm: 2 }] };
  assert.ok(RAIN_NEAR_KM < 10);
  assert.equal(rainAt(novena, far, now).kind, 'forecast');
  // nothing wet around Bedok
  assert.equal(rainAt({ lat: 1.321, lng: 103.924 }, far, now), null);
  // old gauge readings don't count; an expired forecast doesn't either
  assert.equal(rainAt(novena, { ...data, readAt: now - 60 * 60000, valid: { text: '', end: now - 2 * 3600000 } }, now), null);
});

test('trips are tagged 1 in the rain, 0 dry, null when the rain data is missing or old', () => {
  assert.equal(rainTag(novena, data, now), 1);
  assert.equal(rainTag({ lat: 1.321, lng: 103.924 }, data, now), 0);
  assert.equal(rainTag(novena, null, now), null);
  assert.equal(rainTag(novena, { ...data, at: now - 2 * 3600000 }, now), null);
});

test('NEA answers are cut down to wet gauges and town forecasts', () => {
  const rainfall = { data: { stations: [{ id: 'S1', location: { latitude: 1.32, longitude: 103.84 } }, { id: 'S2', location: { latitude: 1.4, longitude: 103.9 } }],
    readings: [{ timestamp: '2026-11-19T00:45:00+08:00', data: [{ stationId: 'S1', value: 0.2 }, { stationId: 'S2', value: 0 }] }] } };
  const forecast = { data: { area_metadata: [{ name: 'Novena', label_location: { latitude: 1.327, longitude: 103.826 } }],
    items: [{ valid_period: { start: '2026-11-19T00:30:00+08:00', end: '2026-11-19T02:30:00+08:00', text: '12.30 am to 2.30 am' }, forecasts: [{ area: 'Novena', forecast: 'Light Rain' }] }] } };
  const out = cleanRain(rainfall, forecast, now);
  assert.equal(out.stations, 2);
  assert.deepEqual(out.wet, [{ lat: 1.32, lng: 103.84, mm: 0.2 }]);
  assert.deepEqual(out.areas, [{ name: 'Novena', lat: 1.327, lng: 103.826, f: 'Light Rain' }]);
  assert.equal(out.valid.text, '12.30 am to 2.30 am');
  assert.equal(out.readAt, now);
  // one half missing: still usable
  assert.equal(cleanRain(null, forecast, now).areas.length, 1);
});

test('the server keeps the rain tag: 1, 0 or unknown', () => {
  const base = { id: 'trip-0001', ts: now, km: 8, paid: 15, earned: 11, surge: 'normal', lat: 1.32, lng: 103.84 };
  assert.equal(cleanFormulaTrip({ ...base, rain: 1 }, now).rain, 1);
  assert.equal(cleanFormulaTrip({ ...base, rain: 0 }, now).rain, 0);
  assert.equal(cleanFormulaTrip(base, now).rain, null);
  assert.equal(cleanFormulaTrip({ ...base, rain: 'yes' }, now).rain, null);
});

// Trips that paid what the formula says, except rain trips that paid 20% more.
function trips(rainAbove = 0.2) {
  const w = fitWeights([]);
  const est = timeEstimator(withBase([]));
  const c = fitCommission([]);
  const out = [];
  for (let i = 0; i < 12; i++) {
    const km = 5 + i;
    const rain = i % 2 ? 1 : 0;
    const paid = Math.round(passengerFare(w, km, est(km)).fare * (rain ? 1 + rainAbove : 1) * 100) / 100;
    out.push({ id: `t${i}`, ts: now - (i + 1) * 3600000 * 24 * 7, km, actual: paid, earned: Math.round(driverEarns(c, paid) * 100) / 100, surge: 'normal', lat: novena.lat, lng: novena.lng, rain });
  }
  return out;
}

test('rain trips are learned on their own: how they ran vs normal (observed, starts at +0%)', () => {
  assert.deepEqual(rainLift([]), { lift: 0, n: 0, guess: true });
  const r = rainLift(trips());
  assert.equal(r.n, 6);
  assert.ok(r.lift > 0.05 && r.lift < 0.25, String(r.lift));
});

test('a wet evening counts fully while it rains, and only half on a dry one', () => {
  const ts = trips();
  const dry = timeOfDay(ts, now, novena).lift;
  const wet = timeOfDay(ts, now, novena, { raining: true }).lift;
  assert.ok(wet > dry, `${wet} > ${dry}`);
  // with no rain trips at all, rain changes nothing
  const plain = ts.map((t) => ({ ...t, rain: 0, actual: t.rain ? Math.round(t.actual / 1.2 * 100) / 100 : t.actual }));
  assert.ok(Math.abs(timeOfDay(plain, now, novena).lift - timeOfDay(plain, now, novena, { raining: true }).lift) < 0.03);
});

test('Radar cards: rain is its own flag; the price state stays Normal / Surge / Bad (events still come first)', () => {
  const b = bandOutlook(trips(), now, novena, { raining: true });
  assert.ok(b.every((x) => x.raining && ['good', 'normal', 'bad'].includes(x.state)));
  assert.ok(b[0].rainTrips === 6);
  assert.ok(bandOutlook(trips(), now, novena).every((x) => !x.raining));
  const ev = bandOutlook(trips(), now, novena, { raining: true, event: { id: 'e1' } });
  assert.ok(ev.every((x) => x.state === 'event'));
});

// ---------- past trips: tagged from NEA's own readings for their time and place ----------
import { DatabaseSync } from 'node:sqlite';
import worker, { backfillRain, resetSchemaFlag } from '../worker/index.js';
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => { db.prepare(sql).run(...args); return { success: true }; }, exec: () => db.prepare(sql).run(...args) });
  return { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) s.exec(); return []; } };
}

test('trips saved without a rain tag are checked against NEA\'s past readings, then phones pick it up', async () => {
  resetSchemaFlag();
  const env = { DB: fakeD1() };
  const t0 = Date.now();
  const wetAt = t0 - 3 * 3600000; // raining in Novena 3 hours ago
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u.pathname + u.search);
    const when = Date.parse(`${u.searchParams.get('date')}+08:00`);
    const raining = Math.abs(when - wetAt) < 15 * 60000;
    if (u.pathname.endsWith('/rainfall')) return new Response(JSON.stringify({ data: { stations: [{ id: 'S1', location: { latitude: 1.3220, longitude: 103.8460 } }], readings: [{ timestamp: new Date(when).toISOString(), data: [{ stationId: 'S1', value: raining ? 1.2 : 0 }] }] } }));
    return new Response(JSON.stringify({ data: { area_metadata: [{ name: 'Novena', label_location: { latitude: 1.327, longitude: 103.826 } }], items: [{ valid_period: { end: new Date(when + 3600000).toISOString(), text: '' }, forecasts: [{ area: 'Novena', forecast: 'Cloudy' }] }] } }));
  };
  try {
    const post = (trips) => worker.fetch(new Request('https://x/api/formula', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.1.1.1' },
      body: JSON.stringify({ device: 'device-rainy-01', trips }) }), env).then((r) => r.json());
    const trip = (id, ts, over = {}) => ({ id, ts, km: 8, paid: 15, earned: 11, surge: 'normal', lat: 1.3204, lng: 103.8438, ...over });
    await post([trip('trip-wet-0001', wetAt), trip('trip-dry-0002', t0 - 6 * 3600000), trip('trip-set-0003', t0 - 2 * 3600000, { rain: 0 })]);
    assert.equal(await backfillRain(env, t0), 2); // the one already tagged is left alone
    const rows = (await worker.fetch(new Request('https://x/api/formula?since=0'), env).then((r) => r.json())).trips;
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(by['trip-wet-0001'].rain, 1);
    assert.equal(by['trip-dry-0002'].rain, 0);
    assert.equal(by['trip-set-0003'].rain, 0);
    // tagging bumps the revision, so every phone gets the change on its next sync
    assert.ok(by['trip-wet-0001'].rev > 3 && by['trip-dry-0002'].rev > 3);
    // nothing left to do; a phone re-uploading the trip without a tag doesn't wipe it
    assert.equal(await backfillRain(env, t0), 0);
    await post([trip('trip-wet-0001', wetAt)]);
    const again = (await worker.fetch(new Request('https://x/api/formula?since=0'), env).then((r) => r.json())).trips;
    assert.equal(again.find((r) => r.id === 'trip-wet-0001').rain, 1);
    // readings are fetched by Singapore time and kept, not fetched twice
    assert.ok(calls.every((c) => /date=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(c)));
  } finally {
    globalThis.fetch = real;
  }
});
