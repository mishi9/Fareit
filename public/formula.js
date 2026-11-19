// Formula lab (beta): reverse-engineers what a passenger pays for a Standard trip from exact trips,
// and how much of it the driver earns. Pure functions, shared by the page and the tests.
//
// Everything is fitted on "Paid by passenger": the one number the passenger actually pays. Fees
// and extras (the platform & partner fee, opt-in insurance …) fold into the base, and a trip with
// an unusual extra stands out as an outlier instead of bending the formula.
//
//   paid by passenger = max(S$8.10, base + per km × distance + per min × time) + ERP / tolls
//   driver earns      = a share of what the passenger paid   (ERP / tolls passed through)
//   Grab keeps        = paid by passenger − driver earned
// Non-surged trips only (Grab's demand multiplier is 1). S$8.10 is the minimum a passenger pays
// (tested as a passenger).

import { dayType, OTHER_DAY_WEIGHT, experienceLift, EXPERIENCE_WEIGHT } from './daypattern.js';
export const MIN_PASSENGER = 8.10;
// The least a driver earns on a trip (a minimum-fare guarantee), whatever the passenger paid.
export const MIN_DRIVER = 6.20;

// The first real trip, from Grab's job details. Time isn't shown there, so it's OneMap's drive time.
// Grab's own split, for reference: S$16.80 paid = S$15.60 passenger fare + S$1.20 platform &
// partner fee; earned S$12.10 = pick-up 3.50 + trip 7.70 + fuel surcharge 0.90.
export const BASE_TRIPS = [{
  id: 'base-1', base: true, ts: Date.parse('2026-11-17T01:30:00+08:00'),
  km: 11.58, min: 16.9, erp: 0, actual: 16.8, earned: 12.1, surge: 'normal',
  note: 'Whampoa → Hougang, Standard, cash. Paid 16.80 (15.60 fare + 1.20 platform fee). Earned 12.10 = pick-up 3.50 + trip 7.70 + fuel 0.90. Time from OneMap.',
}];

// Starting weights: a generic split (base, per km, per min) scaled so the base trip comes out
// exactly. One trip sets the level, not the split; more trips sort out the split.
const GENERIC = { base: 2.5, perKm: 0.5, perMin: 0.16 };
const B = BASE_TRIPS[0];
const SCALE = (B.actual - B.erp) / (GENERIC.base + GENERIC.perKm * B.km + GENERIC.perMin * B.min);
export const SEED = { base: GENERIC.base * SCALE, perKm: GENERIC.perKm * SCALE, perMin: GENERIC.perMin * SCALE };

// ---- Apps (platforms) ----
// Each app learns its own formula from its own trips; they never mix. Grab: what the passenger
// paid, and Grab keeps a % (learned). TADA: the amount the job offer shows (its Net Fare; on the
// receipt it's Ride Fare + Fuel Support, "Sub Total 1"); the driver gets that minus a flat driver
// platform fee (S$0.55 / S$0.75 + GST: S$0.60 up to a S$25 fare, S$0.82 over), no % cut. TADA
// starts from the owner's receipts.
export const TADA_BASE_TRIPS = [
  { id: 'tada-base-1', base: true, platform: 'tada', ts: Date.parse('2026-11-18T03:11:00+08:00'), km: 4.93, min: 9, erp: 0, actual: 12.5, earned: 11.9, surge: 'normal',
    note: 'Orchard → Balestier, AnyTADA, 03:11–03:20. Ride fare 11.60 + fuel support 0.90 = 12.50 − driver platform fee 0.60 = 11.90 (rider paid 13.88).' },
  { id: 'tada-base-2', base: true, platform: 'tada', ts: Date.parse('2026-11-11T00:30:00+08:00'), km: 27.86, min: 23, erp: 0, actual: 41.4, earned: 40.58, surge: 'airport',
    note: 'Changi T1 / Jewel → Yishun, AnyTADA, 00:30–00:53 (airport). Ride fare 40.20 + fuel support 1.20 = 41.40 − fee 0.82 = 40.58 (rider paid 42.76).' },
];
const TB = TADA_BASE_TRIPS[0];
const TSCALE = TB.actual / (GENERIC.base + GENERIC.perKm * TB.km + GENERIC.perMin * TB.min);
export const TADA_SEED = { base: GENERIC.base * TSCALE, perKm: GENERIC.perKm * TSCALE, perMin: GENERIC.perMin * TSCALE };
export const TADA_FEE_LINE = 25;
export const tadaFee = (fare) => (fare > TADA_FEE_LINE ? 0.82 : 0.6);
export const tadaFuel = (fare) => (fare > TADA_FEE_LINE ? 1.2 : 0.9); // from two receipts so far
export const PLATFORMS = {
  grab: { id: 'grab', name: 'Grab', base: BASE_TRIPS, seed: SEED, minFare: MIN_PASSENGER, minDriver: MIN_DRIVER },
  tada: { id: 'tada', name: 'TADA', base: TADA_BASE_TRIPS, seed: TADA_SEED, minFare: 0, minDriver: 0 },
};
let P = PLATFORMS.grab;
// Which app the estimates are for (the app switches it; everything below follows).
export const usePlatform = (id) => { P = PLATFORMS[id] || PLATFORMS.grab; };
export const platformNow = () => P.id;
export const platformOf = (t) => (t && t.platform === 'tada' ? 'tada' : 'grab');

