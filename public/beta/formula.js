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

// A trip can teach the formula if it's normal-priced, complete, and not held up by the minimum.
export function usable(t) {
  if (t.surge !== 'normal' || !(t.km > 0) || !(t.min > 0) || !(t.actual > 0)) return false;
  return t.actual - (t.erp || 0) > MIN_PASSENGER + 0.005;
}

// Best weights: least squares on what the passenger paid (minus ERP / tolls), with the gentle
// pull toward the seed. Always includes the base trip.
export function fitWeights(trips, { includeBase = true } = {}) {
  const rows = (includeBase ? withBase(trips) : trips).filter(usable);
  if (!rows.length) return { ...SEED, n: 0 };
  const X = rows.map((t) => [1, t.km, t.min]);
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
  for (const t of mine) {
    const w = fitWeights(trips.filter((o) => o !== t));
    const p = passengerFare(w, t.km, t.min, t.erp).fare;
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
export function fitCommission(trips) {
  const cuts = withBase(trips).map(cutOf).filter(Boolean);
  const rates = cuts.map((c) => c.rate);
  const avgRate = rates.reduce((s, r) => s + r, 0) / rates.length;
  const lo = Math.min(...rates);
  const hi = Math.max(...rates);
  const info = { n: cuts.length, avgRate, spread: hi - lo, lo, hi };
  if (cuts.length < 3) return { kind: 'average', keep: 1 - avgRate, fixed: 0, ...info };
  const w = lsq(cuts.map((c) => [1, c.paid]), cuts.map((c) => c.earned));
  if (!w) return { kind: 'average', keep: 1 - avgRate, fixed: 0, ...info };
  // Call it a flat % unless the fixed part is clearly there.
  return Math.abs(w[0]) < 0.1
    ? { kind: 'flat', keep: 1 - avgRate, fixed: 0, ...info }
    : { kind: 'percent+fixed', keep: w[1], fixed: w[0], ...info };
}

// What the driver would earn on a trip the passenger paid `paid` for.
export function driverEarns(model, paid, erp = 0) {
  return r2(model.keep * (paid - (erp || 0)) + model.fixed + (erp || 0));
}

// CSV in the research dataset's column order, ready to add to research/fare-formula/trips.csv.
export function toCsv(trips) {
  const head = 'id,date,time,ride_type,grab_km,grab_min,actual_min,passenger_fare,driver_earned,erp,tolls,platform_fee,other_surcharge,surge_flag,pickup_area,drop_area,pickup_fare,trip_fare,fuel_surcharge,notes';
  const pad = (n) => String(n).padStart(2, '0');
  const lines = trips.filter((t) => !t.base).map((t, i) => {
    const d = new Date(t.ts);
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return [i + 1, date, time, 'Standard', t.km, t.min, '', t.actual ?? '', t.earned ?? '', t.erp || '', '', '', '', t.surge, '', '', '', '', '', `formula said ${t.predicted ?? ''}`].join(',');
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

function ratioToFormula(t, w) {
  if (!(t.actual > 0) || !(t.km > 0) || !(t.min > 0)) return null;
  const p = passengerFare(w, t.km, t.min).fare; // without ERP: compare like with like
  const r = Math.log((t.actual - (t.erp || 0)) / p);
  return Number.isFinite(r) ? r : null;
}

export function timeOfDay(trips, ts) {
  const all = withBase(trips);
  const w = fitWeights(trips);
  const h = hourOf(ts);
  let sw = 0;
  let swr = 0;
  let near = 0;
  let surgeNear = 0;
  for (const t of all) {
    const r = ratioToFormula(t, w);
    if (r === null) continue;
    const g = hourGap(hourOf(t.ts), h);
    const x = Math.exp(-(g * g) / (2 * HOUR_SD * HOUR_SD));
    sw += x;
    swr += x * r;
    if (g <= 1.5) { near++; if (t.surge === 'surge') surgeNear++; }
  }
  const m = swr / (sw + 1);
  return { lift: Math.exp(m) - 1, near, surgeNear, weight: sw };
}

// Fares vs the formula in 3-hour blocks, for the "By time of day" table.
export function byTimeBlock(trips) {
  const all = withBase(trips);
  const w = fitWeights(trips);
  const blocks = Array.from({ length: 8 }, (_, i) => ({ from: i * 3, to: i * 3 + 3, n: 0, surge: 0, sum: 0 }));
  for (const t of all) {
    const r = ratioToFormula(t, w);
    if (r === null) continue;
    const b = blocks[Math.floor(hourOf(t.ts) / 3) % 8];
    b.n++;
    b.sum += r;
    if (t.surge === 'surge') b.surge++;
  }
  return blocks.map((b) => ({ ...b, lift: b.n ? Math.exp(b.sum / b.n) - 1 : null }));
}
