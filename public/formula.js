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

// How far one trip's worth of evidence may move each weight: a gentle pull back toward the seed,
// so a few trips give sensible weights instead of wild ones. It fades as trips add up.
const PRIOR = { base: 3, perKm: 0.3, perMin: 0.16 };
const TERMS = ['base', 'perKm', 'perMin'];

const r2 = (n) => Math.round(n * 100) / 100;

// What the passenger pays for a trip, by the formula.
export function passengerFare(w, km, min, erp = 0) {
  const core = w.base + w.perKm * km + w.perMin * min;
  const atMinimum = core < MIN_PASSENGER;
  return { core: r2(core), atMinimum, fare: r2(Math.max(MIN_PASSENGER, core) + (erp || 0)) };
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
    if (!cache.has(trips)) cache.set(trips, fn(trips));
    return cache.get(trips);
  };
};

export const withBase = memo((trips) => [...BASE_TRIPS, ...trips.filter((t) => !t.base)]);

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

// A trip can teach the formula if it's normal-priced, complete, and not held up by the minimum.
export function usable(t) {
  if (t.event || t.surge !== 'normal' || !(t.km > 0) || !(t.actual > 0)) return false;
  return t.actual - (t.erp || 0) > MIN_PASSENGER + 0.005;
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
  if (!rows.length) return { ...SEED, n: 0 };
  const est = timeEstimator(pool);
  const X = rows.map((t) => [1, t.km, tripTime(t, est)]);
  const y = rows.map((t) => t.actual - (t.erp || 0));
  TERMS.forEach((term, i) => {
    const row = [0, 0, 0];
    row[i] = 1 / PRIOR[term];
    X.push(row);
    y.push(SEED[term] / PRIOR[term]);
  });
  let w = lsq(X, y);
  if (!w) return { ...SEED, n: rows.length };
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
  return { base: w[0], perKm: w[1], perMin: w[2], n: rows.length };
}

// How good the formula is on trips it hasn't seen: each of your trips predicted from all the
// others (and the base trip).
// Tests every trip until there are more than 200; then the 200 most recent (each still predicted
// from all the others), to keep it quick. Predictions never use this; it's only the accuracy stat.
export const LOO_MAX = 200;
export const looError = memo(looErrorOf);
function looErrorOf(trips) {
  const all = trips.filter((t) => !t.base && usable(t));
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
    const x = Math.exp(-(g * g) / (2 * HOUR_SD * HOUR_SD)) * place * recentBoost(ageMin) * bandWeight(t.km, band) * sameDay * sameWeather(t, opts.raining);
    items.push({ t, d, r, g, ageMin, x });
  }
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
    if (band && t.km >= band.lo && t.km < band.hi && g <= 1.5 && d <= NEAR_KM) inBandNear++;
    sw += x;
    swr += x * r;
    if (!closest || x > closest.x) closest = { x, ts: t.ts, km: Number.isFinite(d) ? d : null, gapH: g };
    if (g <= 1.5 && d <= NEAR_KM) { near++; if (t.surge === 'surge') surgeNear++; }
    if (ageMin >= 0 && ageMin <= 90 && d <= NEAR_KM) recent++;
  }
  const m = (swr + priorW * priorLog) / (sw + priorW);
  return { lift: Math.exp(m) - 1, near, surgeNear, recent, weight: sw, closest, inBandNear };
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
    if (t.surge === 'surge') b.surge++;
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
    if (t.surge !== kind || t.event || !Number.isFinite(t.ts)) continue;
    const r = ratioToFormula(t, w, est, c);
    if (r !== null) rs.push({ r, g: hourGap(hourOf(t.ts), h) });
  }
  const start = Math.log(1 + startLift);
  if (!rs.length) return { lift: startLift, n: 0, near: 0, guess: true };
  const overall = rs.reduce((s, x) => s + x.r, 0) / rs.length;
  let sw = 0;
  let swr = 0;
  let near = 0;
  for (const x of rs) {
    const k = Math.exp(-(x.g * x.g) / (2 * HOUR_SD * HOUR_SD));
    sw += k;
    swr += k * x.r;
    if (x.g <= 1.5) near++;
  }
  return { lift: Math.exp((swr + overall + start) / (sw + 2)) - 1, n: rs.length, near, guess: false };
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
    const vs = now / normal - 1;
    const state = ev ? 'event' : wet ? 'rain' : vs >= 0.1 ? 'good' : vs <= -0.1 ? 'bad' : 'normal';
    return { ...b, km, normal, now, surge: withSurge, vs, state, eventTrips: ev ? ev.n : null, rainTrips: wet ? wet.n : null, rainLift: wet ? wet.lift : null, trips: inBand.length, nearHour: tod.near, recent: tod.recent, scope, closest: tod.closest, weight: tod.weight, inBandNear: own.inBandNear };
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
