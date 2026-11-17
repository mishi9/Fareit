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
export const withBase = (trips) => [...BASE_TRIPS, ...trips.filter((t) => !t.base)];

// ---- Trip time ----
// The passenger is quoted before a driver is matched, so the price depends on pickup → drop-off
// only. `min` is that trip time (the navigation's estimate from the pickup point). The job
// card's total also includes the driver's way to the pickup, so it's kept apart as `cardMin`
// and never used as trip time. When a trip has no trip time, it's estimated from the km.
const DEFAULT_TIME = { a: 3, b: 1.1 }; // minutes ≈ 3 + 1.1 × km until real trip times teach it

export function timeEstimator(trips) {
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
  if (t.surge !== 'normal' || !(t.km > 0) || !(t.actual > 0)) return false;
  return t.actual - (t.erp || 0) > MIN_PASSENGER + 0.005;
}

// Best weights: least squares on what the passenger paid (minus ERP / tolls), with the gentle
// pull toward the seed. Always includes the base trip.
export function fitWeights(trips, { includeBase = true } = {}) {
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
  const w = lsq(X, y);
  if (!w) return { ...SEED, n: rows.length };
  return { base: w[0], perKm: w[1], perMin: w[2], n: rows.length };
}

// How good the formula is on trips it hasn't seen: each of your trips predicted from all the
// others (and the base trip).
export function looError(trips) {
  const mine = trips.filter((t) => !t.base && usable(t));
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
  return { n: mine.length, avg: abs / mine.length, pct: rel / mine.length };
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

export function fitCommission(trips) {
  // Trips paid at the driver's S$6.20 floor follow the floor, not the usual rule: leave them out.
  const all = withBase(trips).filter((t) => cutOf(t) && !(Math.abs(t.earned - (t.erp || 0) - MIN_DRIVER) < 0.005));
  const low = all.filter(isLowCut);
  const cuts = all.filter((t) => !isLowCut(t)).map(cutOf);
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
    const notes = [`formula said ${t.predicted ?? ''}`, t.cardMin ? `card total ${t.cardMin} min` : '', t.pickupKm ? `pickup ${t.pickupKm} km` : ''].filter(Boolean).join('; ');
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

function ratioToFormula(t, w, est) {
  if (!(t.actual > 0) || !(t.km > 0)) return null;
  const p = passengerFare(w, t.km, tripTime(t, est)).fare; // without ERP: compare like with like
  const r = Math.log((t.actual - (t.erp || 0)) / p);
  return Number.isFinite(r) ? r : null;
}

// With `loc`, only trips saved near there count, more the closer they are (1 km 80%, 3 km 14%,
// 5 km 0.4%): Tampines at 2am isn't Orchard at 2am. Trips saved without a location don't count.
const PLACE_SD_KM = 1.5;
export const NEAR_KM = 3;
const kmApart = (a, b) => {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

export function timeOfDay(trips, ts, loc = null) {
  const all = withBase(trips);
  const w = fitWeights(trips);
  const est = timeEstimator(all);
  const h = hourOf(ts);
  let sw = 0;
  let swr = 0;
  let near = 0;
  let surgeNear = 0;
  for (const t of all) {
    if (!Number.isFinite(t.ts)) continue;
    let place = 1;
    let d = 0;
    if (loc) {
      if (!(t.lat && t.lng)) continue;
      d = kmApart(loc, t);
      place = Math.exp(-(d * d) / (2 * PLACE_SD_KM * PLACE_SD_KM));
    }
    const r = ratioToFormula(t, w, est);
    if (r === null) continue;
    const g = hourGap(hourOf(t.ts), h);
    if (loc && d > NEAR_KM && g > 1.5) continue;
    const x = Math.exp(-(g * g) / (2 * HOUR_SD * HOUR_SD)) * place;
    sw += x;
    swr += x * r;
    if (g <= 1.5 && d <= NEAR_KM) { near++; if (t.surge === 'surge') surgeNear++; }
  }
  const m = swr / (sw + 1);
  return { lift: Math.exp(m) - 1, near, surgeNear, weight: sw };
}

// Fares vs the formula in 3-hour blocks, for the "By time of day" table.
export function byTimeBlock(trips) {
  const all = withBase(trips);
  const w = fitWeights(trips);
  const est = timeEstimator(all);
  const blocks = Array.from({ length: 8 }, (_, i) => ({ from: i * 3, to: i * 3 + 3, n: 0, surge: 0, sum: 0 }));
  for (const t of all) {
    const r = ratioToFormula(t, w, est);
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
  const h = hourOf(ts);
  const rs = [];
  for (const t of all) {
    if (t.surge !== kind || !Number.isFinite(t.ts)) continue;
    const r = ratioToFormula(t, w, est);
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
export function bandOutlook(trips, ts, loc = null) {
  const all = withBase(trips);
  const w = fitWeights(trips);
  const est = timeEstimator(all);
  const c = fitCommission(trips);
  const here = loc ? timeOfDay(trips, ts, loc) : null;
  const scope = here && here.near ? 'here' : 'all';
  const tod = scope === 'here' ? here : timeOfDay(trips, ts);
  const surge = surgeLift(trips, ts);
  return EARN_BANDS.map((b) => {
    const inBand = all.filter((t) => t.km >= b.lo && t.km < b.hi);
    const km = inBand.length >= 3 ? median(inBand.map((t) => t.km)) : b.km;
    const normalPaid = passengerFare(w, km, est(km)).fare;
    const normal = driverEarns(c, normalPaid);
    const nowLift = tod.near ? tod.lift : 0;
    const now = driverEarns(c, normalPaid * (1 + nowLift));
    const withSurge = driverEarns(c, normalPaid * (1 + surge.lift));
    const vs = now / normal - 1;
    const state = vs >= 0.1 ? 'good' : vs <= -0.1 ? 'bad' : 'normal';
    return { ...b, km, normal, now, surge: withSurge, vs, state, trips: inBand.length, nearHour: tod.near, scope };
  });
}