// How far one trip's worth of evidence may move each weight: a gentle pull back toward the seed,
// so a few trips give sensible weights instead of wild ones. It fades as trips add up.
const PRIOR = { base: 3, perKm: 0.3, perMin: 0.16 };
const TERMS = ['base', 'perKm', 'perMin'];

const r2 = (n) => Math.round(n * 100) / 100;

// What the passenger pays for a trip, by the formula.
export function passengerFare(w, km, min, erp = 0) {
  const core = w.base + w.perKm * km + w.perMin * min;
  const atMinimum = core < P.minFare;
  return { core: r2(core), atMinimum, fare: r2(Math.max(P.minFare, core) + (erp || 0)) };
}

// Solve (XᵀX) w = Xᵀy. Returns null if the terms can't be told apart.
function lsq(X, y) {
  const k = X[0].length;
  const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0)));
  const b = Array.from({ length: k }, (_, i) => X.reduce((s, r, n) => s + r[i] * y[n], 0));
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j < k; j++) A[r][j] -= f * A[c][j];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

// Your trips plus the built-in base trip.
// Results that depend only on the set of trips are remembered per trips array: the page passes
// the same array until a trip is saved, deleted or synced in (then a new one), so the formula,
// the cut and the time estimate are worked out once per change, not on every refresh or keystroke.
// Everything time- or place-dependent (now, surge near this hour, the bands) is still worked out
// fresh from all trips every time.
const memo = (fn) => {
  const cache = new WeakMap();
  return (trips) => {
    if (!cache.has(trips)) cache.set(trips, new Map());
    const per = cache.get(trips); // one answer per app
    if (!per.has(P.id)) per.set(P.id, fn(trips));
    return per.get(P.id);
  };
};

export const withBase = memo((trips) => [...P.base, ...trips.filter((t) => !t.base)]);

// ---- Trip time ----
// The passenger is quoted before a driver is matched, so the price depends on pickup → drop-off
// only. `min` is that trip time (the navigation's estimate from the pickup point). The job
// card's total also includes the driver's way to the pickup, so it's kept apart as `cardMin`
// and never used as trip time. When a trip has no trip time, it's estimated from the km.
const DEFAULT_TIME = { a: 3, b: 1.1 }; // minutes ≈ 3 + 1.1 × km until real trip times teach it

export const timeEstimator = memo(timeEstimatorOf);
function timeEstimatorOf(trips) {
  const rows = trips.filter((t) => t.min > 0 && t.km > 0);
  let { a, b } = DEFAULT_TIME;
  if (rows.length >= 3) {
    const w = lsq(rows.map((t) => [1, t.km]), rows.map((t) => t.min));
    if (w && w[1] > 0) [a, b] = w;
  }
  return (km) => Math.max(1, a + b * km);
}
export const tripTime = (t, est) => (t.min > 0 ? t.min : est(t.km));

// TEST: surge is told by the price, not by Grab's green arrow (most jobs show the arrow, even
// S$6.20 ones, so it doesn't mean a job pays more). A job that paid SURGE_PRICE_MIN or more above
// the normal price for its distance and time is a surge job, whatever it was tagged; everything
// else (arrow or not) teaches the normal price. Set SURGE_BY_PRICE = false to go back to the tags.
export const SURGE_BY_PRICE = true;
export const SURGE_PRICE_MIN = 0.15;
const SURGE_R = Math.log(1 + SURGE_PRICE_MIN);
// Surge (by price, or by tag when the test is off) for a trip, given the normal-price weights.
export function isSurgeTrip(t, w, est, c) {
  if (t.surge === 'airport' || t.event || t.base) return false;
  if (!SURGE_BY_PRICE) return t.surge === 'surge';
  const r = ratioToFormula(t, w, est, c);
  return r !== null && r >= SURGE_R - 1e-9;
}

// A trip can teach the formula if it's normal-priced, complete, and not held up by the minimum.
export function usable(t) {
  if (t.event || !(t.km > 0) || !(t.actual > 0)) return false;
  if (SURGE_BY_PRICE ? t.surge === 'airport' : t.surge !== 'normal') return false;
  if (t.level >= 1) return false; // TADA showed yellow or orange: surged, so not the normal price
  return t.actual - (t.erp || 0) > P.minFare + 0.005;
}

