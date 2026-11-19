import test from 'node:test';
import assert from 'node:assert/strict';
import {
  passengerFare, fitWeights, looError, fitCommission, driverEarns, usable, cutOf, toCsv, SEED, BASE_TRIPS, MIN_PASSENGER,
} from '../public/formula.js';

test('the base trip from Grab\'s job details: paid S$16.80, earned S$12.10, Grab keeps S$4.70', () => {
  const b = BASE_TRIPS[0];
  const cut = cutOf(b);
  assert.equal(Math.round(cut.cut * 100) / 100, 4.7);
  assert.ok(Math.abs(cut.rate - 4.7 / 16.8) < 1e-9);
  // The starting weights reproduce it exactly.
  assert.equal(passengerFare(SEED, b.km, b.min).fare, 16.8);
  const w = fitWeights([]);
  assert.equal(passengerFare(w, b.km, b.min).fare, 16.8);
  assert.equal(w.n, 1);
});

test('the passenger pays the formula, never less than S$8.10, plus ERP', () => {
  assert.equal(passengerFare(SEED, 1, 3).fare, MIN_PASSENGER);
  assert.equal(passengerFare(SEED, 1, 3).atMinimum, true);
  const w = { base: 3, perKm: 0.6, perMin: 0.25 };
  assert.equal(passengerFare(w, 10, 20).fare, 14);
  assert.equal(passengerFare(w, 10, 20, 1.5).fare, 15.5, 'ERP on top');
});

// Trips made with a hidden formula: paid S$3.00 + S$0.60/km + S$0.25/min, Grab keeps 28%.
const TRUE = { base: 3, perKm: 0.6, perMin: 0.25 };
const make = (km, min, extra = {}) => {
  const fare = TRUE.base + TRUE.perKm * km + TRUE.perMin * min;
  const erp = extra.erp || 0;
  return { ts: Date.now(), km, min, erp, surge: 'normal', actual: Math.round((fare + erp) * 100) / 100, earned: Math.round((fare * 0.72 + erp) * 100) / 100, ...extra };
};

test('with enough trips the weights reach the hidden formula', () => {
  const trips = [[5, 12], [9, 15], [14, 30], [20, 26], [28, 45], [7, 20], [33, 40], [12, 14], [18, 35], [25, 30], [40, 50], [3, 9]].map(([k, m]) => make(k, m));
  const w = fitWeights(trips, { includeBase: false });
  assert.ok(Math.abs(w.base - 3) < 0.2 && Math.abs(w.perKm - 0.6) < 0.03 && Math.abs(w.perMin - 0.25) < 0.03, JSON.stringify(w));
  assert.ok(looError(trips).avg < 0.6, 'with the base trip mixed in, still close');
});

test('surge and minimum-fare trips are kept out of the formula', () => {
  // Test: surge is told by the price, so a green-arrow (surge-tagged) trip can still teach normal.
  assert.equal(usable(make(10, 20, { surge: 'surge' })), true);
  assert.equal(usable(make(10, 20, { surge: 'airport' })), false);
  assert.equal(usable({ km: 1.5, min: 5, surge: 'normal', actual: 8.1 }), false);
  assert.equal(usable(make(10, 20)), true);
});

test('what Grab keeps: from the base trip alone, then flat % or % plus a fixed amount', () => {
  const one = fitCommission([]);
  assert.equal(one.kind, 'average');
  assert.ok(Math.abs(one.avgRate - 4.7 / 16.8) < 1e-9);
  const flat = fitCommission([make(10, 20), make(20, 30), make(5, 12, { erp: 1 })]);
  assert.equal(flat.kind, 'flat');
  assert.ok(Math.abs(flat.avgRate - 0.28) < 0.003, flat.avgRate);
  assert.equal(driverEarns({ keep: 0.72, fixed: 0 }, 15), 10.8);
  // Grab keeps 20% and a further S$0.50 per job: shows as % plus fixed.
  const fixed = [make(10, 20), make(20, 30), make(30, 40), make(5, 12)].map((t) => ({
    ...t, earned: Math.round(((t.actual - t.erp) * 0.8 - 0.5 + t.erp) * 100) / 100,
  }));
  assert.equal(fitCommission(fixed).kind, 'percent+fixed');
});

test('CSV export matches the research dataset columns and leaves out the base trip', () => {
  const lines = toCsv([BASE_TRIPS[0], make(10, 20)]).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].split(',').length, lines[1].split(',').length);
  assert.ok(lines[1].includes(',Standard,10,20,,14,'));
});

test('time of day: how fares near an hour ran against the formula, surge trips included', async () => {
  const { timeOfDay, byTimeBlock } = await import('../public/formula.js');
  const at = (iso) => Date.parse(iso);
  // Normal midday trips teach the formula; evening surge trips paid 30% over it.
  const midday = [[5, 12], [9, 15], [14, 30], [20, 26], [28, 45], [7, 20], [33, 40], [12, 14], [18, 35], [25, 30], [40, 50], [3, 9]]
    .map(([km, min], i) => make(km, min, { ts: at(`2026-11-1${7 + (i % 3)}T12:${String(i).padStart(2, '0')}:00+08:00`) }));
  const evening = [[10, 20], [15, 25], [8, 18]].map(([km, min], i) => {
    const t = make(km, min, { ts: at(`2026-11-1${7 + i}T18:30:00+08:00`), surge: 'surge' });
    return { ...t, actual: Math.round(t.actual * 1.3 * 100) / 100 };
  });
  const all = [...midday, ...evening];
  const sixPm = timeOfDay(all, at('2026-11-20T18:00:00+08:00'));
  assert.equal(sixPm.near, 3);
  assert.equal(sixPm.surgeNear, 3);
  assert.ok(sixPm.lift > 0.15 && sixPm.lift < 0.3, `evening lift ${sixPm.lift}`);
  const noon = timeOfDay(all, at('2026-11-20T12:00:00+08:00'));
  assert.ok(Math.abs(noon.lift) < 0.05, `midday lift ${noon.lift}`);
  const blocks = byTimeBlock(all);
  assert.equal(blocks[6].n, 3, '18:00–21:00');
  assert.equal(blocks[0].n, 1, '00:00–03:00 holds the base trip');
  assert.ok(blocks[6].lift > 0.15);
});

test('low-cut trips (Grab keeps almost nothing) are counted apart, not fitted into the usual cut', async () => {
  const { isLowCut } = await import('../public/formula.js');
  // The real trips from 17 Nov (base trip built in). #7: S$23.90 paid, S$23.80 earned.
  const real = [[17.76, 16, 17, 12.3], [3.93, 15, 11.43, 7.5], [10.77, 17, 18.7, 13.3], [12.39, 24, 16, 11.2], [2.38, 12, 10.82, 7.3], [20.34, 34, 23.9, 23.8]]
    .map(([km, min, actual, earned]) => ({ ts: Date.now(), km, min, erp: 0, surge: 'normal', actual, earned }));
  assert.equal(isLowCut(real[5]), true);
  const c = fitCommission(real);
  assert.equal(c.low.length, 1);
  assert.equal(c.kind, 'percent+fixed');
  // Usual rule from the other 6: about 79.8% of paid − S$1.45, every trip within 20 cents.
  for (const t of real.slice(0, 5)) assert.ok(Math.abs(driverEarns(c, t.actual) - t.earned) < 0.2, `${t.actual} → ${driverEarns(c, t.actual)} vs ${t.earned}`);
});

