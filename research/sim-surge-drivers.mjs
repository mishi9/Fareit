// 5 simulated drivers around Toa Payoh, Thursday 19 Nov 2026 22:00. Before vs after the two changes.
import { bandOutlook, fitWeights, passengerFare, timeEstimator, withBase, fitCommission, driverEarns, TUNE } from '../public/formula.js';

const NOW = Date.parse('2026-11-19T22:00:00+08:00');
const TPY = { lat: 1.3343, lng: 103.8563 };
const RV = { lat: 1.2935, lng: 103.8370 };
const near = (p, dLat, dLng) => ({ lat: p.lat + dLat, lng: p.lng + dLng });
const w = fitWeights([]); const est = timeEstimator(withBase([])); const c = fitCommission([]);
let n = 0;
// A job: km, how far above the normal price (x), minutes ago, driver, where.
const job = (km, x, minsAgo, d, at = TPY) => {
  const paid = Math.round(passengerFare(w, km, est(km)).fare * (1 + x) * 100) / 100;
  return { id: `j${n++}`, ts: NOW - minsAgo * 60000, km, actual: paid, earned: Math.round(driverEarns(c, paid) * 100) / 100, surge: 'normal', ...at, shared: true, d };
};
// History: 30 normal jobs (±5%) from the 5 drivers over the past 3 weeks, evenings, around Toa Payoh.
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const history = Array.from({ length: 30 }, (_, i) => {
  const day = 1 + Math.floor(rnd() * 21);
  const hour = 18 + rnd() * 6;
  const km = Math.round((3 + rnd() * 24) * 10) / 10;
  const t = job(km, (rnd() - 0.5) * 0.1, 0, 'ABCDE'[i % 5], near(TPY, (rnd() - 0.5) * 0.04, (rnd() - 0.5) * 0.04));
  return { ...t, ts: NOW - day * 86400000 - (22 - hour) * 3600000 };
});

const scenarios = [
  ['1. One driver, one surge job (+30%, 12 km, 8 min ago, 1 km away)', [job(12, 0.30, 8, 'A', near(TPY, 0.009, 0))]],
  ['2. Two drivers, surge (+30% 12 km, +38% 6 km)', [job(12, 0.30, 8, 'A', near(TPY, 0.009, 0)), job(6, 0.38, 15, 'B', near(TPY, -0.006, 0.004))]],
  ['3. Mixed, 5 drivers: normal, possible surge, surge', [
    job(5, 0.02, 5, 'A', near(TPY, 0.004, 0.002)), job(15, 0.12, 10, 'B', near(TPY, -0.008, 0)), job(8, 0.35, 14, 'C', near(TPY, 0.002, -0.009)),
    job(22, -0.03, 20, 'D', near(TPY, 0.01, 0.006)), job(18, 0.45, 25, 'E', near(TPY, -0.005, 0.007))]],
  ['4. Possible surge only: 3 drivers +10%, +12%, +14%', [job(7, 0.10, 6, 'A', near(TPY, 0.003, 0)), job(14, 0.12, 12, 'B', near(TPY, -0.004, 0.003)), job(24, 0.14, 18, 'C', near(TPY, 0.006, -0.004))]],
  ['5. Surge in River Valley (3 drivers +35-45%), you at Toa Payoh', [job(9, 0.35, 10, 'A', RV), job(13, 0.42, 15, 'B', near(RV, 0.003, 0.002)), job(21, 0.45, 20, 'C', near(RV, -0.002, 0.003))]],
  ['6. One typo / odd job: +55%, 9 km, 3 min ago', [job(9, 0.55, 3, 'A', near(TPY, 0.002, 0.001))]],
];

const word = { good: 'Surge', normal: 'Normal', bad: 'Bad' };
const money = (v) => `S$${v.toFixed(2)}`;
const pct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))}%`;
const run = (trips, before) => {
  Object.assign(TUNE, before ? { freshNeeded: 0, rangeBlendUntil: 1 } : { freshNeeded: 2, rangeBlendUntil: 3 });
  return bandOutlook(trips, NOW, TPY);
};
const cell = (b) => `${word[b.state]}${b.state !== 'normal' ? ` ${pct(b.vs)}` : ''} · ${money(b.now)}`;
const rng = (b) => `${money(b.surgeLo)}–${b.surgeHi.toFixed(2)}`;

console.log('Baseline (history only):', run(history, false).map((b) => `${b.label} ${cell(b)} (normal ${money(b.normal)})`).join(' | '));
for (const [name, extra] of scenarios) {
  const all = [...history, ...extra];
  const B = run(all, true); const A = run(all, false);
  console.log(`\n### ${name}`);
  console.log('| Card | Before | After | Surge range before | after |');
  console.log('|---|---|---|---|---|');
  for (let i = 0; i < 3; i++) console.log(`| ${B[i].label} | ${cell(B[i])} | ${cell(A[i])} | ${rng(B[i])} | ${rng(A[i])} |`);
}