// Best weights: least squares on what the passenger paid (minus ERP / tolls), with the gentle
// pull toward the seed. Always includes the base trip.
const fitWeightsAll = memo((trips) => fitWeightsOf(trips, true));
export function fitWeights(trips, { includeBase = true } = {}) {
  return includeBase ? fitWeightsAll(trips) : fitWeightsOf(trips, false);
}
function fitWeightsOf(trips, includeBase) {
  const pool = includeBase ? withBase(trips) : trips;
  const rows = pool.filter(usable);
  if (!rows.length) return { ...P.seed, n: 0 };
  const est = timeEstimator(pool);
  // Test: first the trips tagged Normal (no green arrow) set the level when there are 5 or more,
  // else all; jobs that paid SURGE_PRICE_MIN+ above it are surge jobs; the rest are fitted again.
  const plain = rows.filter((t) => t.base || t.surge === 'normal');
  const w = fitRows(SURGE_BY_PRICE && plain.length >= 6 ? plain : rows, est);
  if (!w) return { ...P.seed, n: rows.length };
  if (SURGE_BY_PRICE) {
    const keep = rows.filter((t) => t.base || (t.actual - (t.erp || 0)) / passengerFare(w, t.km, tripTime(t, est)).fare - 1 < SURGE_PRICE_MIN);
    if (keep.length < rows.length) {
      const w2 = fitRows(keep, est);
      if (w2) return { ...w2, n: keep.length };
    }
  }
  return { ...w, n: rows.length };
}
function fitRows(rows, est) {
  const X = rows.map((t) => [1, t.km, tripTime(t, est)]);
  const y = rows.map((t) => t.actual - (t.erp || 0));
  TERMS.forEach((term, i) => {
    const row = [0, 0, 0];
    row[i] = 1 / PRIOR[term];
    X.push(row);
    y.push(P.seed[term] / PRIOR[term]);
  });
  let w = lsq(X, y);
  if (!w) return null;
  // Safeguard: trips far from the fit count much less, refitted a few times (each pass finds the
  // wrong ones more clearly), so a few wrong entries can't bend the rates. Over 25% off: 1/20th;
  // 15-25%: a half; real trips sit well inside that.
  if (rows.length >= 5) {
    for (let pass = 0; pass < 4; pass++) {
      const k = rows.map((t, i) => {
        const off = Math.abs(y[i] / (w[0] + w[1] * X[i][1] + w[2] * X[i][2]) - 1);
        return off > 0.25 ? 0.05 : off > 0.15 ? 0.5 : 1;
      });
      if (k.every((v) => v === 1)) break;
      const Xw = X.map((row, i) => (i < rows.length ? row.map((v) => v * Math.sqrt(k[i])) : row));
      const yw = y.map((v, i) => (i < rows.length ? v * Math.sqrt(k[i]) : v));
      w = lsq(Xw, yw) || w;
    }
  }
  return { base: w[0], perKm: w[1], perMin: w[2] };
}

// How good the formula is on trips it hasn't seen: each of your trips predicted from all the
// others (and the base trip).
// Tests every trip until there are more than 200; then the 200 most recent (each still predicted
// from all the others), to keep it quick. Predictions never use this; it's only the accuracy stat.
export const LOO_MAX = 200;
export const looError = memo(looErrorOf);
function looErrorOf(trips) {
  const all = trips.filter((t) => !t.base && usable(t) && !(SURGE_BY_PRICE && isSurgeTrip(t, fitWeights(trips), timeEstimator(withBase(trips)))));
  const mine = all.length > LOO_MAX ? [...all].sort((a, b) => b.ts - a.ts).slice(0, LOO_MAX) : all;
  if (mine.length < 2) return null;
  let abs = 0;
  let rel = 0;
  const est = timeEstimator(withBase(trips));
  for (const t of mine) {
    const w = fitWeights(trips.filter((o) => o !== t));
    const p = passengerFare(w, t.km, tripTime(t, est), t.erp).fare;
    abs += Math.abs(p - t.actual);
    rel += Math.abs(p - t.actual) / t.actual;
  }
  return { n: mine.length, avg: abs / mine.length, pct: rel / mine.length, of: all.length };
}

// ---- What Grab keeps ----
// Out of what the passenger paid, leaving out ERP / tolls, which reach the driver untouched.
export function cutOf(t) {
  if (!(t.actual > 0) || !(t.earned > 0)) return null;
  const paid = t.actual - (t.erp || 0);
  const earned = t.earned - (t.erp || 0);
  return { paid, earned, cut: paid - earned, rate: (paid - earned) / paid };
}

// A fixed % or a % plus a fixed amount? With 3+ trips, fits earned = keep × paid + fixed.
// Low-cut trips: Grab sometimes keeps almost nothing (e.g. S$0.10 of S$23.90), perhaps when a
// job sits untaken and Grab lowers its cut until someone accepts. They're real, but they'd drag
// the usual rule off, so they're counted separately instead of fitted.
export const LOW_CUT = 0.15;
export const isLowCut = (t) => { const c = cutOf(t); return Boolean(c) && c.rate < LOW_CUT; };

export const fitCommission = memo(fitCommissionOf);
function fitCommissionOf(trips) {
  // TADA: no % cut; the driver gets the offer's amount − a flat fee (see tadaFee).
  if (P.id === 'tada') return { kind: 'tada', keep: 1, fixed: 0, n: withBase(trips).filter((t) => t.earned > 0).length, avgRate: 0, spread: 0, lo: 0, hi: 0, low: [] };
  // Trips paid at the driver's S$6.20 floor follow the floor, not the usual rule: leave them out.
  const all = withBase(trips).filter((t) => cutOf(t) && !(Math.abs(t.earned - (t.erp || 0) - MIN_DRIVER) < 0.005));
  const low = all.filter(isLowCut);
  // Safeguard: cuts over 50% aren't Grab's usual either (a typo or a troll): left out like low cuts.
  const cuts = all.filter((t) => !isLowCut(t) && cutOf(t).rate <= 0.5).map(cutOf);
  if (!cuts.length) return { kind: 'average', keep: 1 - SEED_CUT_FALLBACK, fixed: 0, n: 0, avgRate: SEED_CUT_FALLBACK, spread: 0, lo: SEED_CUT_FALLBACK, hi: SEED_CUT_FALLBACK, low };
  const rates = cuts.map((c) => c.rate);
  const avgRate = rates.reduce((s, r) => s + r, 0) / rates.length;
  const lo = Math.min(...rates);
  const hi = Math.max(...rates);
  const info = { n: cuts.length, avgRate, spread: hi - lo, lo, hi, low };
  if (cuts.length < 3) return { kind: 'average', keep: 1 - avgRate, fixed: 0, ...info };
  const w = lsq(cuts.map((c) => [1, c.paid]), cuts.map((c) => c.earned));
  if (!w) return { kind: 'average', keep: 1 - avgRate, fixed: 0, ...info };
  // Call it a flat % unless the fixed part is clearly there.
  return Math.abs(w[0]) < 0.1
    ? { kind: 'flat', keep: 1 - avgRate, fixed: 0, ...info }
    : { kind: 'percent+fixed', keep: w[1], fixed: w[0], ...info };
}