test('trip time: the job card total (which includes the way to the pickup) is never used as trip time', async () => {
  const { timeEstimator, tripTime } = await import('../public/formula.js');
  const cardOnly = { km: 20.6, min: null, cardMin: 32, pickupKm: 0.92, surge: 'normal', actual: 25, ts: Date.now() };
  const est = timeEstimator([]);
  assert.equal(tripTime(cardOnly, est), est(20.6), 'estimated from km, not the card total of 32');
  assert.ok(Math.abs(est(20.6) - 25.66) < 0.01, 'default about 3 + 1.1 min per km');
  assert.equal(tripTime({ ...cardOnly, min: 22 }, est), 22, 'a typed trip time wins');
  // Real trip times teach the estimate.
  const timed = [[5, 9], [10, 15], [20, 22], [30, 31]].map(([km, min]) => ({ km, min }));
  const learned = timeEstimator(timed);
  assert.ok(Math.abs(learned(20) - 22) < 1.5, `learned ${learned(20)}`);
  // A trip without trip time still teaches the formula through its distance.
  assert.equal(usable(cardOnly), true);
  assert.equal(fitWeights([cardOnly]).n, 2);
});

test('a driver never earns less than S$6.20, and trips at that floor stay out of the cut rule', async () => {
  const { MIN_DRIVER } = await import('../public/formula.js');
  assert.equal(MIN_DRIVER, 6.2);
  const rule = { keep: 0.768, fixed: -1.02 };
  assert.equal(driverEarns(rule, 8.1), 6.2, 'minimum-fare trip: rule gives 5.20, floor lifts it');
  assert.equal(driverEarns(rule, 8.1, 1.5), 7.7, 'ERP on top of the floor');
  assert.equal(driverEarns(rule, 20), 14.34);
  const atFloor = { km: 2, min: 6, erp: 0, surge: 'normal', actual: 8.1, earned: 6.2, ts: Date.now() };
  assert.equal(fitCommission([atFloor]).n, 1, 'only the base trip counts');
});

test('surge estimate: how far surge trips ran above the normal formula, near this hour first', async () => {
  const { surgeLift } = await import('../public/formula.js');
  const at = (iso) => Date.parse(iso);
  const normal = [[5, 12], [9, 15], [14, 30], [20, 26], [28, 45], [7, 20], [33, 40], [12, 14]]
    .map(([km, min], i) => make(km, min, { ts: at(`2026-11-1${7 + (i % 3)}T12:${String(i).padStart(2, '0')}:00+08:00`) }));
  const none = surgeLift(normal, at('2026-11-20T18:00:00+08:00'));
  assert.deepEqual([none.lift, none.n, none.guess], [0.2, 0, true], 'no surge trips: the +20% starting guess');
  const surge = [[10, 20], [15, 25], [8, 18]].map(([km, min], i) => {
    const t = make(km, min, { ts: at(`2026-11-1${7 + i}T18:30:00+08:00`), surge: 'surge' });
    return { ...t, actual: Math.round(t.actual * 1.25 * 100) / 100 };
  });
  const s = surgeLift([...normal, ...surge], at('2026-11-20T18:00:00+08:00'));
  assert.equal(s.n, 3);
  assert.equal(s.near, 3);
  assert.ok(s.lift > 0.2 && s.lift < 0.25, `3 trips at +25% pull the +20% guess toward 25%: ${s.lift}`);
  // Many surge trips at +40%: the guess fades.
  const many = Array.from({ length: 12 }, (_, i) => {
    const t = make(8 + i, 15 + i, { ts: at(`2026-11-${10 + i}T18:20:00+08:00`), surge: 'surge' });
    return { ...t, actual: Math.round(t.actual * 1.4 * 100) / 100 };
  });
  const m = surgeLift([...normal, ...many], at('2026-11-25T18:00:00+08:00'));
  assert.ok(m.lift > 0.33, `lift ${m.lift}`);
  // Surge trips don't move the normal formula.
  const w = fitWeights([...normal, ...surge], { includeBase: false });
  const w0 = fitWeights(normal, { includeBase: false });
  assert.equal(w.base, w0.base);
});

test('airport trips: kept out of the normal formula, their difference learned from +0%', async () => {
  const { airportLift } = await import('../public/formula.js');
  const normal = [[5, 12], [9, 15], [14, 30], [20, 26], [28, 45], [7, 20]].map(([km, min]) => make(km, min));
  const none = airportLift(normal, Date.now());
  assert.deepEqual([none.lift, none.guess], [0, true], 'no airport trips: no difference assumed');
  const airport = [[18, 22], [22, 25], [25, 30]].map(([km, min]) => {
    const t = make(km, min, { surge: 'airport' });
    return { ...t, actual: Math.round(t.actual * 1.15 * 100) / 100 };
  });
  assert.equal(usable(airport[0]), false, 'not used for the normal formula');
  const a = airportLift([...normal, ...airport], Date.now());
  assert.equal(a.n, 3);
  assert.ok(a.lift > 0.05 && a.lift < 0.15, `lift ${a.lift}`);
});

test('airport queue summary: readings around this hour, from all drivers', async () => {
  const { queueSummary } = await import('../public/queue.js');
  const at = (iso) => Date.parse(iso);
  const readings = [
    { ts: at('2026-11-17T02:10:00+08:00'), cars: 40, est: 35, actual: 50 },
    { ts: at('2026-11-18T01:40:00+08:00'), cars: 60, est: 45, actual: null },
    { ts: at('2026-11-18T14:00:00+08:00'), cars: 5, est: 8, actual: 10 },
  ];
  const s = queueSummary(readings, at('2026-11-20T02:00:00+08:00'));
  assert.deepEqual([s.n, s.cars, s.est, s.actual, s.nActual], [2, 50, 40, 50, 1]);
  assert.equal(queueSummary(readings, at('2026-11-20T08:00:00+08:00')), null);
});

test('beta Window bands: normal, surge and now earnings for < 10, 10–20 and > 20 km', async () => {
  const { bandOutlook } = await import('../public/formula.js');
  const at = (iso) => Date.parse(iso);
  const normal = [[5, 12], [9, 15], [14, 30], [20, 26], [28, 45], [7, 20], [33, 40], [12, 14]]
    .map(([km, min], i) => make(km, min, { ts: at(`2026-11-1${7 + (i % 3)}T12:${String(i).padStart(2, '0')}:00+08:00`) }));
  const quiet = bandOutlook(normal, at('2026-11-20T12:00:00+08:00'));
  assert.deepEqual(quiet.map((b) => b.label), ['< 10 km', '10–20 km', '> 20 km']);
  for (const b of quiet) {
    assert.equal(b.state, 'normal');
    assert.ok(b.surge > b.normal, 'surge pays more (starting +20%)');
    assert.ok(b.normal >= 6.2, 'never below the driver minimum');
  }
  assert.ok(quiet[0].normal < quiet[1].normal && quiet[1].normal < quiet[2].normal);
  // Evening fares running 30% above normal turn the cards green at that hour.
  const busy = [[10, 20], [15, 25], [8, 18], [22, 30]].map(([km, min], i) => {
    const t = make(km, min, { ts: at(`2026-11-${17 + i}T18:30:00+08:00`), surge: 'surge' });
    return { ...t, actual: Math.round(t.actual * 1.3 * 100) / 100 };
  });
  const evening = bandOutlook([...normal, ...busy], at('2026-11-20T18:30:00+08:00'));
  assert.ok(evening.every((b) => b.state === 'good'), JSON.stringify(evening.map((b) => [b.state, b.vs])));
  // Late at night, fares running 20% under: red.
  const slow = [[10, 20], [15, 25], [8, 18], [22, 30]].map(([km, min], i) => {
    const t = make(km, min, { ts: at(`2026-11-${17 + i}T15:30:00+08:00`) });
    return { ...t, actual: Math.round(t.actual * 0.75 * 100) / 100 };
  });
  const afternoon = bandOutlook([...normal, ...slow], at('2026-11-20T15:30:00+08:00'));
  assert.ok(afternoon.some((b) => b.state === 'bad'), JSON.stringify(afternoon.map((b) => [b.state, b.vs])));
});

