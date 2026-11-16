// Fits Grab's passenger fare formula and commission from trips.csv. No dependencies.
//   node research/fare-formula/fit.mjs [path/to/trips.csv]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Known facts, tested as a passenger (normal GrabCar, Singapore):
//   - the minimum a passenger pays is S$8.10, however short the trip.
const MIN_PASSENGER_FARE = 8.10;

// Which service the formula is for. Only standard GrabCar (private hire) is fitted; GrabTaxi
// (and anything else) runs on different rates and is reported separately, never mixed in.
const FITTED = 'GrabCar';
function service(name) {
  const n = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!n) return 'unknown';
  if (n.includes('taxi')) return 'GrabTaxi';
  if (['grabcar', 'grabcarstandard', 'standard', 'car'].includes(n)) return 'GrabCar';
  if (n.includes('justgrab')) return 'JustGrab'; // can be a taxi or a car: kept apart
  return name;
}

const file = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'trips.csv');
const [head, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
const cols = head.split(',');
const NUMERIC = ['grab_km', 'grab_min', 'actual_min', 'passenger_fare', 'driver_earned', 'erp', 'tolls', 'platform_fee', 'other_surcharge'];
const num = (v) => (v === undefined || v.trim() === '' ? null : Number(v));
const trips = lines.filter((l) => l.trim()).map((l) => {
  const v = l.split(',');
  const r = Object.fromEntries(cols.map((c, i) => [c, (v[i] ?? '').trim()]));
  for (const c of NUMERIC) r[c] = num(r[c]);
  r.min = r.grab_min ?? r.actual_min;
  r.addons = (r.erp || 0) + (r.tolls || 0) + (r.platform_fee || 0) + (r.other_surcharge || 0);
  r.core = r.passenger_fare - r.addons; // the part the distance/time formula sets
  r.service = service(r.ride_type);
  // Paid exactly the minimum: the formula didn't set this fare, the floor did.
  r.atMinimum = Math.abs(r.passenger_fare - MIN_PASSENGER_FARE) < 0.005;
  return r;
});

const $ = (n) => `S$${n.toFixed(2)}`;
const pct = (n) => `${(n * 100).toFixed(1)}%`;
console.log(`${trips.length} trips in ${path.basename(file)}`);
if (!trips.length) process.exit(0);

// Least squares via the normal equations. Returns null if the terms can't be told apart.
function lsq(X, y) {
  const k = X[0].length;
  const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0)));
  const b = Array.from({ length: k }, (_, i) => X.reduce((s, r, n) => s + r[i] * y[n], 0));
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    if (Math.abs(A[c][c]) < 1e-9) return null;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j < k; j++) A[r][j] -= f * A[c][j];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}
const dot = (x, w) => x.reduce((s, v, i) => s + v * w[i], 0);

