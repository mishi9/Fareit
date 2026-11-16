// Fareit prediction model. Pure functions, no DOM, shared by the PWA and the tests.
//
// A prediction has two layers:
//   1. Prior: a take-home fare formula (base + per km + per minute, at least the minimum fare).
//      Works with zero data.
//   2. Learned correction: the log-ratio between what you were actually paid and what the
//      prior said, averaged over reconciled trips and weighted by how similar each trip is
//      (same band, similar hour and day type, started near where you are now). The drop-off
//      plays no part. It shrinks toward the
//      overall correction when there are few similar trips, so it never jumps on one data point.

// 3 km bands from the card's distance: 0–3 means 0 to 2.9 km, and 3.0 goes in 3–6. Then 45+.
export const BANDS = [
  ...Array.from({ length: 15 }, (_, i) => ({ id: `${i * 3}-${i * 3 + 3}`, label: `${i * 3}–${i * 3 + 3}`, min: i * 3, max: i * 3 + 3, km: i * 3 + 1.5 })),
  { id: '45+', label: '45+', min: 45, max: Infinity, km: 48 },
];

// Bands from before 3 km bands, with their middle distance. Old jobs are moved to the new band
// their real km falls in (or, without a km, the band of the old middle), so nothing is wasted.
const LEGACY_BANDS = { '0-5': 3, '5-10': 7.5, '10-15': 12.5, '15-20': 17.5, '20-30': 25, '30-40': 35, '40+': 45 };
const CURRENT = new Set(BANDS.map((b) => b.id));

export function normalizeBand(id, km) {
  if (CURRENT.has(id)) return id;
  if (km > 0) return bandFor(km).id;
  if (id in LEGACY_BANDS) return bandFor(LEGACY_BANDS[id]).id;
  return null;
}

// Typical distance for a band id, old or new.
export function bandMidKm(id) {
  const b = BANDS.find((x) => x.id === id);
  if (b) return b.km;
  return LEGACY_BANDS[id] ?? null;
}

// Button order on the phone: three per row, Tuas and Changi Far last.
export const ZONES = [
  { id: 'N', label: 'North', short: 'N' },
  { id: 'S', label: 'South', short: 'S' },
  { id: 'E', label: 'East', short: 'E' },
  { id: 'W', label: 'West', short: 'W' },
  { id: 'C', label: 'Central', short: 'Central' },
  { id: 'AIRPORT', label: 'Airport', short: 'Airport' },
  { id: 'WLC', label: 'Woodlands CP', short: 'WLC' },
  { id: 'TUAS', label: 'Tuas', short: 'Tuas' },
  { id: 'CF', label: 'Changi Far', short: 'CF' },
];

// Seed values, all in take-home terms: the fare on the job card is already what the driver
// keeps (before CPF), so there is no commission to model. Grab publishes no driver rate card;
// these are estimates tuned so the recorded Tampines St 11 -> Tuas View Close trip (about
// 45.8 km, 52 min, S$33.20) lands within 2%. Reconciled jobs correct them.
export const DEFAULT_SETTINGS = {
  minFare: 6.2, // Grab minimum fare: no prediction goes below this
  base: 2.4,
  perKm: 0.48,
  perMin: 0.18,
  priorStrength: 3,
  defaultSpread: 0.25,
};

export function mergeSettings(saved) {
  const s = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  // Fields from earlier versions: Grab's cut (the card fare is already take-home), ride type and
  // the sharing switch (everyone is Standard and always shares), the per-area return table, and
  // the $/hr verdict with dead drops (Fareit now predicts the fare only).
  for (const old of ['commission', 'rideType', 'share', 'returnMin', 'targetPerHour', 'pickupMin', 'deadZones', 'deadReturnMin', 'matchDropArea']) delete s[old];
  return s;
}

// How the fare felt when you reconciled it: surge, normal, or bad (below normal).
export const PRICING = ['surge', 'normal', 'bad'];

export function bandFor(km) {
  return BANDS.find((b) => km >= b.min && km < b.max) || BANDS[BANDS.length - 1];
}

// Rough Singapore drive time when OneMap has not given one: a few minutes of town driving plus
// about 1.1 min per km. Only used before you have trips in a band.
export function estDriveMin(km) {
  return 5 + 1.1 * km;
}

