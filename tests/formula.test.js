import test from 'node:test';
import assert from 'node:assert/strict';
import {
  passengerFare, fitWeights, looError, fitCommission, driverEarns, usable, cutOf, toCsv, SEED, BASE_TRIPS, MIN_PASSENGER,
} from '../public/beta/formula.js';

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
  assert.equal(usable(make(10, 20, { surge: 'surge' })), false);
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
  const { timeOfDay, byTimeBlock } = await import('../public/beta/formula.js');
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
  const { isLowCut } = await import('../public/beta/formula.js');
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
  const { timeEstimator, tripTime } = await import('../public/beta/formula.js');
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
  const { MIN_DRIVER } = await import('../public/beta/formula.js');
  assert.equal(MIN_DRIVER, 6.2);
  const rule = { keep: 0.768, fixed: -1.02 };
  assert.equal(driverEarns(rule, 8.1), 6.2, 'minimum-fare trip: rule gives 5.20, floor lifts it');
  assert.equal(driverEarns(rule, 8.1, 1.5), 7.7, 'ERP on top of the floor');
  assert.equal(driverEarns(rule, 20), 14.34);
  const atFloor = { km: 2, min: 6, erp: 0, surge: 'normal', actual: 8.1, earned: 6.2, ts: Date.now() };
  assert.equal(fitCommission([atFloor]).n, 1, 'only the base trip counts');
});

test('surge estimate: how far surge trips ran above the normal formula, near this hour first', async () => {
  const { surgeLift } = await import('../public/beta/formula.js');
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
  const { airportLift } = await import('../public/beta/formula.js');
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
  const { queueSummary } = await import('../public/beta/queue.js');
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
  const { bandOutlook } = await import('../public/beta/formula.js');
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
  const { atAirport, rounded } = await import('../public/beta/where.js');
  assert.equal(atAirport({ lat: 1.3603, lng: 103.9894 }), true, 'Jewel');
  assert.equal(atAirport({ lat: 1.3480, lng: 103.9870 }), true, 'between T2 and T4');
  assert.equal(atAirport({ lat: 1.3340, lng: 103.9630 }), false, 'Changi Business Park');
  assert.equal(atAirport({ lat: 1.3530, lng: 103.9450 }), false, 'Tampines');
  assert.equal(atAirport(null), false);
  assert.deepEqual(rounded({ lat: 1.354321, lng: 103.987654 }), { lat: 1.35, lng: 103.99 });
});
