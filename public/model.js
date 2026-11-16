// Fareit prediction model. Pure functions, no DOM, shared by the PWA and the tests.
//
// A prediction has two layers:
//   1. Prior: a take-home fare formula (base + per km + per minute, at least the minimum fare).
//      Works with zero data.
//   2. Learned correction: the log-ratio between what you were actually paid and what the
//      prior said, averaged over your reconciled trips and weighted by how similar each trip
//      is (same drop area, same band, similar hour, weekday vs weekend). It shrinks toward the
//      overall correction when there are few similar trips, so it never jumps on one data point.

export const BANDS = [
  { id: '0-5', label: '0–5', min: 0, max: 5, km: 3 },
  { id: '5-10', label: '5–10', min: 5, max: 10, km: 7.5 },
  { id: '10-15', label: '10–15', min: 10, max: 15, km: 12.5 },
  { id: '15-20', label: '15–20', min: 15, max: 20, km: 17.5 },
  { id: '20-30', label: '20–30', min: 20, max: 30, km: 25 },
  { id: '30-40', label: '30–40', min: 30, max: 40, km: 35 },
  { id: '40+', label: '40+', min: 40, max: Infinity, km: 45 },
];

export const ZONES = [
  { id: 'N', label: 'North', short: 'N' },
  { id: 'S', label: 'South', short: 'S' },
  { id: 'E', label: 'East', short: 'E' },
  { id: 'W', label: 'West', short: 'W' },
  { id: 'AIRPORT', label: 'Airport', short: 'Airport' },
  { id: 'TUAS', label: 'Tuas', short: 'Tuas', dead: true },
  { id: 'WLC', label: 'Woodlands CP', short: 'WLC' },
  { id: 'CF', label: 'Changi Far', short: 'CF', dead: true },
];

// Seed values, all in take-home terms: the fare on the job card is already what the driver
// keeps (before CPF), so there is no commission to model. Grab publishes no driver rate card;
// these are estimates tuned so the recorded Tampines St 11 -> Tuas View Close trip (about
// 45.8 km, 52 min, S$33.20) lands within 2%. Reconciled jobs correct them.
export const RIDE_TYPES = [
  { id: 'standard', label: 'Standard' },
  { id: 'premium', label: 'Premium' },
  { id: 'xl', label: '6-seater' },
  { id: 'taxi', label: 'Taxi' },
];

export const DEFAULT_SETTINGS = {
  targetPerHour: 30,
  minFare: 6.2, // Grab minimum fare: no prediction goes below this
  rideType: 'standard',
  share: true, // add your reconciled jobs (anonymised) to the shared training pool
  base: 2.4,
  perKm: 0.48,
  perMin: 0.18,
  pickupMin: 6,
  returnMin: { N: 0, S: 0, E: 0, W: 0, AIRPORT: 5, TUAS: 35, WLC: 10, CF: 25 },
  priorStrength: 3,
  defaultSpread: 0.25,
};

export function mergeSettings(saved) {
  const s = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  delete s.commission; // older versions modelled Grab's cut; the card fare is already take-home
  s.returnMin = { ...DEFAULT_SETTINGS.returnMin, ...((saved && saved.returnMin) || {}) };
  return s;
}

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
  return t.band || bandFor(t.km).id;
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

export function similarity(t, q) {
  let w = 1;
  if (t.zone && t.zone === q.zone) w *= 3;
  if (tripBand(t) === q.band) w *= 2;
  w *= timeSimilarity(t.ts, q.ts);
  w *= placeSimilarity(t, q);
  // Premium, 6-seater and taxi fares run on different rates, so other ride types count little.
  if (t.rideType && q.ride && t.rideType !== q.ride) w *= 0.2;
  return w;
}

// A single wild entry in the shared pool (typo, or someone messing about) can't pull a
// prediction beyond 0.3x–3.3x of the formula.
const MAX_LOG_RATIO = 1.2;

// q = { band, zone, ts }
export function predict(q, trips, settings) {
  const s = mergeSettings(settings);
  const profile = bandProfile(q.band, trips);
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
  const returnMin = s.returnMin[q.zone] ?? 0;
  const totalMin = s.pickupMin + profile.min + returnMin;
  const perHour = (net / totalMin) * 60;

  return {
    band: q.band,
    zone: q.zone,
    km: profile.km,
    tripMin: profile.min,
    prior,
    net,
    lo,
    hi,
    perHour,
    perHourLo: (lo / totalMin) * 60,
    perHourHi: (hi / totalMin) * 60,
    totalMin,
    returnMin,
    verdict: perHour >= s.targetPerHour ? 'TAKE' : 'SKIP',
    basis: n,
    shared,
    nearTime,
    dayClass: dayClass(q.ts),
    weight: sw,
    // One trip that matches on drop area, band, time and day type weighs 9 (18 if it also started
    // where you are now), so "trained" means roughly five closely matching trips.
    stage: n === 0 ? 'seed' : sw < 45 ? 'learning' : 'trained',
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
