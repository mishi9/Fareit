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

test('Radar cards say Raining while it rains (events still come first)', () => {
  const b = bandOutlook(trips(), now, novena, { raining: true });
  assert.ok(b.every((x) => x.state === 'rain'));
  assert.ok(b[0].rainTrips === 6);
  assert.ok(bandOutlook(trips(), now, novena).every((x) => x.state !== 'rain'));
  const ev = bandOutlook(trips(), now, novena, { raining: true, event: { id: 'e1' } });
  assert.ok(ev.every((x) => x.state === 'event'));
});