test('airport zone: Changi terminals and holding areas, not Changi Business Park or Tampines', async () => {
  globalThis.navigator ??= {};
  const { atAirport, rounded } = await import('../public/where.js');
  assert.equal(atAirport({ lat: 1.3603, lng: 103.9894 }), true, 'Jewel');
  assert.equal(atAirport({ lat: 1.3480, lng: 103.9870 }), true, 'between T2 and T4');
  assert.equal(atAirport({ lat: 1.3340, lng: 103.9630 }), false, 'Changi Business Park');
  assert.equal(atAirport({ lat: 1.3530, lng: 103.9450 }), false, 'Tampines');
  assert.equal(atAirport(null), false);
  assert.deepEqual(rounded({ lat: 1.354321, lng: 103.987654 }), { lat: 1.35, lng: 103.99 });
});

test('Window bands use trips near you around this hour, else all areas', async () => {
  const { bandOutlook } = await import('../public/formula.js');
  const at = (iso) => Date.parse(iso);
  const TAMPINES = { lat: 1.353, lng: 103.945 };
  const ORCHARD = { lat: 1.304, lng: 103.832 };
  const normal = [[5, 12], [9, 15], [14, 30], [20, 26], [28, 45], [7, 20], [33, 40], [12, 14]]
    .map(([km, min], i) => make(km, min, { ts: at(`2026-11-1${7 + (i % 3)}T12:${String(i).padStart(2, '0')}:00+08:00`) }));
  // Orchard at 02:30 ran 30% above normal; nothing near Tampines then.
  const orchard = [[10, 20], [15, 25], [8, 18], [22, 30]].map(([km, min], i) => {
    const t = make(km, min, { ts: at(`2026-11-${17 + i}T02:30:00+08:00`), ...ORCHARD });
    return { ...t, actual: Math.round(t.actual * 1.3 * 100) / 100 };
  });
  const trips = [...normal, ...orchard];
  const when = at('2026-11-22T02:30:00+08:00');
  const inOrchard = bandOutlook(trips, when, ORCHARD);
  assert.equal(inOrchard[0].scope, 'here');
  assert.ok(inOrchard.every((b) => b.state === 'good'), JSON.stringify(inOrchard.map((b) => b.vs)));
  const inTampines = bandOutlook(trips, when, TAMPINES);
  assert.equal(inTampines[0].scope, 'nearest', 'nothing within 3 km: leans on the closest available data');
  assert.ok(inTampines[0].now > inTampines[0].normal, 'Orchard\'s busy night still nudges Tampines up a little');
  assert.ok(inTampines[0].vs < inOrchard[0].vs, 'but far less than in Orchard');
  // The estimate moves with the clock, minute by minute, toward the closest data in time.
  const later = [0, 30, 60, 90, 120].map((m) => bandOutlook(trips, when + m * 60000, ORCHARD)[1].now);
  assert.ok(later[0] > later[4], `fades as 02:30 recedes: ${later.join(', ')}`);
  assert.ok(later.every((v, i) => i === 0 || v <= later[i - 1] + 1e-9), 'smoothly, no jumps up');
});

test('quick Got a job entries (km + earnings only) move "now" for the area, not the formula', async () => {
  const { bandOutlook, latestJob } = await import('../public/formula.js');
  const at = (iso) => Date.parse(iso);
  const TAMPINES = { lat: 1.353, lng: 103.945 };
  const normal = [[5, 12], [9, 15], [14, 30], [20, 26], [28, 45], [7, 20], [33, 40], [12, 14]]
    .map(([km, min], i) => make(km, min, { ts: at(`2026-11-1${7 + (i % 3)}T12:${String(i).padStart(2, '0')}:00+08:00`) }));
  const now = at('2026-11-24T02:40:00+08:00');
  const before = bandOutlook(normal, now, TAMPINES);
  // Two quick entries in the last 20 minutes near Tampines, both paying well above normal earnings.
  const quickJobs = [[21, 20], [12, 15]].map(([km, earned], i) => ({
    id: `quick${i}xxxx`, quick: true, ts: now - (10 + i * 10) * 60000, km, min: null, erp: 0, actual: null, earned, surge: 'normal', ...TAMPINES,
  }));
  const after = bandOutlook([...normal, ...quickJobs], now, TAMPINES);
  assert.equal(after[0].scope, 'here');
  assert.equal(after[0].recent, 2);
  assert.ok(after.every((b, i) => b.now > before[i].now), 'recent good jobs lift "now"');
  // The formula and the cut ignore quick entries.
  assert.equal(fitWeights([...normal, ...quickJobs]).base, fitWeights(normal).base);
  assert.equal(fitCommission([...normal, ...quickJobs]).n, fitCommission(normal).n);
  const j = latestJob([...normal, ...quickJobs], now);
  assert.equal(j.trip.km, 21);
  assert.equal(j.earned, 20);
  assert.ok(j.vs > 0.1, `latest job vs normal ${j.vs}`);
});

test('each Window band leans on trips of its own distance', async () => {
  const { bandOutlook } = await import('../public/formula.js');
  const at = (iso) => Date.parse(iso);
  const normal = [[5, 12], [9, 15], [14, 30], [20, 26], [28, 45], [7, 20], [33, 40], [12, 14]]
    .map(([km, min], i) => make(km, min, { ts: at(`2026-11-1${7 + (i % 3)}T12:${String(i).padStart(2, '0')}:00+08:00`) }));
  // Tonight: short trips paying 35% over normal, long trips normal.
  const now = at('2026-11-22T03:50:00+08:00');
  const shortHot = [4, 6, 7, 5].map((km, i) => {
    const t = make(km, km * 1.5 + 4, { ts: now - (20 + 15 * i) * 60000 });
    return { ...t, actual: Math.round(t.actual * 1.35 * 100) / 100 };
  });
  const longCalm = [24, 28, 22].map((km, i) => make(km, km + 6, { ts: now - (25 + 20 * i) * 60000 }));
  const b = bandOutlook([...normal, ...shortHot, ...longCalm], now);
  assert.equal(b[0].state, 'good', `short: ${b[0].vs}`);
  assert.equal(b[2].state, 'normal', `long: ${b[2].vs}`);
  assert.ok(b[0].vs > b[1].vs && b[1].vs > b[2].vs, `ordered: ${b.map((x) => x.vs.toFixed(3)).join(', ')}`);
  assert.deepEqual([b[0].inBandNear, b[1].inBandNear, b[2].inBandNear], [4, 0, 3]);
});

test('remembered results equal fresh ones, and a new trip is always taken into account', async () => {
  const { looError, timeEstimator, LOO_MAX } = await import('../public/formula.js');
  const trips = [[5, 12], [9, 15], [14, 30], [20, 26], [28, 45], [7, 20]].map(([km, min]) => make(km, min));
  const a = fitWeights(trips);
  const b = fitWeights(trips);
  assert.equal(a, b, 'same trips array: the same remembered result');
  assert.deepEqual(fitWeights([...trips]), a, 'a fresh copy of the same trips gives the same numbers');
  assert.deepEqual(fitCommission([...trips]), fitCommission(trips));
  assert.equal(timeEstimator(trips)(10), timeEstimator([...trips])(10));
  // The page hands out a new array when a trip is added: it counts straight away.
  const more = [...trips, make(40, 50, { actual: 60 })];
  assert.notDeepEqual(fitWeights(more), a);
  // The accuracy stat tests every trip up to LOO_MAX.
  assert.equal(looError(trips).n, 6);
  assert.equal(LOO_MAX, 200);
});