const SEED_CUT_FALLBACK = 0.28;

// What the driver would earn on a trip the passenger paid `paid` for (usual cut).
export function driverEarns(model, paid, erp = 0) {
  if (model.kind === 'tada') { const f = paid - (erp || 0); return r2(f - tadaFee(f) + (erp || 0)); }
  return r2(Math.max(MIN_DRIVER, model.keep * (paid - (erp || 0)) + model.fixed) + (erp || 0));
}

// CSV in the research dataset's column order, ready to add to research/fare-formula/trips.csv.
export function toCsv(trips) {
  const head = 'id,date,time,ride_type,grab_km,grab_min,actual_min,passenger_fare,driver_earned,erp,tolls,platform_fee,other_surcharge,surge_flag,pickup_area,drop_area,pickup_fare,trip_fare,fuel_surcharge,notes';
  const pad = (n) => String(n).padStart(2, '0');
  const lines = trips.filter((t) => !t.base).map((t, i) => {
    const d = new Date(t.ts);
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const notes = [`formula said ${t.predicted ?? ''}`, t.cardMin ? `card total ${t.cardMin} min` : '', t.pickupKm ? `pickup ${t.pickupKm} km` : '', t.rain === 1 ? 'rain' : ''].filter(Boolean).join('; ');
    return [i + 1, date, time, 'Standard', t.km, t.min ?? '', '', t.actual ?? '', t.earned ?? '', t.erp || '', '', '', '', t.surge, '', '', '', '', '', notes].join(',');
  });
  return [head, ...lines].join('\n') + '\n';
}

// ---- Time of day ----
// How far real fares ran above or below the normal-price formula at this hour, from every trip
// (normal and surge): this is where surge-prone hours show up. Trips count by how close their
// booking hour is (1 h away 61%, 2 h away 14%), and one pseudo-trip at 0% keeps a single trip
// from swinging it.
const HOUR_SD = 1;
export const hourOf = (ts) => { const d = new Date(ts); return d.getHours() + d.getMinutes() / 60; };
const hourGap = (a, b) => { const g = Math.abs(a - b) % 24; return Math.min(g, 24 - g); };

// How a trip paid against normal, as a log ratio: the passenger fare against the formula, or, for
// a quick entry with only what the driver earned, the earnings against normal earnings.
// Safeguard: no single trip counts as more than +60% or -40% (a typo or a troll can't swing it).
export const PULL_HIGH = Math.log(1.6);
export const PULL_LOW = Math.log(0.6);

// Unusually high jobs (60%+ above the normal price) are saved and used, but flagged: until another
// job backs them (within BACKED_KM, a similar distance, within BACKED_H hours either side, and
// itself BACKED_ABOVE or more above normal), they count UNBACKED_WEIGHT as much in "now" and the
// surge range. Backed, they count fully. Pure, from the trips: nothing is stored or deleted.
export const HIGH_FLAG = 0.6;
export const BACKED_KM = 3;
export const BACKED_H = 2;
export const BACKED_ABOVE = 0.25;
export const UNBACKED_WEIGHT = 0.25;
const similarKm = (a, b) => Math.abs(a - b) <= Math.max(5, 0.5 * Math.max(a, b));
export const highJobs = memo((trips) => {
  const all = withBase(trips);
  const w = fitWeights(trips);
  const est = timeEstimator(all);
  const c = fitCommission(trips);
  const r = new Map();
  for (const t of all) if (!t.base && Number.isFinite(t.ts) && t.surge !== 'airport') { const x = ratioToFormula(t, w, est, c); if (x !== null) r.set(t, x); }
  const flagged = [...r].filter(([, x]) => x >= Math.log(1 + HIGH_FLAG) - 1e-9).map(([t]) => t);
  const unbacked = new Set();
  for (const t of flagged) {
    const backed = [...r].some(([o, x]) => o !== t && x >= Math.log(1 + BACKED_ABOVE) && Math.abs(o.ts - t.ts) <= BACKED_H * 3600000
      && similarKm(o.km, t.km) && (t.lat && o.lat ? kmApart(t, o) <= BACKED_KM : false));
    if (!backed) unbacked.add(t);
  }
  return { flagged, unbacked };
});
function ratioToFormula(t, w, est, c) {
  if (!(t.km > 0)) return null;
  const p = passengerFare(w, t.km, tripTime(t, est)).fare; // without ERP: compare like with like
  let r = null;
  if (t.actual > 0) r = Math.log((t.actual - (t.erp || 0)) / p);
  else if (t.earned > 0 && c) r = Math.log((t.earned - (t.erp || 0)) / driverEarns(c, p));
  return Number.isFinite(r) ? Math.min(PULL_HIGH, Math.max(PULL_LOW, r)) : null;
}

