import test from 'node:test';
import assert from 'node:assert/strict';
import { passengerFare, fitWeights, looError, fitCommission, driverEarns, usable, toCsv, SEED, MIN_PASSENGER } from '../public/beta/formula.js';

// Trips made with a hidden formula: S$3.00 + S$0.60/km + S$0.25/min, Grab keeps 20%.
const TRUE = { base: 3, perKm: 0.6, perMin: 0.25 };
const make = (km, min, extra = {}) => {
  const fare = passengerFare(TRUE, km, min, extra.erp).fare;
  return { ts: Date.now(), km, min, erp: extra.erp || 0, surge: 'normal', actual: fare, earned: Math.round(((fare - (extra.erp || 0)) * 0.8 + (extra.erp || 0)) * 100) / 100, ...extra };
};

test('the passenger fare follows the published shape and never goes below S$8.10', () => {
  assert.equal(passengerFare(SEED, 1, 3).fare, MIN_PASSENGER);
  assert.equal(passengerFare(SEED, 1, 3).atMinimum, true);
  assert.equal(passengerFare(TRUE, 10, 20).fare, 14);
  assert.equal(passengerFare(TRUE, 10, 20, 1.5).fare, 15.5, 'ERP is added on top');
});

test('with no trips the weights are the starting guess; with enough they reach the real formula', () => {
  assert.deepEqual(fitWeights([]), { ...SEED, n: 0 });
  const trips = [[5, 12], [9, 15], [14, 30], [20, 26], [28, 45], [7, 20], [33, 40], [12, 14], [18, 35], [25, 30]].map(([k, m]) => make(k, m));
  const w = fitWeights(trips);
  assert.ok(Math.abs(w.base - 3) < 0.15 && Math.abs(w.perKm - 0.6) < 0.02 && Math.abs(w.perMin - 0.25) < 0.02, JSON.stringify(w));
  const e = looError(trips);
  assert.ok(e.avg < 0.25, `unseen-trip error ${e.avg}`);
});

test('one or two trips move the weights sensibly instead of wildly', () => {
  const one = fitWeights([make(10, 20)]);
  for (const k of ['base', 'perKm', 'perMin']) assert.ok(Number.isFinite(one[k]) && one[k] > 0, `${k} ${one[k]}`);
  const p = passengerFare(one, 10, 20).fare;
  assert.ok(Math.abs(p - 14) < Math.abs(passengerFare(SEED, 10, 20).fare - 14), 'closer to the real fare than the seed was');
});

test('surge and minimum-fare trips are kept out of the formula', () => {
  assert.equal(usable(make(10, 20, { surge: 'surge' })), false);
  assert.equal(usable({ km: 1.5, min: 5, surge: 'normal', actual: 8.1 }), false);
  assert.equal(usable(make(10, 20)), true);
});

test('commission: average with 1–2 trips, flat % or % plus a fixed amount with 3+', () => {
  assert.equal(fitCommission([]).kind, 'seed');
  const flat = [make(10, 20), make(20, 30), make(5, 12, { erp: 1 })];
  const c = fitCommission(flat);
  assert.equal(c.kind, 'flat');
  assert.ok(Math.abs(c.avgRate - 0.2) < 0.002);
  assert.equal(driverEarns(c, 14), 11.2);
  // Grab keeps 20% and a further S$0.50 per job.
  const fixed = flat.map((t) => ({ ...t, earned: Math.round(((t.actual - t.erp) * 0.8 - 0.5 + t.erp) * 100) / 100 }));
  const f = fitCommission(fixed);
  assert.equal(f.kind, 'percent+fixed');
  assert.ok(Math.abs(f.keep - 0.8) < 0.01 && Math.abs(f.fixed + 0.5) < 0.05, JSON.stringify(f));
});

test('CSV export matches the research dataset columns', () => {
  const csv = toCsv([make(10, 20)]);
  const [head, row] = csv.trim().split('\n');
  assert.equal(head.split(',').length, row.split(',').length);
  assert.ok(row.includes(',GrabCar,10,20,,14,11.2,'));
});