test('speed: 3,000 trips stay quick once remembered', async () => {
  const { bandOutlook, looError } = await import('../public/formula.js');
  const now = Date.parse('2026-11-22T02:00:00+08:00');
  const many = Array.from({ length: 3000 }, (_, i) => {
    const km = 2 + (i % 35);
    return make(km, km * 1.2 + 4, { ts: now - i * 7 * 60000, lat: 1.3 + (i % 20) / 200, lng: 103.8 + (i % 30) / 200 });
  });
  let t0 = performance.now();
  looError(many);
  const firstLoo = performance.now() - t0;
  t0 = performance.now();
  looError(many);
  const againLoo = performance.now() - t0;
  bandOutlook(many, now, { lat: 1.32, lng: 103.86 });
  t0 = performance.now();
  for (let m = 0; m < 10; m++) bandOutlook(many, now + m * 60000, { lat: 1.32, lng: 103.86 });
  const perMinute = (performance.now() - t0) / 10;
  assert.ok(againLoo < 5, `remembered accuracy stat ${againLoo.toFixed(1)} ms`);
  assert.ok(perMinute < 150, `Window refresh with 3,000 trips ${perMinute.toFixed(1)} ms`);
  console.log(`# 3,000 trips: accuracy stat first ${firstLoo.toFixed(0)} ms, then ${againLoo.toFixed(2)} ms; Window refresh ${perMinute.toFixed(1)} ms`);
});

// ---- events: a concert night must not make the area look busy on normal nights ----
import { markEvents, eventLift, eventFor, timeOfDay as tod2 } from '../public/formula.js';
test('trips around an event are kept out of normal and learned on their own', () => {
  const stadium = { id: 'ev-1', name: 'Concert', lat: 1.304, lng: 103.8746, ends_at: new Date('2026-11-21T22:30:00+08:00').getTime() };
  const near = { lat: 1.30, lng: 103.87 }; // about 0.6 km from the stadium
  const day = (d, h, m = 0) => new Date(`2026-11-${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`).getTime();
  // normal nights: fares at the formula. Concert night: +30%.
  const normal = [14, 15, 17, 18].map((d) => make(10, 20, { ts: day(d, 22, 45), ...near }));
  const concert = [0, 10, 20, 40].map((m) => {
    const t = make(10, 20, { ts: day(21, 22, 40) + m * 60000, ...near });
    return { ...t, actual: Math.round(t.actual * 1.3 * 100) / 100, earned: Math.round(t.earned * 1.3 * 100) / 100 };
  });
  const later = make(10, 20, { ts: day(22, 1, 0), ...near }); // 2.5 h after the end: not the event
  const all = [...normal, ...concert, later];
  assert.equal(eventFor(concert[0], [stadium]).id, 'ev-1');
  assert.equal(eventFor(later, [stadium]), null);
  assert.equal(eventFor({ ...concert[0], lat: 1.35, lng: 103.94 }, [stadium]), null, 'far away: not the event');

  const marked = markEvents(all, [stadium]);
  assert.equal(marked.filter((t) => t.event).length, 4);
  const nextSat = day(28, 22, 45);
  const withEvents = tod2(marked, nextSat, near);
  const without = tod2(normal.concat(later), nextSat, near);
  assert.ok(Math.abs(withEvents.lift - without.lift) < 1e-9, `normal unchanged: ${withEvents.lift} vs ${without.lift}`);
  // and the formula itself isn't pulled up by the concert fares
  const w1 = fitWeights(marked);
  const w0 = fitWeights(normal.concat(later));
  assert.deepEqual(w1, w0);
  const ev = eventLift(marked);
  assert.equal(ev.n, 4);
  assert.ok(ev.lift > 0.15 && ev.lift < 0.3, `event lift ${ev.lift}`);
  // unmarked, the same trips would have pushed the normal fare up
  const fare = (w) => passengerFare(w, 10, 20).fare;
  assert.ok(fare(fitWeights(all)) > fare(w0) + 0.2, `${fare(fitWeights(all))} vs ${fare(w0)}`);
});

// ---- From JB timetables ----
import { KTM_ARRIVALS, CW5_FROM_WOODLANDS, nextTimes, busNow } from '../public/jb.js';
test('From JB: next KTM arrivals, bus intervals by time of day', () => {
  const at = (h, m) => { const d = new Date(2026, 10, 18, h, m); return d; };
  assert.equal(KTM_ARRIVALS.length, 18);
  assert.deepEqual(nextTimes(KTM_ARRIVALS, at(8, 0)).next, ['08:50', '10:05', '11:35']);
  assert.deepEqual(nextTimes(KTM_ARRIVALS, at(22, 50)).next, ['22:50']);
  const late = nextTimes(KTM_ARRIVALS, at(23, 10));
  assert.equal(late.done, true);
  assert.equal(late.first, '05:05');
  assert.deepEqual(nextTimes(CW5_FROM_WOODLANDS, at(16, 31)).next, ['16:45', '17:00', '17:15']);
  assert.equal(busNow('CW1', at(7, 0)).every, 'about every 5 min');
  assert.equal(busNow('CW1', at(13, 0)).every, 'every 15–30 min');
  assert.equal(busNow('CW1', at(2, 0)).running, false);
  assert.equal(busNow('CW2', at(2, 0)).every, 'every 30 min (night)');
  assert.equal(busNow('CW5', at(23, 0)).running, false);
});

import { jbNext, jbPlace, JB_EST } from '../public/jb.js';
test('From JB: one line per route with a best-estimate time out in Singapore', () => {
  const at = (h, m) => new Date(2026, 10, 18, h, m);
  const r = Object.fromEntries(jbNext(at(8, 0)).map((x) => [x.id, x]));
  assert.equal(r.ktm.what, 'Train arrives 08:50');
  assert.equal(r.ktm.woodlands, '09:05'); // + immigration
  // 08:00 is the morning rush into Singapore: JB -> out of Woodlands takes longer
  assert.equal(r.CW1.woodlands, `0${8 + Math.floor(JB_EST.jbToWoodlandsHeavy / 60)}:${String(JB_EST.jbToWoodlandsHeavy % 60).padStart(2, '0')}`);
  assert.equal(r.CW5.what, 'Next leaves Woodlands 08:10');
  const night = Object.fromEntries(jbNext(at(23, 30)).map((x) => [x.id, x]));
  assert.equal(night.ktm.dropAt, null);
  assert.equal(night.CW2.dropAt, '00:25'); // runs all night, past midnight
  assert.equal(jbPlace({ lat: 1.4452, lng: 103.7690 }).id, 'woodlands');
  assert.equal(jbPlace({ lat: 1.4253, lng: 103.7622 }).id, 'kranji');
  assert.equal(jbPlace({ lat: 1.3526, lng: 103.9447 }), null);
});

import { queueWait, updatedText } from '../public/queue.js';
test('airport queue: estimated wait from the latest reading, else the usual for this hour', () => {
  const t0 = new Date(2026, 10, 18, 20, 0).getTime();
  const m = 60000;
  // past nights around 8pm: Grab said 30, people really waited 40 (x1.33); 40 cars -> 1 min/car
  const past = [1, 2, 3].map((d) => ({ ts: t0 - d * 86400000, cars: 40, est: 30, actual: 40 }));
  const fresh = { ts: t0 - 10 * m, cars: 30, est: 21, actual: null };
  const w = queueWait([...past, fresh], t0);
  assert.equal(w.basis, 'latest');
  assert.equal(w.min, 28); // 21 x 1.33
  assert.equal(w.at, fresh.ts);
  assert.equal(w.corrected, true);
  // only a car count: minutes per car from real waits
  assert.equal(queueWait([...past, { ts: t0 - 5 * m, cars: 15 }], t0).min, 15);
  // nothing recent: the usual around this hour (real waits)
  const old = queueWait(past, t0);
  assert.equal(old.basis, 'usual');
  assert.equal(old.min, 40);
  assert.equal(old.at, past[0].ts);
  assert.equal(queueWait([], t0), null);
  assert.equal(updatedText(t0 - 12 * m, t0), '12 min ago');
});

