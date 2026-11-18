// What a trip can't be (layer 1 of the safeguards). Shared by the app (to say so before saving)
// and the server (to refuse it), so they always agree. Deliberately generous: real surge, promos,
// low-cut jobs and ERP all fit; "10 km at S$99" doesn't.

// A rough normal passenger fare for the distance: well inside what Grab charges, only a yardstick.
export const roughFare = (km) => 3 + 0.65 * km + 0.25 * (3 + 1.1 * km);

export const LIMITS = {
  maxVsNormal: 3, // surge rarely goes past about 2x
  minVsNormal: 0.3, // promos and short-trip quirks
  maxKmPerMin: 2, // 120 km/h
  minCutShare: 0.35, // a driver keeps at least ~35% of the fare (Grab's cut is usually ~25%)
};

// { ok, reason } for a trip: km, optional min, paid (passenger), earned (driver), erp.
export function plausible({ km, min = null, paid = null, earned = null, erp = 0 } = {}) {
  const e = Number(erp) || 0;
  if (!(km > 0)) return { ok: false, reason: 'Add the trip distance.' };
  if (min > 0 && km / min > LIMITS.maxKmPerMin) return { ok: false, reason: `${km} km in ${min} min is faster than the roads allow.` };
  const n = roughFare(km);
  if (paid > 0) {
    const p = paid - e;
    if (p > n * LIMITS.maxVsNormal) return { ok: false, reason: `S$${paid.toFixed(2)} is far more than any ${km} km trip pays. Check the numbers.` };
    if (p < n * LIMITS.minVsNormal && p < 8.1) return { ok: false, reason: `S$${paid.toFixed(2)} is too little for ${km} km. Check the numbers.` };
    if (earned > 0 && earned > paid + 0.5) return { ok: false, reason: 'You can\'t earn more than the passenger paid.' };
    if (earned > 0 && earned - e < Math.min(6.2, (p) * LIMITS.minCutShare)) return { ok: false, reason: `Earning S$${earned.toFixed(2)} of S$${paid.toFixed(2)} would mean Grab kept most of it. Check the numbers.` };
  } else if (earned > 0) {
    const d = earned - e;
    if (d > n * 0.8 * LIMITS.maxVsNormal) return { ok: false, reason: `S$${earned.toFixed(2)} is far more than any ${km} km trip pays. Check the numbers.` };
  }
  return { ok: true };
}

// Layer 2: far enough from the estimate to ask "are you sure?" (still allowed once confirmed).
export const OUTLIER_HIGH = 0.6;
export const OUTLIER_LOW = -0.4;
export const isOutlier = (actual, estimate) => estimate > 0 && actual > 0 && (actual / estimate - 1 >= OUTLIER_HIGH || actual / estimate - 1 <= OUTLIER_LOW);
