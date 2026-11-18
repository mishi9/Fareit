// Day patterns: which kind of night it is, and the owner's experience as a starting guess.
// Nights cross midnight: 00:00-05:59 belongs to the night before (Wednesday 1 am is "Wednesday
// night"). Trips from the same kind of night count most in "now" (formula.js). The starting
// guesses count like a couple of trips; real trips take over as they come in.

// Official public holidays (Ministry of Manpower, mom.gov.sg, 2026 and 2027), YYYY-MM-DD, with the
// Monday off when a holiday falls on a Sunday. Add the next year's when MOM publishes it.
export const PUBLIC_HOLIDAYS = new Set([
  '2026-01-01', '2026-02-17', '2026-02-18', '2026-03-21', '2026-04-03', '2026-05-01', '2026-05-27',
  '2026-05-31', '2026-06-01', '2026-08-09', '2026-08-10', '2026-11-08', '2026-11-09', '2026-12-25',
  '2027-01-01', '2027-02-06', '2027-02-07', '2027-02-08', '2027-03-10', '2027-03-26', '2027-05-01',
  '2027-05-17', '2027-05-20', '2027-08-09', '2027-10-28', '2027-12-25',
]);

const NIGHT_START_H = 6; // before 06:00 = still last night
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The "night of" calendar day for a moment, and its weekday (0 Sun .. 6 Sat).
export function nightOf(ts) {
  const d = new Date(ts);
  if (d.getHours() < NIGHT_START_H) d.setDate(d.getDate() - 1);
  d.setHours(12, 0, 0, 0);
  return d;
}
const isPH = (d) => PUBLIC_HOLIDAYS.has(dayKey(d));
// For the header: 'PH' on a public holiday, 'PH Eve' the day before one (calendar days), else ''.
export function holidayTag(ts = Date.now()) {
  const d = new Date(ts);
  if (isPH(d)) return 'PH';
  const n = new Date(d); n.setDate(n.getDate() + 1);
  return isPH(n) ? 'PH Eve' : '';
}
const isPHEve = (d) => { const n = new Date(d); n.setDate(n.getDate() + 1); return isPH(n); };

// Kinds of night. Fri, Sat and the eve of a public holiday behave alike; Mon-Tue are the slow
// nights; Wed (ladies' night), Thu and Sun each have their own until the data says otherwise.
export function dayType(ts) {
  const d = nightOf(ts);
  if (isPH(d)) return 'ph';
  if (isPHEve(d)) return 'weekend';
  return ['sun', 'early', 'early', 'wed', 'thu', 'weekend', 'weekend'][d.getDay()];
}
// How much a trip from another kind of night counts (same kind: fully).
export const OTHER_DAY_WEIGHT = 0.4;

// Areas (about 1.5 km around each point).
const AREA_KM = 1.5;
export const NIGHTLIFE = [ // ladies' night
  ['Marina Bay Sands', 1.2834, 103.8607], ['Cecil St / CBD', 1.2830, 103.8510], ['Bugis', 1.3008, 103.8559], ['Clarke Quay', 1.2888, 103.8467],
];
export const CLUBS = [ // club closing
  ['Orchard', 1.3048, 103.8318], ['Dhoby Ghaut', 1.2990, 103.8455], ['Jalan Besar', 1.3110, 103.8580], ['Kallang', 1.3115, 103.8714], ['Clarke Quay', 1.2888, 103.8467],
];
const kmApart = (a, b) => {
  const rad = (x) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};
const near = (loc, list) => Boolean(loc) && list.some(([, lat, lng]) => kmApart(loc, { lat, lng }) <= AREA_KM);
const minuteOf = (ts) => { const d = new Date(ts); return d.getHours() * 60 + d.getMinutes(); };
const between = (m, a, b) => m >= a && m < b;

// The owner's experience (busy times +10%, the rest normal) as the starting guess for "now".
export const BUSY = 0.10;
export function experienceLift(ts, loc = null) {
  const t = dayType(ts);
  const m = minuteOf(ts);
  const cal = new Date(ts);
  const calWeekday = cal.getDay() >= 1 && cal.getDay() <= 5 && !isPH(cal);
  const sat = t === 'weekend' && nightOf(ts).getDay() === 6;
  const phEve = t === 'weekend' && isPHEve(nightOf(ts));
  // Club closing (owner's breakdown): Sunday to Friday nights ~3 am (pings from 02:45);
  // Saturday nights and public-holiday eves ~4 am (from 03:45); public-holiday nights 02:45-03:45.
  if (near(loc, CLUBS)) {
    const win = sat || phEve ? [3 * 60 + 45, 4 * 60 + 15] : t === 'ph' ? [2 * 60 + 45, 3 * 60 + 45] : [2 * 60 + 45, 3 * 60 + 15];
    if (between(m, win[0], win[1])) return BUSY;
  }
  // Wednesday ladies' night, 00:00-04:00, in the bar areas.
  if (t === 'wed' && between(m, 0, 4 * 60) && near(loc, NIGHTLIFE)) return BUSY;
  // Fri / Sat nights and public-holiday eves, 18:00-05:59.
  if (t === 'weekend' && (m >= 18 * 60 || m < NIGHT_START_H * 60)) return BUSY;
  // Weekday after-work, 18:00-20:00.
  if (calWeekday && between(m, 18 * 60, 20 * 60)) return BUSY;
  return 0;
}
// The starting guess counts like this many trips.
export const EXPERIENCE_WEIGHT = 2;