import { ferryArrivals, ferryTerminalAt } from '../public/ferries.js';
test('ferries: Indonesian departures become Singapore arrival times', () => {
  // Wed 18 Nov 2026, 07:00 Singapore
  const now = new Date(2026, 10, 18, 7, 0);
  const next = ferryArrivals('tmft', now);
  // Batam Fast Nongsapura 06:00 WIB = 07:00 SGT, + 60 min -> 08:00
  assert.equal(next[0].arrive, '08:00');
  assert.equal(next[0].from, 'Nongsapura (Batam)');
  // BRF 08:35 Bintan time = 09:35 SGT + 70 -> 10:45
  assert.ok(next.some((a) => a.from.startsWith('Bintan') && a.arrive === '10:45'));
  // Majestic Tanjung Pinang runs weekends only: none on a Wednesday
  assert.ok(!next.some((a) => a.op === 'Majestic' && a.from === 'Tanjung Pinang' && a.at.getDate() === 18));
  // Batam Fast 07:45 runs Thu-Sun: not today, but tomorrow (Thursday)
  assert.ok(!next.some((a) => a.departWib === '07:45' && a.at.getDate() === 18));
  assert.ok(next.some((a) => a.departWib === '07:45' && a.at.getDate() === 19));
  assert.equal(ferryTerminalAt({ lat: 1.3157, lng: 103.9893 }).id, 'tmft');
  assert.equal(ferryTerminalAt({ lat: 1.3526, lng: 103.9447 }), null);
});

import { jbSoonest, JB_PLACES } from '../public/jb.js';
test('Radar shows only what is immediately next, within the hour', () => {
  const at = (h, m) => new Date(2026, 10, 18, h, m);
  const W = JB_PLACES.find((p) => p.id === 'woodlands');
  const K = JB_PLACES.find((p) => p.id === 'kranji');
  // 22:30 at Woodlands: CW1/CW2 buses (out ~22:50) beat the 22:50 train (out ~23:05)
  assert.equal(jbSoonest(at(22, 30), W).id !== 'ktm', true);
  // 02:00 at Kranji: CW1 isn't running and nothing comes within the hour -> nothing
  assert.equal(jbSoonest(at(2, 0), K), null);
  const N = JB_PLACES.find((p) => p.id === 'newton');
  // 23:30 at Newton: CW5 done for the day -> nothing
  assert.equal(jbSoonest(at(23, 30), N), null);
});

test('ferries into HarbourFront: crossing times and interlined sailings shown once', () => {
  const now = new Date(2026, 10, 18, 7, 0); // Wednesday 07:00
  const next = ferryArrivals('hfc', now);
  // Batam Centre 06:00 WIB -> 07:00 SGT + 70 = 08:10, listed by Batam Fast, Majestic and Sindo: one row
  const btc = next.filter((a) => a.from === 'Batam Centre' && a.arrive === '08:10' && a.at.getDate() === 18);
  assert.equal(btc.length, 1);
  assert.match(btc[0].op, /Batam Fast/);
  assert.match(btc[0].op, /Majestic/);
  // Sekupang 06:00 -> 07:50; Harbour Bay 06:00 -> 08:00
  assert.ok(next.some((a) => a.from.startsWith('Sekupang') && a.arrive === '07:50'));
  assert.ok(next.some((a) => a.from.startsWith('Harbour Bay') && a.arrive === '08:00'));
  assert.equal(ferryTerminalAt({ lat: 1.2652, lng: 103.8207 }).id, 'hfc');
});

import { surgeSpots, surgeFor } from '../public/surge.js';
test('likely surging: 2+ drivers within 1.5 km in 30 min; shown to drivers within 3 km', () => {
  const now = Date.now();
  const m = 60000;
  const orchard = { lat: 1.304, lng: 103.832 };
  const one = [{ ...orchard, ts: now - 5 * m, d: 'a' }, { lat: 1.305, lng: 103.833, ts: now - 2 * m, d: 'a' }];
  assert.deepEqual(surgeSpots(one, now), [], 'one driver twice is not enough');
  const two = [...one, { lat: 1.30, lng: 103.83, ts: now - 8 * m, d: 'b' }];
  const spots = surgeSpots(two, now);
  assert.equal(spots.length, 1);
  assert.equal(spots[0].drivers, 2);
  assert.equal(spots[0].latest, now - 2 * m);
  const stale = two.map((p) => ({ ...p, ts: p.ts - 40 * m }));
  assert.deepEqual(surgeSpots(stale, now), [], 'older than 30 min: gone');
  const far = [{ ...orchard, ts: now, d: 'a' }, { lat: 1.35, lng: 103.94, ts: now, d: 'b' }];
  assert.deepEqual(surgeSpots(far, now), [], 'two drivers far apart are two different places');
  // who sees it
  const newton = { lat: 1.3123, lng: 103.8393 }; // ~1.2 km from Orchard
  const tiongBahru = { lat: 1.2858, lng: 103.8273 }; // ~2 km
  const tampines = { lat: 1.3526, lng: 103.9447 }; // ~13 km
  assert.equal(surgeFor(newton, spots).inside, true);
  assert.equal(surgeFor(tiongBahru, spots).inside, false);
  assert.ok(surgeFor(tiongBahru, spots).km < 3);
  assert.equal(surgeFor(tampines, spots), null);
});

import { inAirportZone } from '../public/airport-zone.js';
test('the airport zone is the airport, not the rest of Changi', () => {
  for (const [name, lat, lng] of [['T1', 1.3614, 103.9894], ['T2', 1.3554, 103.9908], ['T3', 1.3566, 103.9863], ['T4', 1.3381, 103.9832], ['Jewel', 1.3603, 103.9894]]) {
    assert.equal(inAirportZone(lat, lng), true, name);
  }
  for (const [name, lat, lng] of [['Changi Village', 1.3893, 103.9878], ['Changi Prison', 1.3560, 103.9740], ['Changi Business Park', 1.3343, 103.9636],
    ['Simei', 1.3432, 103.9533], ['Expo', 1.3352, 103.9584], ['Tanah Merah Ferry Terminal', 1.3155, 103.9890], ['Changi Exhibition Centre', 1.3346, 104.0157]]) {
    assert.equal(inAirportZone(lat, lng), false, name);
  }
});

import { radarAlerts } from '../public/alerts.js';
test('Radar alerts: major MRT disruption anywhere, floods only within 3 km', () => {
  const lta = { train: { major: true, lines: [{ line: 'NEL' }], messages: ['No train service between Harbourfront and Dhoby Ghaut'] },
    floods: [{ headline: 'Flash Flood Alert', desc: 'Flash flood at Bt Timah Rd', lat: 1.3305, lng: 103.8006 }] };
  const near = radarAlerts(lta, { lat: 1.3200, lng: 103.8100 }); // ~1.6 km
  assert.deepEqual(near.map((a) => a.kind), ['mrt', 'flood']);
  const far = radarAlerts(lta, { lat: 1.3526, lng: 103.9447 }); // Tampines
  assert.deepEqual(far.map((a) => a.kind), ['mrt']);
  assert.deepEqual(radarAlerts({ train: { major: false, lines: [], messages: [] }, floods: [] }, null), []);
});

import { bandOutlook as bo2, eventNear } from '../public/formula.js';
test('event mode on the cards: Event pill, event prices; normal prices unchanged', () => {
  const ends = new Date('2026-11-21T22:30:00+08:00').getTime();
  const stadium = { id: 'ev-9', name: 'Concert', venue_name: 'National Stadium', lat: 1.304, lng: 103.8746, ends_at: ends };
  const at = { lat: 1.30, lng: 103.87 };
  const normal = [14, 15, 17].map((d) => make(10, 20, { ts: new Date(`2026-11-${d}T22:45:00+08:00`).getTime(), ...at }));
  const ev = [0, 10, 20].map((m) => { const t = make(10, 20, { ts: ends + m * 60000, ...at, event: 'ev-9' }); return { ...t, actual: t.actual * 1.3, earned: t.earned * 1.3 }; });
  const trips = [...normal, ...ev];
  const off = bo2(trips, ends, at);
  const on = bo2(trips, ends, at, { event: stadium });
  assert.ok(on.every((b) => b.state === 'event' && b.eventTrips === 3));
  assert.ok(on[1].now > off[1].now, 'event price above');
  assert.deepEqual(on.map((b) => b.normal), off.map((b) => b.normal), 'normal prices the same');
  assert.deepEqual(on.map((b) => b.surge), off.map((b) => b.surge), 'surge prices the same');
  // banner: within 3 km, from an hour before the end to 90 min after
  assert.equal(eventNear([stadium], { lat: 1.3100, lng: 103.8600 }, ends - 30 * 60000).event.id, 'ev-9');
  assert.equal(eventNear([stadium], { lat: 1.3100, lng: 103.8600 }, ends - 2 * 3600000), null, 'too early');
  assert.equal(eventNear([stadium], { lat: 1.3526, lng: 103.9447 }, ends), null, 'too far');
});

