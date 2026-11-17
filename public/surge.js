// "Likely surging" on Radar: when at least 2 different drivers have seen surge within about
// 1.5 km of each other in the last 30 minutes (a "Surge here" tap, or a trip saved as Surge), drivers
// within 3 km see it at the top of Radar. 3 km is about 5-10 minutes' drive: close enough to get
// there while it lasts. Inside 1.5 km it says "around you".
import { here, rounded } from './where.js';

export const SURGE_CLUSTER_KM = 1.5;
export const SURGE_NOTIFY_KM = 3;
export const SURGE_MIN_DRIVERS = 2;
export const SURGE_WINDOW_MIN = 30;

const kmApart = (a, b) => {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

// Groups of reports close together. Pure, for the page and the tests.
export function surgeSpots(points, now = Date.now()) {
  const fresh = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && now - p.ts <= SURGE_WINDOW_MIN * 60000 && p.ts <= now + 60000);
  const used = new Set();
  const spots = [];
  // Seed from the point with the most different drivers around it, then take those points out.
  for (;;) {
    let best = null;
    for (const p of fresh) {
      if (used.has(p)) continue;
      const near = fresh.filter((q) => !used.has(q) && kmApart(p, q) <= SURGE_CLUSTER_KM);
      const drivers = new Set(near.map((q) => q.d)).size;
      if (!best || drivers > best.drivers || (drivers === best.drivers && near.length > best.near.length)) best = { near, drivers };
    }
    if (!best || best.drivers < SURGE_MIN_DRIVERS) break;
    for (const q of best.near) used.add(q);
    const lat = best.near.reduce((s, q) => s + q.lat, 0) / best.near.length;
    const lng = best.near.reduce((s, q) => s + q.lng, 0) / best.near.length;
    spots.push({ lat, lng, drivers: best.drivers, reports: best.near.length, latest: Math.max(...best.near.map((q) => q.ts)) });
  }
  return spots;
}

// The spot that matters to a driver here: the nearest within 3 km.
export function surgeFor(loc, spots) {
  if (!loc) return null;
  let best = null;
  for (const s of spots) {
    const km = kmApart(loc, s);
    if (km <= SURGE_NOTIFY_KM && (!best || km < best.km)) best = { ...s, km, inside: km <= SURGE_CLUSTER_KM };
  }
  return best;
}

const sg = { points: [], at: 0, loading: false, device: null };
export async function loadSurge(onDone, force = false) {
  if (sg.loading || (!force && Date.now() - sg.at < 60000)) return;
  sg.loading = true;
  try {
    const res = await fetch('/api/surge');
    if (res.ok) { sg.points = (await res.json()).points || []; sg.at = Date.now(); }
  } catch { /* offline: keep the last */ }
  sg.loading = false;
  onDone();
}
export const surgeNow = () => surgeFor(here(), surgeSpots(sg.points));

export async function reportSurge(device) {
  const p = rounded(here());
  if (!p) throw new Error('Location is off, so a surge can’t be placed.');
  const res = await fetch('/api/surge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device, ...p }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Couldn’t send it. Try again.');
  sg.at = 0;
  return body;
}

// Banner text for Radar (area: the planning-area name, when known).
export function surgeBanner(s, area, now = Date.now()) {
  const ago = Math.max(0, Math.round((now - s.latest) / 60000));
  const dist = `${s.km < 1 ? 'under 1' : s.km.toFixed(1)} km away`;
  const where = s.inside ? `Likely surging around you${area ? ` (${area})` : ''}` : area ? `${area} likely surging · ${dist}` : `Likely surging ${dist}`;
  return `<div class="surge-alert"><div class="surge-up" aria-hidden="true">↑</div><div><b>${where}</b>
    <div class="note">${s.drivers} drivers saw surge in the last 30 min · latest ${ago < 1 ? 'just now' : `${ago} min ago`}</div></div></div>`;
}
