import test from 'node:test';
import assert from 'node:assert/strict';
import { predict, priorNet, bandFor, mergeSettings, accuracy, bandProfile, dayClass, timeSimilarity, DEFAULT_SETTINGS } from '../public/model.js';
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
  assert.equal(tuas.returnMin, 30);
  assert.equal(tuas.deadDrop, true);
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

test('late night belongs to the evening before', () => {
  assert.equal(dayClass(at('2026-11-21T03:45:00+08:00')), 'fri'); // Saturday 3:45am = Friday night
  assert.equal(dayClass(at('2026-11-22T03:45:00+08:00')), 'sat'); // Sunday 3:45am = Saturday night
  assert.equal(dayClass(at('2026-11-21T14:00:00+08:00')), 'sat');
  assert.equal(dayClass(at('2026-11-18T02:45:00+08:00')), 'weekday'); // Wednesday 2:45am = Tuesday night
  assert.equal(dayClass(at('2026-11-16T10:00:00+08:00')), 'weekday');
});

test('time matching is tight: 2:45 and 3:45 are not the same moment', () => {
  const t245 = at('2026-11-18T02:45:00+08:00');
  assert.ok(timeSimilarity(t245, at('2026-11-19T02:50:00+08:00')) > 1.4);
  assert.ok(timeSimilarity(t245, at('2026-11-19T03:45:00+08:00')) < 0.65);
  assert.ok(timeSimilarity(t245, at('2026-11-19T05:45:00+08:00')) < 0.01);
});

const ORCHARD = { lat: 1.3048, lng: 103.8318 };
const TAMPINES = { lat: 1.3496, lng: 103.9568 };

test('weekday bar-closing jobs and weekend ones are learned separately', () => {
  const base = { band: '10-15', zone: 'S', km: 12, tripMin: 20, tapLoc: ORCHARD };
  const hot = priorNet(12, 20, S) * 2;
  const normal = priorNet(12, 20, S);
  const trips = [
    trip('2026-11-17T02:45:00+08:00', { ...base, fare: hot }),
    trip('2026-11-18T02:45:00+08:00', { ...base, fare: hot }),
    trip('2026-11-19T02:45:00+08:00', { ...base, fare: hot }),
    trip('2026-11-21T03:45:00+08:00', { ...base, fare: normal }),
    trip('2026-11-22T03:45:00+08:00', { ...base, fare: normal }),
  ];
  const weekdayNight = predict({ band: '10-15', zone: 'S', ts: at('2026-11-25T02:50:00+08:00'), loc: ORCHARD }, trips, S);
  const weekendNight = predict({ band: '10-15', zone: 'S', ts: at('2026-11-28T03:50:00+08:00'), loc: ORCHARD }, trips, S);
  const a = weekdayNight.net / weekdayNight.prior;
  const b = weekendNight.net / weekendNight.prior;
  assert.ok(a > 1.6, `weekday 2:50 ratio ${a.toFixed(2)}`);
  assert.ok(b < 1.4, `weekend 3:50 ratio ${b.toFixed(2)}`);
  assert.equal(weekdayNight.nearTime, 3);
});

test('where you are when the job comes in matters', () => {
  const base = { band: '10-15', zone: 'E', km: 12, tripMin: 20 };
  const trips = [];
  for (const d of ['17', '18', '19']) {
    trips.push(trip(`2026-11-${d}T02:45:00+08:00`, { ...base, tapLoc: ORCHARD, fare: priorNet(12, 20, S) * 2 }));
    trips.push(trip(`2026-11-${d}T02:45:01+08:00`, { ...base, tapLoc: TAMPINES, fare: priorNet(12, 20, S) }));
  }
  const ts = at('2026-11-25T02:45:00+08:00');
  const orchard = predict({ band: '10-15', zone: 'E', ts, loc: ORCHARD }, trips, S);
  const tampines = predict({ band: '10-15', zone: 'E', ts, loc: TAMPINES }, trips, S);
  assert.ok(orchard.net > tampines.net * 1.25, `${orchard.net.toFixed(2)} vs ${tampines.net.toFixed(2)}`);
});

test('a cancelled job with a fare trains the model just like a taken one', () => {
  const trips = [trip('2026-11-16T18:00:00+08:00', { decision: 'cancelled', fare: 30 })];
  const q = predict({ band: '10-15', zone: 'E', ts: at('2026-11-16T18:00:00+08:00') }, trips, S);
  assert.equal(q.basis, 1);
});

test('untrainable trips (pending, no fare seen, no distance) are ignored', () => {
  const trips = [
    trip('2026-11-16T18:00:00+08:00', { status: 'pending', fare: 99 }),
    trip('2026-11-16T18:00:00+08:00', { status: 'nofare', decision: 'cancelled' }),
    trip('2026-11-16T18:00:00+08:00', { km: undefined, fare: 99 }),
  ];
  const q = predict({ band: '10-15', zone: 'E', ts: at('2026-11-16T18:00:00+08:00') }, trips, S);
  assert.equal(q.basis, 0);
  assert.equal(q.stage, 'seed');
});

test('settings merge keeps your dead drops and drops old fields', () => {
  const s = mergeSettings({ targetPerHour: 35, deadZones: ['TUAS', 'W', 'MARS'], commission: 0.2, share: false, rideType: 'taxi', returnMin: {} });
  assert.equal(s.targetPerHour, 35);
  assert.deepEqual(s.deadZones, ['TUAS', 'W']);
  for (const old of ['commission', 'share', 'rideType', 'returnMin']) assert.equal(old in s, false, old);
  assert.deepEqual(mergeSettings().deadZones, ['TUAS', 'CF']);
});

test('dead drops are personal: they change your verdict, not what the job pays', () => {
  const ts = at('2026-11-16T18:00:00+08:00');
  const q = { band: '20-30', zone: 'W', ts };
  const general = predict(q, [], S);
  const avoidsWest = predict(q, [], mergeSettings({ deadZones: ['TUAS', 'CF', 'W'] }));
  assert.equal(general.net, avoidsWest.net);
  assert.equal(general.returnMin, 0);
  assert.equal(avoidsWest.returnMin, 30);
  assert.equal(general.verdict, 'TAKE');
  assert.equal(avoidsWest.verdict, 'SKIP');
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

test('drop areas map to the nine buttons', () => {
  assert.equal(classifyZone(1.329, 103.642), 'TUAS'); // 41 Tuas View Close
  assert.equal(classifyZone(1.3592, 103.9894), 'AIRPORT'); // Changi Airport
  assert.equal(classifyZone(1.3381, 103.9832), 'AIRPORT'); // Terminal 4
  assert.equal(classifyZone(1.445, 103.769), 'WLC'); // Woodlands Checkpoint
  assert.equal(classifyZone(1.3893, 103.9876), 'CF'); // Changi Village
  assert.equal(classifyZone(1.37, 103.975), 'CF'); // Loyang
  assert.equal(classifyZone(1.3705, 103.9746), 'CF'); // Loyang Avenue
  assert.equal(classifyZone(1.3343, 103.962), 'E'); // Changi City Point stays East
  assert.equal(classifyZone(1.381, 103.955), 'E'); // Pasir Ris Park stays East
  assert.equal(classifyZone(1.3469, 103.9474), 'E'); // 111 Tampines St 11
  assert.equal(classifyZone(1.2789, 103.8536), 'C'); // Raffles Place
  assert.equal(classifyZone(1.3048, 103.8318), 'C'); // Orchard
  assert.equal(classifyZone(1.3204, 103.8438), 'C'); // Novena
  assert.equal(classifyZone(1.2494, 103.8303), 'S'); // Sentosa
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