// ---- safeguards against wrong or made-up data ----
import { plausible, isOutlier } from '../public/sanity.js';
import { timeOfDay as tod3, fitWeights as fw3 } from '../public/formula.js';
test('layer 1: impossible trips are refused, real ones (surge, low cut) are not', () => {
  assert.equal(plausible({ km: 10, paid: 99, earned: 72 }).ok, false, '10 km at S$99');
  assert.equal(plausible({ km: 10, paid: 14, earned: 10.2 }).ok, true);
  assert.equal(plausible({ km: 10, paid: 28, earned: 20.4 }).ok, true, '2x surge');
  // big surges: saved after a second tap (the two real jobs that were blocked), never refused
  for (const [km, paid, earned] of [[5.38, 29, 22], [3.35, 21.9, 15.9]]) {
    const r = plausible({ km, paid, earned });
    assert.equal(r.ok, true, `${km} km at S$${paid}`);
    assert.ok(r.unusual, 'asks for a second tap');
  }
  assert.equal(plausible({ km: 10, paid: 14, earned: 10.2 }).unusual, undefined);
  assert.equal(plausible({ km: 10, paid: 23.9, earned: 23.8 }).ok, true, 'low-cut job');
  assert.equal(plausible({ km: 10, paid: 14, earned: 15 }).ok, false, 'earned more than paid');
  assert.equal(plausible({ km: 10, paid: 20, earned: 4 }).ok, false, 'below the driver minimum');
  assert.equal(plausible({ km: 30, min: 5, paid: 35, earned: 25 }).ok, false, '30 km in 5 min');
  assert.equal(plausible({ km: 1.2, paid: 8.1, earned: 6.2 }).ok, true, 'minimum fares');
  assert.equal(isOutlier(25, 15), true);
  assert.equal(isOutlier(17, 15), false);
});

test('layers 3 and 4: a troll in one area cannot take over "now", and wrong fares cannot bend the rates', () => {
  const day = (d, h) => new Date(`2026-11-${d}T${String(h).padStart(2, '0')}:10:00+08:00`).getTime();
  const at = { lat: 1.30, lng: 103.83 };
  const honest = [11, 12, 13, 14, 15, 16].map((d, i) => ({ ...make(8 + i, 15 + i, { ts: day(d, 20), ...at }), shared: true, d: `driver${i % 3}` }));
  const base = tod3(honest, day(18, 20), at).lift;
  // one phone sends 20 jobs at +55% (inside the limits)
  const troll = Array.from({ length: 20 }, (_, i) => { const t = make(9, 16, { ts: day(17, 20) + i * 60000, ...at }); return { ...t, id: `t${i}`, actual: Math.round(t.actual * 1.55 * 100) / 100, earned: Math.round(t.earned * 1.55 * 100) / 100, shared: true, d: 'troll' }; });
  const withTroll = tod3([...honest, ...troll], day(18, 20), at).lift;
  assert.ok(withTroll - base < 0.25, `one phone moved "now" by ${(withTroll - base).toFixed(2)}`);
  // without the cap the same 20 jobs would push it much further
  const uncapped = tod3([...honest, ...troll.map((t, i) => ({ ...t, d: `fake${i}` }))], day(18, 20), at).lift;
  assert.ok(uncapped > withTroll + 0.05);
  // a handful of very wrong fares among good ones barely moves the fitted rates
  const good = [[5, 12], [9, 15], [14, 30], [20, 26], [28, 45], [7, 20], [33, 40], [12, 14], [18, 35], [25, 30], [40, 50], [3, 9], [16, 22], [22, 31]].map(([k, mm]) => make(k, mm));
  const bad = [[10, 15], [15, 20], [8, 12]].map(([k, mm]) => { const t = make(k, mm); return { ...t, actual: t.actual * 2.2 }; });
  const clean = passengerFare(fw3(good, { includeBase: false }), 15, 22).fare;
  const dirty = passengerFare(fw3([...good, ...bad], { includeBase: false }), 15, 22).fare;
  assert.ok(Math.abs(dirty / clean - 1) < 0.06, `rates bent by ${((dirty / clean - 1) * 100).toFixed(1)}%`);
});

test('earned trust: a reliable driver on a shift (many jobs in one zone) counts nearly fully; a new one stays capped', () => {
  const day = (d, h, mi = 10) => new Date(`2026-11-${d}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00+08:00`).getTime();
  const at = { lat: 1.30, lng: 103.83 };
  const others = [11, 13].map((d, i) => ({ ...make(8, 15, { ts: day(d, 19), ...at }), shared: true, d: `other${i}` }));
  // 8 short jobs in two hours around Orchard at peak, all +25% (a busy evening)
  const shift = (trusted) => Array.from({ length: 8 }, (_, i) => { const t = make(4 + (i % 3), 10, { ts: day(18, 18, 0) + i * 14 * 60000, ...at }); return { ...t, id: `s${i}`, actual: null, earned: Math.round(t.earned * 1.25 * 100) / 100, shared: true, d: 'shift', trusted }; }); // earnings only: moves "now", not the formula
  const now = day(18, 20, 0);
  const full = tod3([...others, ...shift(true).map((t, i) => ({ ...t, d: `solo${i}` }))], now, at).lift; // as if uncapped
  const trusted = tod3([...others, ...shift(true)], now, at).lift;
  const fresh = tod3([...others, ...shift(false)], now, at).lift;
  assert.ok(full > 0.1, `the busy evening shows: ${full.toFixed(3)}`);
  assert.ok(trusted > 0.95 * full, `trusted shift driver counts fully: ${trusted.toFixed(3)} of ${full.toFixed(3)}`);
  assert.ok(fresh < 0.8 * full, `a new driver with the same jobs stays capped: ${fresh.toFixed(3)}`);
});

// ---- day patterns: kinds of night, and the owner's experience as the starting point ----
import { dayType, experienceLift } from '../public/daypattern.js';
import { timeOfDay as tod4 } from '../public/formula.js';
test('kinds of night: after midnight belongs to the night before; Fri = Sat = eve of a public holiday', () => {
  const t = (iso) => Date.parse(`${iso}+08:00`);
  assert.equal(dayType(t('2026-11-19T01:30:00')), 'wed', 'Thursday 1:30 am is Wednesday night');
  assert.equal(dayType(t('2026-11-20T23:00:00')), 'weekend', 'Friday night');
  assert.equal(dayType(t('2026-11-22T02:00:00')), 'weekend', 'Sunday 2 am is Saturday night');
  assert.equal(dayType(t('2026-11-22T22:00:00')), 'sun');
  assert.equal(dayType(t('2026-11-17T22:00:00')), 'early', 'Tuesday');
  assert.equal(dayType(t('2026-11-19T22:00:00')), 'thu');
  assert.equal(dayType(t('2026-12-24T22:00:00')), 'weekend', 'Christmas Eve (a Thursday) is like a weekend');
  assert.equal(dayType(t('2026-12-25T15:00:00')), 'ph', 'Christmas Day');
  assert.equal(dayType(t('2027-02-08T15:00:00')), 'ph', 'CNY observed Monday');
});

