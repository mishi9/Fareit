import test from 'node:test';
import assert from 'node:assert/strict';
import { predict, priorNet, bandFor, mergeSettings, accuracy, bandProfile, DEFAULT_SETTINGS } from '../public/model.js';
import { classifyZone, findArea, isPostal } from '../public/places.js';

const at = (iso) => new Date(iso).getTime();
const S = DEFAULT_SETTINGS;

test('starting fare structure lands near the recorded Tampines -> Tuas trip', () => {
  const p = priorNet(45.8, 52, S);
  assert.ok(Math.abs(p - 33.2) / 33.2 < 0.02, `prior ${p.toFixed(2)} should be within 2% of 33.20`);
});

test('bands cover every distance', () => {
  assert.equal(bandFor(0).id, '0-5');
  assert.equal(bandFor(4.99).id, '0-5');
  assert.equal(bandFor(5).id, '5-10');
  assert.equal(bandFor(46.1).id, '40+');
  assert.equal(bandFor(300).id, '40+');
});

test('with no data, a long Tuas run is a SKIP and the same run east is a TAKE', () => {
  const ts = at('2026-11-16T09:01:00+08:00');
  const tuas = predict({ band: '40+', zone: 'TUAS', ts }, [], S);
  const east = predict({ band: '40+', zone: 'E', ts }, [], S);
  assert.equal(tuas.stage, 'seed');
  assert.equal(tuas.verdict, 'SKIP');
  assert.equal(tuas.returnMin, 35);
  assert.equal(east.verdict, 'TAKE');
  assert.ok(tuas.perHour < east.perHour);
  assert.ok(tuas.lo < tuas.net && tuas.net < tuas.hi);
});

function trip(iso, over = {}) {
  return { id: iso + JSON.stringify(over), ts: at(iso), status: 'reconciled', km: 12, tripMin: 20, zone: 'E', band: '10-15', ...over };
}

test('reconciled trips pull predictions toward what you were actually paid', () => {
  const paid = priorNet(12, 20, S) * 2; // every logged trip paid double the formula
  const trips = Array.from({ length: 8 }, (_, i) => trip(`2026-11-1${i % 5 + 1}T18:00:00+08:00`, { fare: paid }));
  // Nov 11-15 2026 includes a weekend; keep the query on a weekday evening.
  const q = predict({ band: '10-15', zone: 'E', ts: at('2026-11-16T18:30:00+08:00') }, trips, S);
  assert.equal(q.stage, 'trained');
  assert.ok(Math.abs(q.net - paid) / paid < 0.08, `net ${q.net.toFixed(2)} should be close to ${paid.toFixed(2)}`);
  assert.ok(q.hi / q.lo < 1.35, 'consistent history should give a narrow range');
  assert.equal(q.verdict, 'TAKE');

  // Far from the data (other area, 3am) the correction is weaker but still leans the same way.
  const far = predict({ band: '10-15', zone: 'TUAS', ts: at('2026-11-17T03:00:00+08:00') }, trips, S);
  const farRatio = far.net / far.prior;
  assert.ok(farRatio > 1.2 && farRatio < q.net / q.prior, `far ratio ${farRatio.toFixed(2)}`);
});

test('one trip cannot swing the prediction wildly', () => {
  const trips = [trip('2026-11-16T18:00:00+08:00', { fare: priorNet(12, 20, S) * 3 })];
  const q = predict({ band: '10-15', zone: 'E', ts: at('2026-11-16T18:00:00+08:00') }, trips, S);
  assert.equal(q.stage, 'learning');
  assert.ok(q.net / q.prior < 3, 'a single trip is shrunk toward the formula');
});

test('band profile switches to your own trips after three', () => {
  const trips = [30, 32, 38].map((km, i) => trip(`2026-11-1${i + 1}T10:00:00+08:00`, { km, tripMin: 40, band: '30-40', fare: 30 }));
  const prof = bandProfile('30-40', trips);
  assert.equal(prof.learned, true);
  assert.equal(prof.km, 32);
  assert.equal(bandProfile('30-40', trips.slice(0, 2)).learned, false);
});

test('untrainable trips (pending, skipped, no distance) are ignored', () => {
  const trips = [
    trip('2026-11-16T18:00:00+08:00', { status: 'pending', fare: 99 }),
    trip('2026-11-16T18:00:00+08:00', { status: 'skipped', fare: 99 }),
    trip('2026-11-16T18:00:00+08:00', { km: undefined, fare: 99 }),
  ];
  const q = predict({ band: '10-15', zone: 'E', ts: at('2026-11-16T18:00:00+08:00') }, trips, S);
  assert.equal(q.basis, 0);
  assert.equal(q.stage, 'seed');
});

test('settings merge keeps per-area return minutes', () => {
  const s = mergeSettings({ targetPerHour: 35, returnMin: { TUAS: 40 } });
  assert.equal(s.targetPerHour, 35);
  assert.equal(s.returnMin.TUAS, 40);
  assert.equal(s.returnMin.CF, 25);
});

test('accuracy reports error and lean', () => {
  const trips = [
    { status: 'reconciled', fare: 20, prediction: { net: 22 } },
    { status: 'reconciled', fare: 20, prediction: { net: 18 } },
    { status: 'pending', prediction: { net: 50 } },
  ];
  const a = accuracy(trips);
  assert.equal(a.count, 2);
  assert.ok(Math.abs(a.mape - 0.1) < 1e-9);
  assert.ok(Math.abs(a.bias) < 1e-9);
});

test('drop areas map to the eight buttons', () => {
  assert.equal(classifyZone(1.329, 103.642), 'TUAS'); // 41 Tuas View Close
  assert.equal(classifyZone(1.3592, 103.9894), 'AIRPORT'); // Changi Airport
  assert.equal(classifyZone(1.3381, 103.9832), 'AIRPORT'); // Terminal 4
  assert.equal(classifyZone(1.445, 103.769), 'WLC'); // Woodlands Checkpoint
  assert.equal(classifyZone(1.3893, 103.9876), 'CF'); // Changi Village
  assert.equal(classifyZone(1.37, 103.975), 'CF'); // Loyang
  assert.equal(classifyZone(1.3469, 103.9474), 'E'); // 111 Tampines St 11
  assert.equal(classifyZone(1.2789, 103.8536), 'S'); // Raffles Place
  assert.equal(classifyZone(1.4304, 103.8354), 'N'); // Yishun
  assert.equal(classifyZone(1.3329, 103.7436), 'W'); // Jurong East
});

test('area names and postal codes are recognised', () => {
  assert.equal(findArea('tampines').label, 'Tampines');
  assert.equal(findArea('  AMK ').label, 'Ang Mo Kio');
  assert.equal(findArea('WLC').label, 'Woodlands Checkpoint');
  assert.equal(findArea('111 Tampines St 11'), null);
  assert.ok(isPostal('521111'));
  assert.ok(!isPostal('52111'));
});