// ---- passenger formula, normal trips only ----
const byService = {};
for (const t of trips) byService[t.service] = (byService[t.service] || 0) + 1;
console.log(`By service: ${Object.entries(byService).map(([k, v]) => `${k} ${v}`).join(', ')}. Fitting ${FITTED} only.`);
const car = trips.filter((t) => t.service === FITTED);
const atMin = car.filter((t) => t.atMinimum);
if (atMin.length) {
  const longest = Math.max(...atMin.map((t) => t.grab_km));
  console.log(`At the S$${MIN_PASSENGER_FARE.toFixed(2)} minimum: ${atMin.length} trip(s), longest ${longest} km. Left out of the fit; they show where the minimum stops applying.`);
}
const below = car.filter((t) => t.passenger_fare > 0 && t.passenger_fare < MIN_PASSENGER_FARE - 0.005);
for (const t of below) console.log(`  check #${t.id}: passenger paid ${t.passenger_fare} — below the S$${MIN_PASSENGER_FARE.toFixed(2)} minimum (promo, or a different service?)`);
const normal = car.filter((t) => t.surge_flag === 'normal' && t.grab_km > 0 && t.core > 0 && !t.atMinimum && t.passenger_fare >= MIN_PASSENGER_FARE);
const withMin = normal.filter((t) => t.min > 0);
const models = [
  { name: 'base + km', rows: normal, x: (t) => [1, t.grab_km], terms: ['base', 'per km'] },
  { name: 'base + km + min', rows: withMin, x: (t) => [1, t.grab_km, t.min], terms: ['base', 'per km', 'per min'] },
];
console.log(`\nPassenger formula (normal trips, fare minus add-ons): ${normal.length} trips, ${withMin.length} with minutes`);
for (const m of models) {
  const need = m.terms.length + 1;
  if (m.rows.length < need) { console.log(`  ${m.name}: needs at least ${need} trips (has ${m.rows.length})`); continue; }
  const w = lsq(m.rows.map(m.x), m.rows.map((t) => t.core));
  if (!w) { console.log(`  ${m.name}: trips too alike to separate the terms yet (need more variety)`); continue; }
  // Honest error: predict each trip from a fit made without it.
  const loo = [];
  for (const t of m.rows) {
    const others = m.rows.filter((o) => o !== t);
    const wo = others.length >= m.terms.length ? lsq(others.map(m.x), others.map((o) => o.core)) : null;
    if (wo) loo.push({ t, err: dot(m.x(t), wo) - t.core });
  }
  const mae = loo.length ? loo.reduce((s, e) => s + Math.abs(e.err), 0) / loo.length : NaN;
  console.log(`  ${m.name}: ${m.terms.map((n, i) => `${n} ${$(w[i])}`).join(' · ')}   error on unseen trips ±${Number.isFinite(mae) ? $(mae) : 'n/a'}`);
  // Outliers: judged against the middle error, so one big miss can't hide itself. Then re-fit
  // without them, since a hidden surge pulls every number off.
  const absErr = loo.map((e) => Math.abs(e.err)).sort((a, b) => a - b);
  const typical = absErr[Math.floor(absErr.length / 2)] || 0;
  const out = loo.length >= 6 ? loo.filter((e) => Math.abs(e.err) > Math.max(0.5, 4 * typical)) : [];
  for (const e of out) console.log(`    outlier #${e.t.id} ${e.t.date} ${e.t.time}: formula off by ${$(e.err)} (hidden surge, promo or an add-on?)`);
  if (out.length) {
    const clean = m.rows.filter((t) => !out.some((e) => e.t === t));
    const wc = clean.length >= need ? lsq(clean.map(m.x), clean.map((t) => t.core)) : null;
    if (wc) {
      const errs = clean.map((t) => {
        const others = clean.filter((o) => o !== t);
        const wo = lsq(others.map(m.x), others.map((o) => o.core));
        return wo ? Math.abs(dot(m.x(t), wo) - t.core) : 0;
      });
      const cmae = errs.reduce((s, v) => s + v, 0) / errs.length;
      console.log(`    without outliers (${clean.length} trips): ${m.terms.map((n, i) => `${n} ${$(wc[i])}`).join(' · ')}   error on unseen trips ±${$(cmae)}`);
    }
  }
}

// ---- Grab's cut ----
const paid = car.filter((t) => t.passenger_fare > 0 && t.driver_earned > 0);
console.log(`\nGrab's cut (${FITTED}): ${paid.length} trips with both numbers`);
if (paid.length) {
  // ERP and tolls are usually passed straight to the driver, so measure the cut on the rest.
  const cuts = paid.map((t) => {
    const pass = (t.erp || 0) + (t.tolls || 0);
    const fare = t.passenger_fare - pass;
    const earned = t.driver_earned - pass;
    return { t, fare, earned, cut: fare - earned, rate: (fare - earned) / fare };
  });
  for (const c of cuts) {
    console.log(`  #${c.t.id} ${c.t.date} ${c.t.time} ${c.t.grab_km} km: passenger ${$(c.t.passenger_fare)}, earned ${$(c.t.driver_earned)}, cut ${$(c.cut)} (${pct(c.rate)})`);
  }
  const rates = cuts.map((c) => c.rate).sort((a, b) => a - b);
  console.log(`  average ${pct(rates.reduce((s, r) => s + r, 0) / rates.length)}, middle ${pct(rates[Math.floor(rates.length / 2)])}, range ${pct(rates[0])}–${pct(rates[rates.length - 1])}`);
  if (cuts.length >= 3) {
    // earned = k × fare + c. A flat % has c ≈ 0; a % plus a fixed fee has c < 0.
    const w = lsq(cuts.map((c) => [1, c.fare]), cuts.map((c) => c.earned));
    if (w) {
      const fixed = Math.abs(w[0]) >= 0.05 ? ` ${w[0] < 0 ? '− a fixed' : '+ a fixed'} ${$(Math.abs(w[0]))}` : '';
      console.log(`  as a formula: driver gets ${pct(w[1])} of the fare${fixed}  →  Grab keeps ${pct(1 - w[1])}${fixed ? ` and ${w[0] < 0 ? 'takes' : 'adds back'} ${$(Math.abs(w[0]))} per job` : ''}`);
    }
  }
}