test('starting guesses: busy times +10%, the rest normal', () => {
  const t = (iso) => Date.parse(`${iso}+08:00`);
  const ORCHARD = { lat: 1.3048, lng: 103.8318 };
  const CQ = { lat: 1.2888, lng: 103.8467 };
  const TAMPINES = { lat: 1.3526, lng: 103.9447 };
  assert.equal(experienceLift(t('2026-11-18T03:00:00'), ORCHARD), 0.1, 'Tue night club closing, Orchard 3 am');
  assert.equal(experienceLift(t('2026-11-18T03:00:00'), TAMPINES), 0, 'not a club area');
  assert.equal(experienceLift(t('2026-11-18T03:30:00'), ORCHARD), 0, 'after the weekday closing window');
  assert.equal(experienceLift(t('2026-11-21T02:55:00'), ORCHARD), 0.1, 'Friday night: weekday closing time (and a weekend night anyway)');
  assert.equal(experienceLift(t('2026-11-22T04:00:00'), ORCHARD), 0.1, 'Saturday night closing, 4 am');
  assert.equal(experienceLift(t('2026-11-19T01:00:00'), CQ), 0.1, 'Wednesday ladies\' night, Clarke Quay');
  assert.equal(experienceLift(t('2026-11-19T01:00:00'), TAMPINES), 0, 'ladies\' night is in the bar areas');
  assert.equal(experienceLift(t('2026-11-20T23:00:00'), TAMPINES), 0.1, 'Friday night anywhere');
  assert.equal(experienceLift(t('2026-11-17T22:00:00'), TAMPINES), 0, 'Monday/Tuesday night: normal, not lower');
  assert.equal(experienceLift(t('2026-11-17T18:30:00'), TAMPINES), 0.1, 'weekday after work');
  assert.equal(experienceLift(t('2026-11-17T12:30:00'), TAMPINES), 0, 'weekday lunch: normal');
  assert.equal(experienceLift(t('2026-12-25T18:30:00'), TAMPINES), 0, 'public holiday: not after-work');
  assert.equal(experienceLift(t('2026-11-22T22:00:00'), TAMPINES), 0, 'Sunday night: data decides');
  assert.equal(experienceLift(t('2026-11-23T03:00:00'), ORCHARD), 0.1, 'Sunday night (Monday 3 am) closing, ~3 am');
  assert.equal(experienceLift(t('2026-12-25T04:00:00'), ORCHARD), 0.1, 'Christmas Eve night (eve of PH): ~4 am');
  assert.equal(experienceLift(t('2026-12-26T03:30:00'), ORCHARD), 0.1, 'Christmas night (PH): 02:45-03:45');
  assert.equal(experienceLift(t('2026-12-26T04:00:00'), ORCHARD), 0, 'PH night: over by 03:45');
});

test('a busy Friday night counts fully for Saturday night, only partly for Tuesday night', () => {
  const at = { lat: 1.30, lng: 103.83 };
  const fri = [0, 1, 2].map((i) => ({ ...make(10, 18, { ts: Date.parse(`2026-11-13T23:${10 + i * 10}:00+08:00`), ...at }), actual: null, earned: 14 + i * 0.2, id: `f${i}` }));
  const satLift = tod4(fri, Date.parse('2026-11-21T23:30:00+08:00'), at).lift;
  const tueLift = tod4(fri, Date.parse('2026-11-17T23:30:00+08:00'), at).lift;
  assert.ok(satLift > tueLift + 0.05, `Saturday ${satLift.toFixed(3)} vs Tuesday ${tueLift.toFixed(3)}`);
});

import { holidayTag } from '../public/daypattern.js';
test('header tag: PH on a public holiday, PH Eve the day before, by calendar day', () => {
  const t = (iso) => Date.parse(`${iso}+08:00`);
  assert.equal(holidayTag(t('2026-12-25T10:00:00')), 'PH');
  assert.equal(holidayTag(t('2026-12-24T23:59:00')), 'PH Eve');
  assert.equal(holidayTag(t('2026-11-18T12:00:00')), '');
  assert.equal(holidayTag(t('2026-11-08T12:00:00')), 'PH', 'Deepavali (Sunday)');
  assert.equal(holidayTag(t('2026-11-09T12:00:00')), 'PH', 'Deepavali observed Monday');
  assert.equal(holidayTag(t('2026-11-07T12:00:00')), 'PH Eve');
});

test('test: surge is told by the price, not the green arrow', async () => {
  const { surgeLift, isSurgeTrip, SURGE_BY_PRICE, fitWeights: fw, timeEstimator: te, withBase: wb, fitCommission: fc } = await import('../public/formula.js');
  assert.equal(SURGE_BY_PRICE, true);
  const at = (iso) => Date.parse(iso);
  const plain = [[5, 12], [9, 15], [14, 30], [20, 26], [28, 45], [7, 20], [33, 40], [12, 14]]
    .map(([km, min], i) => make(km, min, { ts: at(`2026-11-1${7 + (i % 3)}T12:${String(i).padStart(2, '0')}:00+08:00`) }));
  // Most jobs show the arrow but paid normal: tagged Surge, priced normal -> they teach the normal price.
  const arrowNormal = [[10, 20], [15, 25], [8, 18], [22, 30]].map(([km, min]) => make(km, min, { surge: 'surge' }));
  // Two really paid more (+35%, +50%).
  const high = [[11, 20, 1.35], [16, 28, 1.5]].map(([km, min, x]) => { const t = make(km, min, { surge: 'surge', ts: at('2026-11-19T18:10:00+08:00') }); return { ...t, actual: Math.round(t.actual * x * 100) / 100 }; });
  const all = [...plain, ...arrowNormal, ...high];
  const w = fw(all, { includeBase: false });
  const w0 = fw(plain, { includeBase: false });
  assert.ok(Math.abs(w.perKm - w0.perKm) < 0.02 && Math.abs(w.base - w0.base) < 0.3, 'the high ones don\'t move normal');
  assert.ok(w.n === plain.length + arrowNormal.length, `arrow-but-normal trips are used: ${w.n}`);
  const W = fw(all); const est = te(wb(all)); const c = fc(all);
  assert.deepEqual(all.map((t) => isSurgeTrip(t, W, est, c)).filter(Boolean).length, 2);
  // An untagged job that paid well above normal counts as surge too.
  const untagged = { ...high[0], surge: 'normal' };
  assert.equal(isSurgeTrip(untagged, W, est, c), true);
  // Surge on the cards: the range surge jobs have paid.
  const s = surgeLift(all, at('2026-11-20T18:00:00+08:00'));
  assert.equal(s.n, 2);
  // 2 of 3: blended two-thirds toward +35%..+50% from the starting +15%..+40%
  assert.ok(s.range.lo > 0.25 && s.range.lo < 0.3 && s.range.hi > 0.44 && s.range.hi < 0.48, JSON.stringify(s.range));
  // None yet: a starting range of +15% to +40%.
  assert.deepEqual(surgeLift(plain, Date.now()).range, { lo: 0.15, hi: 0.4, guess: true });
});

test('green arrow test: jobs logged with and without the arrow, each vs the normal price', async () => {
  const { arrowCompare } = await import('../public/formula.js');
  const plain = [[5, 12], [9, 15], [14, 30], [20, 26], [28, 45], [7, 20]].map(([km, min]) => make(km, min, { arrow: 0 }));
  const withArrow = [[10, 20, 1.0], [15, 25, 1.02], [8, 18, 1.4]].map(([km, min, x]) => { const t = make(km, min, { arrow: 1 }); return { ...t, actual: Math.round(t.actual * x * 100) / 100 }; });
  const old = [make(12, 22, { surge: 'surge' }), make(6, 14)];
  const a = arrowCompare([...plain, ...withArrow, ...old]);
  assert.equal(a.logged.arrow.n, 3);
  assert.equal(a.logged.none.n, 6);
  assert.equal(a.logged.arrow.over15, 1, 'one of the three arrow jobs really paid more');
  assert.ok(a.logged.arrow.lift > 0.05 && a.logged.arrow.lift < 0.2);
  assert.ok(Math.abs(a.logged.none.lift) < 0.03);
  assert.deepEqual([a.older.arrow.n, a.older.none.n], [1, 1], 'old Surge / Normal tags counted apart');
});

