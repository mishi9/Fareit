// Where this phone is (beta): one shared location watch for the Formula tab and the airport queue.
// Location stays on the phone; only a rounded position (about 1 km) is ever uploaded with a trip.
import { haversineKm } from './places.js';

// Changi Airport: terminals 1–4 and Jewel. The queue and holding areas are within about 1.5 km.
const AIRPORT = [[1.3614, 103.9894], [1.3554, 103.9908], [1.3566, 103.9863], [1.3381, 103.9832], [1.3603, 103.9894]];
export const AIRPORT_ZONE_KM = 1.5;
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
export const atAirport = (p) => Boolean(p) && AIRPORT.some(([a, b]) => haversineKm(p.lat, p.lng, a, b) <= AIRPORT_ZONE_KM);
// About 1 km: what's stored with a trip.
export const rounded = (p) => (p ? { lat: Math.round(p.lat * 100) / 100, lng: Math.round(p.lng * 100) / 100 } : null);