// Take-home estimate before any learning: base + per km + per minute, never below the minimum fare.
export function priorNet(km, min, s) {
  const fare = s.base + s.perKm * Math.max(0, km) + s.perMin * Math.max(0, min);
  return Math.max(s.minFare ?? 0, fare);
}

function median(xs) {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Taken or cancelled makes no difference: any job with a fare (paid, or seen on the card when
// you cancelled) and an OneMap distance trains the model.
export function isTrainable(t) {
  return t.status === 'reconciled' && t.fare > 0 && t.km > 0;
}

export function tripMinutes(t) {
  if (t.tripMin > 0) return t.tripMin;
  if (t.driveMin > 0) return t.driveMin;
  return estDriveMin(t.km);
}

function tripBand(t) {
  return normalizeBand(t.band, t.km) || bandFor(t.km).id;
}

// Typical distance and time for a band: from your own trips once there are 3 or more,
// otherwise the band midpoint.
export function bandProfile(bandId, trips) {
  const band = BANDS.find((b) => b.id === bandId) || BANDS[0];
  const inBand = trips.filter(isTrainable).filter((t) => tripBand(t) === band.id);
  if (inBand.length >= 3) {
    return {
      km: median(inBand.map((t) => t.km)),
      min: median(inBand.map(tripMinutes)),
      learned: true,
      count: inBand.length,
    };
  }
  return { km: band.km, min: estDriveMin(band.km), learned: false, count: inBand.length };
}

// ---- Exact km from the card (the slider) ----
// The km the driver set for a job: the card's distance from the slider, else the road km from
// Reconcile, else the middle of an old band.
export function cardKm(t) {
  if (t.cardKm > 0) return t.cardKm;
  if (t.km > 0) return t.km;
  return bandMidKm(t.band);
}

// Trip minutes for a distance: from reconciled jobs within a few km once there are 3, as minutes
// per km scaled to this distance; otherwise the rough Singapore drive-time rule.
export function kmProfile(km, trips) {
  const near = trips.filter(isTrainable).filter((t) => Math.abs(t.km - km) <= Math.max(3, 0.2 * km));
  if (near.length >= 3) {
    return { km, min: km * median(near.map((t) => tripMinutes(t) / t.km)), learned: true, count: near.length };
  }
  return { km, min: estDriveMin(km), learned: false, count: near.length };
}

// How alike two distances are: 2 at the same km, fading over about 1.5 km for short trips and
// 10% of the distance for long ones (a 2 km gap matters more at 6 km than at 40).
export function kmSimilarity(a, b) {
  if (!(a > 0) || !(b > 0)) return 1;
  const sd = Math.max(1.5, 0.1 * b);
  return 2 * Math.exp(-((a - b) ** 2) / (2 * sd * sd));
}

// ---- Time of day ----
// Yield swings with the clock: commute peaks, lunch, going home, and bar closing (around 2:45
// on weekdays, 3:45 on weekends, Orchard especially). So time is matched tightly: a trip 45 min
// away counts 61%, 1 hour 41%, 2 hours 3%.
const TIME_SD_H = 0.75;
// Late night belongs to the evening before: 03:45 on Saturday morning is Friday night.
const NIGHT_SHIFT_H = 5;

function hourOf(ts) {
  const d = new Date(ts);
  return d.getHours() + d.getMinutes() / 60;
}

export function hourGap(a, b) {
  const d = Math.abs(a - b) % 24;
  return Math.min(d, 24 - d);
}

// Day type of the "driving night" a moment belongs to: weekday (Mon–Thu), fri, sat, sun.
export function dayClass(ts) {
  const d = new Date(ts - NIGHT_SHIFT_H * 3600 * 1000).getDay();
  if (d === 5) return 'fri';
  if (d === 6) return 'sat';
  if (d === 0) return 'sun';
  return 'weekday';
}

const DAY_SIM = {
  weekday: { weekday: 1, fri: 0.7, sat: 0.3, sun: 0.6 },
  fri: { weekday: 0.7, fri: 1, sat: 0.6, sun: 0.3 },
  sat: { weekday: 0.3, fri: 0.6, sat: 1, sun: 0.7 },
  sun: { weekday: 0.6, fri: 0.3, sat: 0.7, sun: 1 },
};

export function timeSimilarity(tsA, tsB) {
  const g = hourGap(hourOf(tsA), hourOf(tsB));
  return Math.exp(-(g * g) / (2 * TIME_SD_H * TIME_SD_H)) * (0.5 + DAY_SIM[dayClass(tsA)][dayClass(tsB)]);
}

// ---- Where you were when the job came (≈ pickup area) ----
function kmBetween(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function tripOrigin(t) {
  if (t.pickup && t.pickup.lat) return t.pickup;
  if (t.tapLoc && t.tapLoc.lat) return t.tapLoc;
  return null;
}

export function placeSimilarity(t, q) {
  const a = tripOrigin(t);
  const b = q.loc && q.loc.lat ? q.loc : null;
  if (!a || !b) return 1;
  const d = kmBetween(a, b);
  return 0.6 + 1.4 * Math.exp(-(d * d) / 8); // same area ×2, 4 km away ×0.79, far ×0.6
}

// The drop-off doesn't count: surge is set where the passenger books, and the drop's effect on
// the price is already in the distance.
export function similarity(t, q) {
  let w = 1;
  if (q.km > 0) w *= kmSimilarity(cardKm(t), q.km);
  else if (tripBand(t) === q.band) w *= 2;
  w *= timeSimilarity(t.ts, q.ts);
  w *= placeSimilarity(t, q);
  // Premium, 6-seater and taxi fares run on different rates, so other ride types count little.
  if (t.rideType && q.ride && t.rideType !== q.ride) w *= 0.2;
  return w;
}

// A single wild entry in the shared pool (typo, or someone messing about) can't pull a
// prediction beyond 0.3x–3.3x of the formula.
const MAX_LOG_RATIO = 1.2;

// ---- Surge at this place and time ----
// Every job tagged surge / normal / bad is a vote for what pricing was like where it started, at
// that time of day and kind of day. Votes count by how close they are in time and place (not by
// distance band or drop: surge is set where the passenger books). A few made-up "normal" votes
// keep one tagged job from calling surge on its own: it takes two at the same place and time.
// Place counts much more here than for the fare: Orchard surging says nothing about Tampines.
const SURGE_PRIOR = { surge: 0.5, normal: 3, bad: 0.5 };

function surgePlaceWeight(t, q) {
  const a = tripOrigin(t);
  const b = q.loc && q.loc.lat ? q.loc : null;
  if (!a || !b) return 0.3; // no location on one side: weak evidence
  const d = kmBetween(a, b);
  return Math.exp(-(d * d) / 8); // same spot 1, 2 km 0.61, 4 km 0.14, 6 km 0.01
}

// Untagged jobs still say something: once there are enough fares to know what "normal" pays, a
// job that paid 30% or more above the typical ratio to the formula (for that distance) reads as surge, and 20% or
// more below as bad. These inferred votes count half as much as a driver's own tag.
const INFER_MIN_JOBS = 8;
const INFER_SURGE = Math.log(1.3);
const INFER_BAD = Math.log(0.8);
const INFERRED_WEIGHT = 0.5;

export function inferPricing(trips, settings) {
  const s = mergeSettings(settings);
  const rs = trips.filter(isTrainable).map((t) => ({ t, r: Math.log(t.fare / priorNet(t.km, tripMinutes(t), s)) })).filter((x) => Number.isFinite(x.r));
  const out = new Map();
  if (rs.length < INFER_MIN_JOBS) return out;
  // Compare with jobs of a similar length: short trips pay more per km than long ones, which is
  // the fare structure, not surge. Use the band's own typical once it has 3 jobs.
  const overall = median(rs.map((x) => x.r));
  const byBand = new Map();
  for (const x of rs) {
    const id = tripBand(x.t);
    if (!byBand.has(id)) byBand.set(id, []);
    byBand.get(id).push(x.r);
  }
  for (const { t, r } of rs) {
    if (PRICING.includes(t.pricing)) continue;
    const inBand = byBand.get(tripBand(t));
    const d = r - (inBand.length >= 3 ? median(inBand) : overall);
    out.set(t, d >= INFER_SURGE ? 'surge' : d <= INFER_BAD ? 'bad' : 'normal');
  }
  return out;
}

export function surgeOutlook(q, trips, settings) {
  const w = { surge: 0, normal: 0, bad: 0 };
  const near = { surge: 0, normal: 0, bad: 0 };
  let inferredNear = 0;
  const inferred = inferPricing(trips, settings);
  for (const t of trips) {
    const tagged = PRICING.includes(t.pricing);
    const c = tagged ? t.pricing : inferred.get(t);
    if (!c) continue;
    const x = timeSimilarity(t.ts, q.ts) * surgePlaceWeight(t, q) * (tagged ? 1 : INFERRED_WEIGHT);
    w[c] += x;
    if (hourGap(hourOf(t.ts), hourOf(q.ts)) <= 1 && dayClass(t.ts) === dayClass(q.ts) && surgePlaceWeight(t, q) >= 0.3) {
      near[c]++;
      if (!tagged) inferredNear++;
    }
  }
  const total = PRICING.reduce((a, c) => a + w[c] + SURGE_PRIOR[c], 0);
  const chance = Object.fromEntries(PRICING.map((c) => [c, (w[c] + SURGE_PRIOR[c]) / total]));
  const evidence = PRICING.reduce((a, c) => a + w[c], 0);
  const likely = chance.surge >= 0.5 ? 'surge' : chance.bad >= 0.5 ? 'bad' : 'normal';
  return { chance, likely, near, evidence, inferredNear };
}

// q = { km (from the card) or band, ts, loc }
export function predict(q, trips, settings) {
  const s = mergeSettings(settings);
  const profile = q.km > 0 ? kmProfile(q.km, trips) : bandProfile(q.band, trips);
  const prior = priorNet(profile.km, profile.min, s);

  const data = trips
    .filter(isTrainable)
    .map((t) => ({ t, r: Math.log(t.fare / priorNet(t.km, tripMinutes(t), s)) }))
    .filter((x) => Number.isFinite(x.r))
    .map((x) => ({ ...x, r: Math.max(-MAX_LOG_RATIO, Math.min(MAX_LOG_RATIO, x.r)) }));

  const k = s.priorStrength;
  const n = data.length;
  // The fallback when few jobs are similar: your ride type's overall correction.
  let rw = 0;
  let rwr = 0;
  for (const x of data) {
    const w = x.t.rideType && q.ride && x.t.rideType !== q.ride ? 0.2 : 1;
    rw += w;
    rwr += w * x.r;
  }
  const overall = n ? rwr / (rw + k) : 0;

  let sw = 0;
  let swr = 0;
  let nearTime = 0;
  for (const x of data) {
    x.w = similarity(x.t, q);
    sw += x.w;
    swr += x.w * x.r;
    if (hourGap(hourOf(x.t.ts), hourOf(q.ts)) <= 1 && dayClass(x.t.ts) === dayClass(q.ts)) nearTime++;
  }
  const m = (swr + k * overall) / (sw + k);
  let sv = k * s.defaultSpread * s.defaultSpread;
  for (const x of data) sv += x.w * (x.r - m) ** 2;
  const sd = Math.sqrt(sv / (sw + k));

  const floor = s.minFare ?? 0;
  const net = Math.max(floor, prior * Math.exp(m));
  const lo = Math.max(floor, prior * Math.exp(m - sd));
  const hi = Math.max(floor, prior * Math.exp(m + sd));
  const shared = data.filter((x) => x.t.shared).length;

  return {
    band: q.km > 0 ? bandFor(q.km).id : q.band,
    km: profile.km,
    tripMin: profile.min,
    prior,
    net,
    lo,
    hi,
    surge: surgeOutlook(q, trips, s),
    basis: n,
    shared,
    nearTime,
    dayClass: dayClass(q.ts),
    weight: sw,
    // One trip in the same band, at the same time and day type, weighs 3 (6 if it also started
    // where you are now), so "trained" means roughly five closely matching trips.
    stage: n === 0 ? 'seed' : sw < 15 ? 'learning' : 'trained',
  };
}

// How good past predictions were, for trips that had a prediction and were then reconciled.
export function accuracy(trips) {
  const xs = trips.filter((t) => t.status === 'reconciled' && t.fare > 0 && t.prediction && t.prediction.net > 0);
  if (!xs.length) return { count: 0, mape: null, bias: null };
  const errs = xs.map((t) => (t.prediction.net - t.fare) / t.fare);
  return {
    count: xs.length,
    mape: errs.reduce((a, e) => a + Math.abs(e), 0) / errs.length,
    bias: errs.reduce((a, e) => a + e, 0) / errs.length,
  };
}