// Safeguard: in "now", another driver's trips can't outweigh everyone else's combined (at least this
// many trips' worth always counts), so 20 jobs from one phone can't take over an area. d is an
// opaque tag per phone from the server; your own trips are 'me'.
export const DRIVER_CAP = 3;
export const TRUSTED_CAP = 3;
const driverOf = (t) => t.d || (t.shared ? 'other' : 'me');

// With `loc`, only trips saved near there count, more the closer they are (1 km 80%, 3 km 14%,
// 5 km 0.4%): Tampines at 2am isn't Orchard at 2am. Trips saved without a location don't count.
// Place: a trip 3 km away counts 61%, 6 km 14%; anything further (or saved without a location)
// still counts a little (5%), so the closest available data always carries the estimate.
const PLACE_SD_KM = 3;
const PLACE_FLOOR = 0.05;
export const NEAR_KM = 3;
const kmApart = (a, b) => {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// Jobs from the last couple of hours say most about right now: one from 10 minutes ago counts
// about 3 times as much as one from last week at the same hour, fading over the next hours, so
// the latest entry leans on the estimate without taking it over.
const RECENT_H = 3;
// The "just now" boost is local: only jobs within NEAR_KM of you get it, so fresh surge in one
// area (e.g. River Valley) doesn't light up another (Toa Payoh) that has no jobs of its own.
export const TUNE = { freshNeeded: 2, rangeBlendUntil: 3 };
export const FRESH_MIN = 60; // the boost is strongest within the hour (it fades over 45 min)
const recentBoost = (ageMin) => (ageMin >= 0 && ageMin <= RECENT_H * 60 ? 1 + 2 * Math.exp(-ageMin / 45) : 1);

// Distance: with a band, trips in its range count fully and others less the further they are
// (5 km outside 61%, 10 km 14%, never below 10%).
const BAND_SD_KM = 5;
const BAND_FLOOR = 0.1;
const bandWeight = (km, band) => {
  if (!band) return 1;
  const out = km < band.lo ? band.lo - km : km >= band.hi ? km - band.hi : 0;
  return BAND_FLOOR + (1 - BAND_FLOOR) * Math.exp(-(out * out) / (2 * BAND_SD_KM * BAND_SD_KM));
};

// Rain: trips saved while it was raining near the pickup (t.rain === 1) may pay a little above
// normal, or may not: there's no sign on a fare that rain moved it, so it's only observed. They
// stay in the data, but count fully only for "now" while it's raining, and at RAIN_OTHER_WEIGHT
// on a dry day (and dry trips the same on a wet one), so a wet evening doesn't make the next dry
// one look busy.
export const RAIN_OTHER_WEIGHT = 0.5;
const sameWeather = (t, raining) => (t.rain === 1) === Boolean(raining) ? 1 : RAIN_OTHER_WEIGHT;

// opts.band: lean on trips of that distance; opts.prior: the lift to fall back on when the band
// has little of its own (counts as one trip). opts.raining: it's raining where you are now.
export function timeOfDay(trips, ts, loc = null, opts = {}) {
  const band = opts.band || null;
  // The starting point: the owner's experience for this kind of night, hour and area (counts like
  // EXPERIENCE_WEIGHT trips), unless a caller passes its own (each card leans on the overall lift).
  const exp = opts.prior == null;
  const priorLog = Math.log(1 + (exp ? experienceLift(ts, loc) : opts.prior));
  const priorW = exp ? EXPERIENCE_WEIGHT : 1;
  const kind = dayType(ts);
  let inBandNear = 0;
  let inBandRecent = 0; // of those, in the last hour
  const all = withBase(trips);
  const w = fitWeights(trips);
  const est = timeEstimator(all);
  const c = fitCommission(trips);
  const h = hourOf(ts);
  let sw = 0;
  let swr = 0;
  let near = 0;
  let surgeNear = 0;
  let recent = 0;
  let closest = null;
  const items = [];
  for (const t of all) {
    if (!Number.isFinite(t.ts) || t.event) continue; // event trips are learned on their own
    // Every trip counts, by how close it is: in time of day, in place, and in recency.
    let place = 1;
    let d = 0;
    if (loc) {
      d = t.lat && t.lng ? kmApart(loc, t) : Infinity;
      place = PLACE_FLOOR + (1 - PLACE_FLOOR) * (Number.isFinite(d) ? Math.exp(-(d * d) / (2 * PLACE_SD_KM * PLACE_SD_KM)) : 0);
    }
    const r = ratioToFormula(t, w, est, c);
    if (r === null) continue;
    const g = hourGap(hourOf(t.ts), h);
    const ageMin = (ts - t.ts) / 60000;
    // Same kind of night (e.g. Friday and Saturday nights) counts fully; another kind less.
    const sameDay = t.base || dayType(t.ts) === kind ? 1 : OTHER_DAY_WEIGHT;
    const x = Math.exp(-(g * g) / (2 * HOUR_SD * HOUR_SD)) * place * bandWeight(t.km, band) * sameDay * sameWeather(t, opts.raining);
    items.push({ t, d, r, g, ageMin, x, boost: d <= NEAR_KM ? recentBoost(ageMin) : 1 });
  }
  // The "just now" boost needs TUNE.freshNeeded jobs within NEAR_KM in the last FRESH_MIN minutes:
  // one job alone (one driver, or one typo) counts like any other job and can't flip Radar.
  const fresh = items.filter((it) => !it.t.base && it.d <= NEAR_KM && it.ageMin >= 0 && it.ageMin <= FRESH_MIN).length;
  for (const it of items) it.x *= fresh >= TUNE.freshNeeded ? it.boost : 1;
  const lone = highJobs(trips).unbacked;
  for (const it of items) if (lone.has(it.t)) it.x *= UNBACKED_WEIGHT;
  // No other single driver outweighs everyone else combined (at least DRIVER_CAP trips' worth is
  // always allowed). Your own trips and the base trip aren't capped on your phone.
  // Drivers with a good track record (e.g. on a shift, 3-4 jobs an hour in one zone) may count up
  // to TRUSTED_CAP times everyone else.
  const per = new Map();
  const trusted = new Set();
  let total = 0;
  for (const it of items) {
    if (it.t.base) continue;
    total += it.x;
    per.set(driverOf(it.t), (per.get(driverOf(it.t)) || 0) + it.x);
    if (it.t.trusted) trusted.add(driverOf(it.t));
  }
  const factor = new Map();
  for (const [d, w] of per) {
    const m = trusted.has(d) ? TRUSTED_CAP : 1;
    factor.set(d, d === 'me' ? 1 : Math.min(1, Math.max(DRIVER_CAP * m, (total - w) * m) / w));
  }
  for (const it of items) {
    const x = it.t.base ? it.x : it.x * factor.get(driverOf(it.t));
    const { t, d, r, g, ageMin } = it;
    if (!t.base && band && t.km >= band.lo && t.km < band.hi && g <= 1.5 && d <= NEAR_KM) { inBandNear++; if (ageMin >= 0 && ageMin <= 60) inBandRecent++; }
    sw += x;
    swr += x * r;
    if (!closest || x > closest.x) closest = { x, ts: t.ts, km: Number.isFinite(d) ? d : null, gapH: g };
    if (g <= 1.5 && d <= NEAR_KM) { near++; if (isSurgeTrip(t, w, est, c)) surgeNear++; }
    if (ageMin >= 0 && ageMin <= 90 && d <= NEAR_KM) recent++;
  }
  const m = (swr + priorW * priorLog) / (sw + priorW);
  return { lift: Math.exp(m) - 1, near, surgeNear, recent, weight: sw, closest, inBandNear, inBandRecent };
}

// Fares vs the formula in 3-hour blocks, for the "By time of day" table.
export function byTimeBlock(trips) {
  const all = withBase(trips);
  const w = fitWeights(trips);
  const est = timeEstimator(all);
  const c = fitCommission(trips);
  const blocks = Array.from({ length: 8 }, (_, i) => ({ from: i * 3, to: i * 3 + 3, n: 0, surge: 0, sum: 0 }));
  for (const t of all) {
    if (t.event) continue;
    const r = ratioToFormula(t, w, est, c);
    if (r === null) continue;
    const b = blocks[Math.floor(hourOf(t.ts) / 3) % 8];
    b.n++;
    b.sum += r;
    if (isSurgeTrip(t, w, est, c)) b.surge++;
  }
  return blocks.map((b) => ({ ...b, lift: b.n ? Math.exp(b.sum / b.n) - 1 : null }));
}

// ---- Surge ----
// Grab doesn't publish a surge %, so it's learned: start from a guess (+20%), and with each
// surge-tagged trip move toward how far surge trips really paid above the normal-price formula,
// mostly trips near this hour. The guess and the all-hours average each count as one trip, so a
// single surge trip can't swing it.
export const SURGE_START = 0.2;
// Airport trips are tracked the same way, to see whether they're priced differently: starting
// at +0% (no assumption) and learning from airport-tagged trips.
export const AIRPORT_START = 0;
export function airportLift(trips, ts) { return surgeLift(trips, ts, 'airport', AIRPORT_START); }
export function surgeLift(trips, ts, kind = 'surge', startLift = SURGE_START) {
  const all = withBase(trips);
  const w = fitWeights(trips);
  const est = timeEstimator(all);
  const c = fitCommission(trips);
  const h = hourOf(ts);
  const rs = [];
  for (const t of all) {
    if (t.event || !Number.isFinite(t.ts)) continue;
    if (kind === 'surge' ? !isSurgeTrip(t, w, est, c) : t.surge !== kind) continue;
    const r = ratioToFormula(t, w, est, c);
    if (r !== null) rs.push({ r, g: hourGap(hourOf(t.ts), h), k: kind === 'surge' && highJobs(trips).unbacked.has(t) ? UNBACKED_WEIGHT : 1 });
  }
  const start = Math.log(1 + startLift);
  // The range surge jobs have paid (middle 80% once there are 5, else lowest to highest).
  const range = (() => {
    if (kind !== 'surge') return null;
    if (!rs.length) return { lo: SURGE_PRICE_MIN, hi: 0.4, guess: true };
    const xs = (rs.some((x) => x.k === 1) ? rs.filter((x) => x.k === 1) : rs).map((x) => Math.exp(x.r) - 1).sort((a, b) => a - b);
    const q = (p) => xs[Math.min(xs.length - 1, Math.max(0, Math.round(p * (xs.length - 1))))];
    const got = xs.length >= 5 ? { lo: q(0.1), hi: q(0.9) } : { lo: xs[0], hi: xs[xs.length - 1] };
    // Until there are TUNE.rangeBlendUntil surge jobs, blend with the starting range (+15% to +40%),
    // so one job nudges it instead of replacing it.
    const k = Math.min(1, xs.length / Math.max(1, TUNE.rangeBlendUntil));
    return { lo: SURGE_PRICE_MIN * (1 - k) + got.lo * k, hi: 0.4 * (1 - k) + got.hi * k };
  })();
  if (!rs.length) return { lift: startLift, n: 0, near: 0, guess: true, range };
  const overall = rs.reduce((s, x) => s + x.k * x.r, 0) / rs.reduce((s, x) => s + x.k, 0);
  let sw = 0;
  let swr = 0;
  let near = 0;
  for (const x of rs) {
    const k = x.k * Math.exp(-(x.g * x.g) / (2 * HOUR_SD * HOUR_SD));
    sw += k;
    swr += k * x.r;
    if (x.g <= 1.5) near++;
  }
  return { lift: Math.exp((swr + overall + start) / (sw + 2)) - 1, n: rs.length, near, guess: false, range };
}

// How far an actual fare sits above the normal-price formula (for spotting untagged surge).
export const SURGE_HINT = 0.15;

// ---- Earnings by distance band (beta Window) ----
// For a typical trip in each band (the middle of your trips in it once there are 3, else 5 / 15 /
// 25 km): what you'd earn at normal price, with surge, and "now" — normal adjusted by how fares
// around this hour have been running. The state compares now with normal: good (10% or more
// above), bad (10% or more below), or normal.
export const EARN_BANDS = [
  { id: 'short', label: '< 10 km', lo: 0, hi: 10, km: 5 },
  { id: 'mid', label: '10–20 km', lo: 10, hi: 20, km: 15 },
  { id: 'long', label: '> 20 km', lo: 20, hi: Infinity, km: 25 },
];
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

// With `loc`: "now" comes from trips near here around this hour; if there are none yet, from all
// areas at this hour (scope says which).
// opts.event: the event letting out where you are (eventFor). Then "now" is the normal price
// lifted by what event trips have paid (eventLift; +0% until there are some), state 'event'.
// Normal and surge prices stay as on any other day: event trips never feed them.
export function bandOutlook(trips, ts, loc = null, opts = {}) {
  const all = withBase(trips);
  const w = fitWeights(trips);
  const est = timeEstimator(all);
  const c = fitCommission(trips);
  // Always the closest available data, blended: no switch between "near you" and "all areas".
  const raining = Boolean(opts.raining);
  const tod = timeOfDay(trips, ts, loc, { raining });
  const scope = !loc ? 'all' : tod.near ? 'here' : 'nearest';
  const surge = surgeLift(trips, ts);
  const ev = opts.event ? eventLift(trips) : null;
  const wet = raining && !ev ? rainLift(trips) : null;
  return EARN_BANDS.map((b) => {
    const inBand = all.filter((t) => t.km >= b.lo && t.km < b.hi);
    const km = inBand.length >= 3 ? median(inBand.map((t) => t.km)) : b.km;
    const normalPaid = passengerFare(w, km, est(km)).fare;
    const normal = driverEarns(c, normalPaid);
    // Each band leans on trips of its own distance, falling back on the overall picture.
    const own = timeOfDay(trips, ts, loc, { band: b, prior: tod.lift, raining });
    const nowLift = ev ? ev.lift : own.lift;
    const now = driverEarns(c, normalPaid * (1 + nowLift));
    const withSurge = driverEarns(c, normalPaid * (1 + surge.lift));
    const surgeLo = surge.range ? driverEarns(c, normalPaid * (1 + surge.range.lo)) : withSurge;
    const surgeHi = surge.range ? driverEarns(c, normalPaid * (1 + surge.range.hi)) : withSurge;
    const vs = now / normal - 1;
    const state = ev ? 'event' : vs >= 0.1 ? 'good' : vs <= -0.1 ? 'bad' : 'normal';
    return { ...b, km, normal, now, surge: withSurge, surgeLo, surgeHi, vs, state, eventTrips: ev ? ev.n : null, raining: Boolean(wet), rainTrips: wet ? wet.n : null, rainLift: wet ? wet.lift : null, trips: inBand.length, nearHour: tod.near, recent: tod.recent, scope, closest: tod.closest, weight: tod.weight, inBandNear: own.inBandNear, inBandRecent: own.inBandRecent };
  });
}

// ---- Latest job (beta Window) ----
// The most recent job in the dataset (yours or another driver's) and how it paid against normal.
export function latestJob(trips, ts = Date.now(), withinMs = 3 * 3600 * 1000) {
  const recent = trips.filter((t) => Number.isFinite(t.ts) && ts - t.ts >= 0 && ts - t.ts <= withinMs && t.km > 0 && (t.earned > 0 || t.actual > 0));
  if (!recent.length) return null;
  const t = recent.reduce((a, b) => (b.ts > a.ts ? b : a));
  const w = fitWeights(trips);
  const est = timeEstimator(withBase(trips));
  const c = fitCommission(trips);
  const normalPaid = passengerFare(w, t.km, tripTime(t, est)).fare;
  const normalEarn = driverEarns(c, normalPaid);
  const earned = t.earned > 0 ? t.earned : driverEarns(c, t.actual);
  return { trip: t, earned, normalEarn, vs: earned / normalEarn - 1 };
}

// ---- Events ----
// A concert letting out isn't a normal night. Trips saved within EVENT_KM of a listed event's
// venue, from EVENT_BEFORE_MIN before it ends to EVENT_AFTER_MIN after, are marked as event trips:
// they're left out of the normal fare formula, the time-of-day / place adjustment and the surge %,
// and learned on their own (eventLift). They still teach Grab's cut, which doesn't change with demand.
export const EVENT_KM = 1.5;
export const EVENT_BEFORE_MIN = 30;
export const EVENT_AFTER_MIN = 90;
export function eventFor(t, events) {
  if (!events || !events.length || !(t.lat && t.lng) || !Number.isFinite(t.ts)) return null;
  for (const e of events) {
    if (!Number.isFinite(e.ends_at)) continue;
    if (t.ts < e.ends_at - EVENT_BEFORE_MIN * 60000 || t.ts > e.ends_at + EVENT_AFTER_MIN * 60000) continue;
    if (kmApart(t, e) <= EVENT_KM) return e;
  }
  return null;
}
// The same trips, with event trips marked (copies; the originals aren't changed).
export function markEvents(trips, events) {
  if (!events || !events.length) return trips;
  return trips.map((t) => {
    const e = eventFor(t, events);
    return e ? { ...t, event: e.id, eventName: e.name } : t;
  });
}
// How event trips paid against normal. A start of +0% counts as one trip.
export function eventLift(trips) {
  const all = withBase(trips);
  const w = fitWeights(trips);
  const est = timeEstimator(all);
  const c = fitCommission(trips);
  const rs = [];
  for (const t of all) {
    if (!t.event) continue;
    const r = ratioToFormula(t, w, est, c);
    if (r !== null) rs.push(r);
  }
  if (!rs.length) return { lift: 0, n: 0, guess: true };
  return { lift: Math.exp(rs.reduce((a, b) => a + b, 0) / (rs.length + 1)) - 1, n: rs.length, guess: false };
}

// The green-arrow test: did Grab's green arrow mean the job paid more? Jobs logged with the arrow
// seen (t.arrow 1) against jobs without it (0), each as the average vs the normal price. Before
// the arrow was recorded, a Surge tag meant "arrow seen" and Normal "no arrow": those are counted
// apart (older), so the new, careful observations can be read on their own.
export function arrowCompare(trips) {
  const all = withBase(trips);
  const w = fitWeights(trips);
  const est = timeEstimator(all);
  const c = fitCommission(trips);
  const g = () => ({ n: 0, sum: 0, rs: [] });
  const out = { logged: { arrow: g(), none: g() }, older: { arrow: g(), none: g() } };
  for (const t of all) {
    if (t.base || t.event || t.surge === 'airport' || !(t.actual > 0)) continue;
    const r = ratioToFormula(t, w, est, c);
    if (r === null) continue;
    const set = t.arrow === 1 || t.arrow === 0 ? out.logged : out.older;
    const seen = t.arrow === 1 || t.arrow === 0 ? t.arrow === 1 : t.surge === 'surge';
    const b = seen ? set.arrow : set.none;
    b.n++; b.sum += r; b.rs.push(Math.exp(r) - 1);
  }
  const fin = (b) => {
    const xs = b.rs.sort((x, y) => x - y);
    return { n: b.n, lift: b.n ? Math.exp(b.sum / b.n) - 1 : null, lo: xs[0] ?? null, hi: xs[xs.length - 1] ?? null, over15: xs.filter((x) => x >= SURGE_PRICE_MIN).length };
  };
  return { logged: { arrow: fin(out.logged.arrow), none: fin(out.logged.none) }, older: { arrow: fin(out.older.arrow), none: fin(out.older.none) } };
}

// How rain trips have paid against normal (observation only). A start of +0% counts as one trip.
export function rainLift(trips) {
  const all = withBase(trips);
  const w = fitWeights(trips);
  const est = timeEstimator(all);
  const c = fitCommission(trips);
  const rs = [];
  for (const t of all) {
    if (t.rain !== 1 || t.event) continue;
    const r = ratioToFormula(t, w, est, c);
    if (r !== null) rs.push(r);
  }
  if (!rs.length) return { lift: 0, n: 0, guess: true };
  return { lift: Math.exp(rs.reduce((a, b) => a + b, 0) / (rs.length + 1)) - 1, n: rs.length, guess: false };
}

// For Radar's banner: the event letting out nearest to you, within NEAR km, from an hour before it
// ends to EVENT_AFTER_MIN after.
export function eventNear(events, loc, ts = Date.now(), nearKm = 3) {
  if (!loc || !events || !events.length) return null;
  let best = null;
  for (const e of events) {
    if (!Number.isFinite(e.ends_at) || ts < e.ends_at - 60 * 60000 || ts > e.ends_at + EVENT_AFTER_MIN * 60000) continue;
    const km = kmApart(loc, e);
    if (km <= nearKm && (!best || km < best.km)) best = { event: e, km };
  }
  return best;
}