test('fresh surge in one area does not light up another 6 km away (the "just now" boost is local)', async () => {
  const { timeOfDay } = await import('../public/formula.js');
  const now = Date.parse('2026-11-19T22:00:00+08:00');
  const rv = { lat: 1.2935, lng: 103.8370 }; // River Valley
  const tpy = { lat: 1.3343, lng: 103.8563 }; // Toa Payoh, ~5 km away
  const older = Array.from({ length: 8 }, (_, i) => make(8 + i, 15 + i, { ts: now - (7 + i) * 86400000, lat: tpy.lat, lng: tpy.lng }));
  const fresh = Array.from({ length: 4 }, (_, i) => { const t = make(9 + i, 18, { ts: now - (5 + i * 3) * 60000, lat: rv.lat, lng: rv.lng }); return { ...t, actual: Math.round(t.actual * 1.5 * 100) / 100 }; });
  const atRv = timeOfDay([...older, ...fresh], now, rv).lift;
  const atTpy = timeOfDay([...older, ...fresh], now, tpy).lift;
  assert.ok(atRv > 0.2, `River Valley sees its surge: ${atRv}`);
  assert.ok(atTpy < 0.12, `Toa Payoh barely moves: ${atTpy}`);
});

test('apps: TADA learns on its own (its receipts, its flat-fee pay rule); Grab is untouched', async () => {
  const F = await import('../public/formula.js');
  const grabBefore = F.fitWeights([]);
  F.usePlatform('tada');
  try {
    assert.equal(F.platformNow(), 'tada');
    assert.equal(F.withBase([])[0].id, 'tada-base-1', 'starts from the TADA receipts');
    const c = F.fitCommission([]);
    assert.equal(c.kind, 'tada');
    // the receipts: the offer shows ride fare + fuel support (12.50, 41.40); minus the fee: 11.90, 40.58
    assert.equal(F.driverEarns(c, 12.5), 11.9);
    assert.equal(F.driverEarns(c, 41.4), 40.58);
    assert.equal(F.driverEarns(c, 26.5), 25.68, 'the job offered at S$26.50: you net S$25.68');
    assert.equal(F.tadaFee(25), 0.6);
    assert.equal(F.tadaFee(25.01), 0.82);
    // the starting formula comes close to the non-airport receipt
    const w = F.fitWeights([]);
    assert.ok(Math.abs(F.passengerFare(w, 4.93, 9).fare - 12.5) < 0.05);
    // a yellow / orange TADA job is surged: it doesn't teach the normal price
    assert.equal(F.usable({ km: 8, actual: 20, surge: 'normal', level: 2, platform: 'tada' }), false);
    assert.equal(F.usable({ km: 8, actual: 15, surge: 'normal', level: 0, platform: 'tada' }), true);
  } finally {
    F.usePlatform('grab');
  }
  assert.deepEqual(F.fitWeights([]), grabBefore, 'back on Grab, nothing changed');
  assert.equal(F.platformOf({}), 'grab');
  assert.equal(F.platformOf({ platform: 'tada' }), 'tada');
});

test('each Radar card says how many jobs back it: its distance, within 3 km and 1½ h of this time, and how many in the last hour', async () => {
  const { bandOutlook } = await import('../public/formula.js');
  const now = Date.parse('2026-11-19T22:00:00+08:00');
  const here = { lat: 1.3204, lng: 103.8438 };
  const at = (km, ts, where = here) => make(km, 18, { ts, lat: where.lat, lng: where.lng });
  const trips = [
    ...[1, 2, 3].map((d) => at(13, now - d * 86400000 - 20 * 60000)), // 10-20 km, this time, past days
    at(12, now - 15 * 60000), // in the last hour
    at(14, now - 5 * 3600000), // too far from this time of day
    at(13, now - 10 * 60000, { lat: 1.40, lng: 103.90 }), // too far away
    at(6, now - 86400000),
  ];
  const b = bandOutlook(trips, now, here);
  assert.deepEqual(b.map((x) => [x.inBandNear, x.inBandRecent]), [[1, 0], [4, 1], [0, 0]]);
});

test('an unusually high job counts a quarter until another job nearby (similar distance, within 2 h) backs it', async () => {
  const { timeOfDay, highJobs } = await import('../public/formula.js');
  const now = Date.parse('2026-11-19T22:00:00+08:00');
  const here = { lat: 1.2937, lng: 103.8486 };
  const plain = Array.from({ length: 8 }, (_, i) => make(5 + i, 15, { ts: now - (i + 1) * 86400000, lat: here.lat, lng: here.lng }));
  const big = (km, mins, x, where = here) => { const t = make(km, 12, { ts: now - mins * 60000, lat: where.lat, lng: where.lng }); return { ...t, actual: Math.round(t.actual * x * 100) / 100 }; };
  const lone = [...plain, big(5.4, 10, 2.2)];
  const h1 = highJobs(lone);
  assert.equal(h1.flagged.length, 1);
  assert.equal(h1.unbacked.size, 1, 'nothing backs it yet');
  const backed = [...plain, big(5.4, 10, 2.2), big(3.4, 25, 1.8, { lat: 1.300, lng: 103.855 })]; // a second high job ~1 km away, 15 min apart
  assert.equal(highJobs(backed).unbacked.size, 0, 'two high jobs back each other');
  const far = [...plain, big(5.4, 10, 2.2), big(5, 25, 1.8, { lat: 1.40, lng: 103.90 })];
  assert.equal(highJobs(far).unbacked.size, 2, 'too far apart to back each other');
  assert.ok(timeOfDay(backed, now, here).lift > timeOfDay(lone, now, here).lift, 'backed, they move "now" more');
});

test('a postal code OneMap does not know: its first two digits give the district to ask about', async () => {
  const { postalDistrict } = await import('../public/places.js');
  assert.equal(postalDistrict('307953').label, 'Novena / Thomson');
  assert.equal(postalDistrict('529889').label, 'Tampines / Pasir Ris');
  assert.equal(postalDistrict('018956').label, 'Raffles Place / Marina');
  assert.equal(postalDistrict('999999'), null, 'not a district: ask for km instead');
  assert.equal(postalDistrict('Orchard'), null);
});

test('CPF: 40% of earnings is net; the rate by birth year, opt-in and age (CPF 2026); matches the TADA receipts', async () => {
  const { cpfRate, cpfOf } = await import('../public/cpf.js');
  const y = 2026;
  // the TADA receipts: born before 1995, not opted in, 35 or under: MediSave 8% -> 41.40 -> 1.32, 12.50 -> 0.40
  const ms = cpfRate({ on: true, birthYear: 1992, optIn: false }, y);
  assert.deepEqual([ms.kind, ms.rate, ms.operator], ['medisave', 8, 0]);
  assert.equal(cpfOf(41.4, ms), 1.32);
  assert.equal(cpfOf(12.5, ms), 0.4);
  assert.equal(cpfRate({ on: true, birthYear: 1985 }, y).rate, 9, 'not opted in, 41: MediSave 9%');
  assert.deepEqual([cpfRate({ on: true, birthYear: 1985, optIn: true }, y).kind, cpfRate({ on: true, birthYear: 1985, optIn: true }, y).rate], ['optin', 14]);
  const young = cpfRate({ on: true, birthYear: 1998 }, y);
  assert.deepEqual([young.kind, young.rate, young.operator], ['full', 13, 7], 'born 1995+: full CPF, no choice');
  assert.equal(cpfRate({ on: true, birthYear: 1950, optIn: true }, y).rate, 5.5);
  assert.equal(cpfRate({ on: true, custom: 10 }, y).rate, 10, 'your own % wins');
  assert.equal(cpfRate({ on: false, birthYear: 1990 }, y), null);
});
