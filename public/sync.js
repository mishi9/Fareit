// Shared training pool. Your own jobs stay on this phone; what goes to the pool is an anonymous
// training row: no addresses or names, places rounded to about 1 km, times to 5 minutes.

const FIVE_MIN = 5 * 60 * 1000;
const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

export function isShareable(t) {
  if (t.status === 'reconciled') return t.fare > 0 && t.km > 0;
  if (t.status === 'nofare') return Boolean(t.decision);
  return false;
}

// What leaves the phone for one job.
export function toPoolRow(t) {
  const origin = t.pickup && t.pickup.lat ? t.pickup : t.tapLoc && t.tapLoc.lat ? t.tapLoc : null;
  const drop = t.drop && t.drop.lat ? t.drop : null;
  return {
    id: t.id,
    ts: Math.round(t.ts / FIVE_MIN) * FIVE_MIN,
    ride: t.rideType || 'standard',
    band: t.band || null,
    zone: t.zone || null,
    decision: t.decision || null,
    km: t.status === 'reconciled' ? r2(t.km) : null,
    trip_min: t.status === 'reconciled' ? r2(t.tripMin) : null,
    drive_min: t.status === 'reconciled' ? r2(t.driveMin) : null,
    fare: t.status === 'reconciled' ? r2(t.fare) : null,
    payment: t.payment || null,
    pickup_lat: origin ? r2(origin.lat) : null,
    pickup_lng: origin ? r2(origin.lng) : null,
    drop_lat: drop ? r2(drop.lat) : null,
    drop_lng: drop ? r2(drop.lng) : null,
  };
}

// A pool row in the shape the model reads.
export function fromPoolRow(row) {
  const trainable = row.fare > 0 && row.km > 0;
  return {
    id: row.id,
    ts: row.ts,
    status: trainable ? 'reconciled' : 'nofare',
    shared: true,
    rideType: row.ride,
    band: row.band,
    zone: row.zone,
    decision: row.decision,
    km: row.km,
    tripMin: row.trip_min,
    driveMin: row.drive_min,
    fare: row.fare,
    pickup: row.pickup_lat != null ? { lat: row.pickup_lat, lng: row.pickup_lng } : null,
  };
}

const fingerprint = (row) => JSON.stringify(row);

// Uploads jobs that are new or changed since the last upload. Returns how many were accepted.
export async function pushJobs({ trips, device, post, save }) {
  const todo = trips
    .filter(isShareable)
    .map((t) => ({ t, row: toPoolRow(t) }))
    .filter(({ t, row }) => t.poolPrint !== fingerprint(row));
  let accepted = 0;
  for (let i = 0; i < todo.length; i += 50) {
    const batch = todo.slice(i, i + 50);
    const res = await post({ device, jobs: batch.map((b) => b.row) });
    const ok = new Set(res.accepted || []);
    const bad = new Set(res.rejected || []);
    for (const { t, row } of batch) {
      if (ok.has(t.id)) { t.poolPrint = fingerprint(row); accepted++; }
      else if (bad.has(t.id)) t.poolPrint = fingerprint(row); // don't retry a row the pool refused
    }
    await save(batch.map((b) => b.t));
  }
  return accepted;
}

// Downloads everything added to the pool since the last pull.
export async function pullJobs({ since, get, store }) {
  let cursor = since || 0;
  let total = 0;
  for (let page = 0; page < 50; page++) {
    const res = await get(cursor);
    const rows = (res.jobs || []).map(fromPoolRow);
    if (rows.length) await store(rows);
    total += rows.length;
    cursor = res.next ?? cursor;
    if (!res.more) break;
  }
  return { cursor, total };
}
