// Where this phone is (beta): one shared location watch for the Formula tab and the airport queue.
// Location stays on the phone; only a rounded position (about 1 km) is ever uploaded with a trip.
import { inAirportZone } from './airport-zone.js';
import { haversineKm } from './places.js';

// Changi Airport: terminals 1–4 and Jewel. The queue and holding areas are within about 1.5 km.
export { AIRPORT_ZONE_KM } from './airport-zone.js';
const FRESH_MS = 10 * 60 * 1000;

let loc = null;
let state = 'unknown'; // unknown (no fix yet) · ok · denied (or not available)
const subs = new Set();
const notify = () => { for (const f of subs) { try { f(); } catch { /* keep going */ } } };

export function watchLocation() {
  if (!('geolocation' in navigator)) { state = 'denied'; return; }
  try {
    navigator.geolocation.watchPosition(
      (p) => {
        loc = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy), at: Date.now() };
        state = 'ok';
        notify();
      },
      (e) => { if (e && e.code === 1) { state = 'denied'; notify(); } },
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 30000 },
    );
  } catch { state = 'denied'; }
}

export const here = () => (loc && Date.now() - loc.at < FRESH_MS ? loc : null);
export const locationState = () => state;
export const onMove = (f) => { subs.add(f); return () => subs.delete(f); };
// Inside the airport boundary and near a terminal (airport-zone.js): not Changi Village or the prison.
export const atAirport = (p) => Boolean(p) && inAirportZone(p.lat, p.lng);
// About 1 km: what's stored with a trip.
export const rounded = (p) => (p ? { lat: Math.round(p.lat * 100) / 100, lng: Math.round(p.lng * 100) / 100 } : null);
