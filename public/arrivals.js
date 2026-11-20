// Changi arrivals, worked out by us from open flight-tracking data (adsb.lol, community ADS-B
// receivers; open data, credit adsb.lol). No schedule, no paid service: every 5 minutes the server
// looks at the planes around Singapore and picks out the ones coming in to land at Changi, how soon,
// at which terminal (from the airline), and about how many people are on board.
// Pure functions: used by the server (worker/index.js) and the tests.

export const CHANGI = { lat: 1.3644, lng: 103.9915 };
const SELETAR = { lat: 1.4170, lng: 103.8678 };
export const AHEAD_MIN = 30; // only what lands in the next 30 minutes
export const LANDED_MIN = 30; // and what landed in the last 30 (people coming out now)
// About how full planes are, and the share of passengers who book Grab or another ride-hailing app
// (the owner's estimate). Riders are people, not jobs: a family of 3 is one booking.
export const LOAD_FACTOR = 0.8;
export const RIDE_SHARE = 0.3;

// Changi terminal by airline (ICAO code = the first 3 letters of the callsign), from Changi
// Airport's own Passenger Airline Information page (changiairport.com, Nov 2026: the check-in
// terminal; flights arrive at the same one). Singapore Airlines uses both T2 and T3 and is shown
// on its own ('SQ'). Airlines missing here show as "terminal not known". Re-check each season.
// Not mapped yet (ICAO code not confirmed): Aero Dili (8G), AirBorneo (MY), Sun PhuQuoc Airways (9G).
export const AIRLINE_TERMINAL = {
  // T1
  AFR: 'T1', ANG: 'T1', BAW: 'T1', BKP: 'T1', CCA: 'T1', CDG: 'T1', CQN: 'T1', CSN: 'T1', CSZ: 'T1',
  CXA: 'T1', FIN: 'T1', FJI: 'T1', JAL: 'T1', KLM: 'T1', QFA: 'T1', QTR: 'T1', TGW: 'T1', THY: 'T1',
  TZP: 'T1', UAE: 'T1',
  // T2
  ACA: 'T2', AIC: 'T2', ANA: 'T2', APJ: 'T2', AXB: 'T2', CSC: 'T2', DLH: 'T2', ETD: 'T2', ETH: 'T2',
  FFM: 'T2', IGO: 'T2', JST: 'T2', MAS: 'T2', MMA: 'T2', OMA: 'T2', PAL: 'T2', RBA: 'T2', SJX: 'T2',
  SWR: 'T2', THA: 'T2', TWB: 'T2', UAL: 'T2', UBA: 'T2',
  // T3
  AAR: 'T3', ACI: 'T3', ALK: 'T3', ANZ: 'T3', BBC: 'T3', CAL: 'T3', CES: 'T3', CSH: 'T3', CTV: 'T3',
  DRK: 'T3', EVA: 'T3', GFA: 'T3', GIA: 'T3', HVN: 'T3', SVA: 'T3', UBG: 'T3',
  // T4
  AIQ: 'T4', AMU: 'T4', AXM: 'T4', BTK: 'T4', CBJ: 'T4', CDC: 'T4', CEB: 'T4', CHB: 'T4', CHH: 'T4',
  CPA: 'T4', CQH: 'T4', DKH: 'T4', EVE: 'T4', GCR: 'T4', JJA: 'T4', JYH: 'T4', KAL: 'T4', KME: 'T4',
  MGL: 'T4', MXD: 'T4', PAS: 'T4', TLM: 'T4', TNU: 'T4', VJC: 'T4', VSV: 'T4', WFL: 'T4',
  SIA: 'SQ',
};
// Cargo airlines: no passengers, left out.
export const CARGO = new Set(['CSS', 'FDX', 'UPS', 'CKS', 'CLX', 'GTI', 'CAO', 'CKK', 'SQC', 'ABW', 'DHK', 'DHX', 'BCS', 'CAL5', 'CPA9', 'KZR9', 'TAY', 'MPH', 'AHK', 'HKC', 'YZR', 'CYZ', 'RCH', 'QTR9', 'ETH9', 'UAE9', 'TGX', 'NCA', 'ACX', 'BOX', 'SQC']);
export const isCargo = (call) => { const c = String(call || '').trim().toUpperCase(); return CARGO.has(c.slice(0, 3)) || CARGO.has(c.slice(0, 4)); };
export const terminalFor = (callsign) => AIRLINE_TERMINAL[String(callsign || '').trim().slice(0, 3).toUpperCase()] || null;

// Typical seats by aircraft type (ICAO type code, as the receivers report it). Unknown: 180.
export const SEATS = {
  A19N: 140, A319: 140, A20N: 186, A320: 180, A21N: 220, A321: 220, BCS3: 140, E190: 100, E195: 120, AT76: 70, AT75: 70,
  B737: 150, B738: 180, B38M: 180, B39M: 200, B739: 200,
  A332: 260, A333: 290, A338: 260, A339: 300, A359: 300, A35K: 350, A388: 470,
  B788: 250, B789: 290, B78X: 310, B772: 300, B77W: 360, B77L: 300, B744: 400, B748: 360, B763: 230,
};
export const seatsFor = (type) => SEATS[String(type || '').toUpperCase()] || 180;

