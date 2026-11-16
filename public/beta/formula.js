// Formula lab (beta): reverse-engineers Grab's published passenger fare formula from exact trips,
// and Grab's commission from what the driver took home. Pure functions, shared by the page and
// the tests.
//
// Grab's published shape for GrabCar (non-surged, so the demand multiplier is 1):
//   passenger fare = max(S$8.10, base + per km × distance + per min × time) + ERP / tolls
//   driver earns   = passenger fare − Grab's cut   (ERP and tolls passed through to the driver)

export const MIN_PASSENGER = 8.10; // tested as a passenger: normal GrabCar never charges less

// Starting guess before any trips. Each saved trip pulls the weights toward the real numbers.
export const SEED = { base: 2.5, perKm: 0.5, perMin: 0.16 };
export const SEED_CUT = 0.2;

// How far one trip's worth of evidence may move each weight: a gentle pull back toward the seed,
// so 1–3 trips give sensible weights instead of wild ones, and it fades as trips add up.
const PRIOR = { base: 1.5, perKm: 0.15, perMin: 0.08 };
const TERMS = ['base', 'perKm', 'perMin'];

const r2 = (n) => Math.round(n * 100) / 100;

export function passengerFare(w, km, min, erp = 0) {
  const core = w.base + w.perKm * km + w.perMin * min;
  const atMinimum = core < MIN_PASSENGER;
  return { core, atMinimum, fare: r2(Math.max(MIN_PASSENGER, core) + (erp || 0)) };
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

// A trip can teach the formula if it's normal-priced, complete, and not held up by the minimum.
export function usable(t) {
  if (t.surge !== 'normal' || !(t.km > 0) || !(t.min > 0) || !(t.actual > 0)) return false;
  return t.actual - (t.erp || 0) > MIN_PASSENGER + 0.005;
}

// Best weights for these trips: least squares on the formula part of the fare (actual minus ERP),
// with the gentle pull toward the seed described above.
export function fitWeights(trips) {
  const rows = trips.filter(usable);
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

// How good the formula is on trips it hasn't seen: each one predicted from all the others.
export function looError(trips) {
  const rows = trips.filter(usable);
  if (rows.length < 2) return null;
  let abs = 0;
  let rel = 0;
  for (const t of rows) {
    const w = fitWeights(trips.filter((o) => o !== t));
    const p = passengerFare(w, t.km, t.min, t.erp).fare;
    abs += Math.abs(p - t.actual);
    rel += Math.abs(p - t.actual) / t.actual;
  }
  return { n: rows.length, avg: abs / rows.length, pct: rel / rows.length };
}

// ---- Grab's cut ----
// Measured on the fare without ERP / tolls, which reach the driver untouched.
export function cutOf(t) {
  if (!(t.actual > 0) || !(t.earned > 0)) return null;
  const fare = t.actual - (t.erp || 0);
  const earned = t.earned - (t.erp || 0);
  return { fare, earned, cut: fare - earned, rate: (fare - earned) / fare };
}

// Fixed % or % plus a fixed amount? With 3+ trips, fits earned = keep × fare + fixed.
export function fitCommission(trips) {
  const cuts = trips.map(cutOf).filter(Boolean);
  if (!cuts.length) return { kind: 'seed', keep: 1 - SEED_CUT, fixed: 0, n: 0 };
  const rates = cuts.map((c) => c.rate);
  const avgRate = rates.reduce((s, r) => s + r, 0) / rates.length;
  const lo = Math.min(...rates);
  const hi = Math.max(...rates);
  const spread = hi - lo;
  if (cuts.length < 3) return { kind: 'average', keep: 1 - avgRate, fixed: 0, n: cuts.length, avgRate, spread, lo, hi };
  const w = lsq(cuts.map((c) => [1, c.fare]), cuts.map((c) => c.earned));
  if (!w) return { kind: 'average', keep: 1 - avgRate, fixed: 0, n: cuts.length, avgRate, spread, lo, hi };
  // Call it a flat % unless the fixed part is clearly there.
  const flat = Math.abs(w[0]) < 0.1;
  return flat
    ? { kind: 'flat', keep: 1 - avgRate, fixed: 0, n: cuts.length, avgRate, spread, lo, hi }
    : { kind: 'percent+fixed', keep: w[1], fixed: w[0], n: cuts.length, avgRate, spread, lo, hi };
}

export function driverEarns(model, fare, erp = 0) {
  return r2(model.keep * (fare - (erp || 0)) + model.fixed + (erp || 0));
}

// CSV in the research dataset's column order, ready to add to research/fare-formula/trips.csv.
export function toCsv(trips) {
  const head = 'id,date,time,ride_type,grab_km,grab_min,actual_min,passenger_fare,driver_earned,erp,tolls,platform_fee,other_surcharge,surge_flag,pickup_area,drop_area,notes';
  const pad = (n) => String(n).padStart(2, '0');
  const lines = trips.map((t, i) => {
    const d = new Date(t.ts);
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return [i + 1, date, time, 'GrabCar', t.km, t.min, '', t.actual ?? '', t.earned ?? '', t.erp || '', '', '', '', t.surge, '', '', `predicted ${t.predicted ?? ''}`].join(',');
  });
  return [head, ...lines].join('\n') + '\n';
}
