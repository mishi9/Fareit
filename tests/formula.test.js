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