const rad = (d) => (d * Math.PI) / 180;
export function kmTo(a, b) {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
const angleGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// One aircraft as the receivers report it -> { id, eta (minutes), terminal, seats } if it's an
// airliner coming in to land at Changi within AHEAD_MIN, else null. No route data is needed: it's
// pointed at Changi and coming down (or low and close). Climbing (departures), passing high
// overhead (to Jakarta, Bali...), Seletar traffic and non-airline callsigns are left out.
export function inbound(ac) {
  const call = String(ac.flight || '').trim();
  if (!/^[A-Z]{3}\d/.test(call)) return null; // airline flights only (not military, private)
  if (isCargo(call)) return null; // freighters carry no passengers
  const lat = ac.lat; const lng = ac.lon ?? ac.lng;
  const alt = ac.alt_baro;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(alt) || !(ac.gs > 80)) return null;
  const p = { lat, lng };
  const km = kmTo(p, CHANGI);
  const rate = Number.isFinite(ac.baro_rate) ? ac.baro_rate : (Number.isFinite(ac.geom_rate) ? ac.geom_rate : 0);
  if (rate > 500) return null; // climbing: just took off
  if (alt < 6000 && kmTo(p, SELETAR) < km) return null; // Seletar's, not Changi's
  // Too high for how close it is: passing over, not landing (a 3° descent is about 300 ft per km).
  if (alt > 3500 + km * 330) return null;
  const close = km < 40 && alt < 10000; // on approach: may be turning in, any heading
  if (!close) {
    if (!Number.isFinite(ac.track) || angleGap(ac.track, bearing(p, CHANGI)) > 25) return null;
    if (km > 150 && rate > -300 && alt > 30000) return null; // still cruising far out: may be passing
  }
  const kmh = Math.max(250, ac.gs * 1.852 * 0.8); // slows down on the way in
  const eta = (km / kmh) * 60 + (close ? 2 : 5);
  if (eta > AHEAD_MIN) return null;
  return { id: String(ac.hex || call), eta, terminal: terminalFor(call), seats: seatsFor(ac.t) };
}

// Keep track between readings: planes that were about to land and are now gone (or on the ground)
// count as landed. state = { inbound: { id: { t, terminal, seats } }, landed: [{ t, terminal, seats }] }.
export function track(state, aircraft, now) {
  const prev = (state && state.inbound) || {};
  const landed = ((state && state.landed) || []).filter((x) => now - x.t <= 2 * LANDED_MIN * 60000);
  const next = {};
  const seen = new Set();
  for (const ac of aircraft || []) {
    const id = String(ac.hex || String(ac.flight || '').trim());
    seen.add(id);
    if (ac.alt_baro === 'ground' && prev[id]) { landed.push({ id, ...prev[id], t: Math.min(now, prev[id].t) }); continue; }
    const x = inbound(ac);
    if (x) next[x.id] = { t: now + x.eta * 60000, terminal: x.terminal, seats: x.seats };
  }
  // Due within 10 minutes and now out of sight: landed (receivers lose planes as they touch down).
  for (const [id, x] of Object.entries(prev)) {
    if (next[id] || landed.some((l) => l.id === id)) continue;
    if (!seen.has(id) && x.t - now <= 10 * 60000) landed.push({ id, t: Math.min(now, x.t), terminal: x.terminal, seats: x.seats });
  }
  return { inbound: next, landed };
}

// Per terminal: landing in the next AHEAD_MIN minutes (flights, ~people, ~ride-hailing riders),
// and landed in the last LANDED_MIN.
export function summarize(state, now) {
  const blank = () => ({ next: 0, pax: 0, riders: 0, landed: 0, landedPax: 0 });
  const terminals = { T1: blank(), T2: blank(), T3: blank(), T4: blank(), SQ: blank() };
  const unknown = blank();
  const pax = (seats) => seats * LOAD_FACTOR;
  for (const x of Object.values((state && state.inbound) || {})) {
    if (x.t - now > AHEAD_MIN * 60000) continue;
    const k = terminals[x.terminal] || unknown;
    k.next++; k.pax += pax(x.seats);
  }
  for (const x of (state && state.landed) || []) {
    if (now - x.t > LANDED_MIN * 60000 || x.t > now) continue;
    const k = terminals[x.terminal] || unknown;
    k.landed++; k.landedPax += pax(x.seats);
  }
  for (const k of [...Object.values(terminals), unknown]) {
    k.riders = Math.round(k.pax * RIDE_SHARE);
    k.pax = Math.round(k.pax);
    k.landedRiders = Math.round(k.landedPax * RIDE_SHARE);
    k.landedPax = Math.round(k.landedPax);
  }
  return { terminals, unknown };
}
