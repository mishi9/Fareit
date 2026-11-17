// From JB: published timetables for the train and buses that bring people across from Johor Bahru,
// many of whom take a Grab from where they're dropped off. Not live: what's published, worked
// out against the clock. Times are Singapore time (same as Malaysia).
//
// KTM Shuttle Tebrau: KTMB "Perkhidmatan Tren KTM Antarabandar", effective 1 Jan 2026 (updated
//   30 Oct 2025): JB Sentral -> Woodlands, arrival times at Woodlands. Passengers then clear
//   Singapore immigration at Woodlands Train Checkpoint.
// Causeway Link CW1 / CW2 / CW5: hours and intervals from Land Transport Guru's route pages
//   (2026), which are newer than Causeway Link's own sheet (April 2023). Buses leave JB CIQ and
//   reach the Singapore drop-off after both checkpoints, so arrival times depend on the queues.

export const KTM_ARRIVALS = ['05:05', '05:35', '06:05', '06:35', '07:05', '07:35', '08:50', '10:05', '11:35', '12:50',
  '14:05', '15:20', '16:35', '17:50', '19:05', '20:20', '21:35', '22:50'];

// CW5's published departures from Woodlands Checkpoint to Newton Circus (daily).
export const CW5_FROM_WOODLANDS = ['05:10', '05:30', '05:50', '06:10', '06:30', '06:50', '07:10', '07:30', '07:50', '08:10',
  '08:30', '08:50', '09:10', '09:30', '09:50', '10:10', '10:30', '10:50', '11:10', '11:30', '12:00', '12:30', '13:00',
  '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '16:45', '17:00', '17:15', '17:30', '17:45', '18:00',
  '18:15', '18:30', '18:45', '19:00', '19:15', '19:30', '19:45', '20:00', '20:15', '20:30', '20:45', '21:00', '21:15',
  '21:30', '21:45', '22:00', '22:20', '22:40', '23:00'];

const mins = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const minuteOfDay = (d) => d.getHours() * 60 + d.getMinutes();
const peak = (m) => (m >= 4 * 60 && m < 8 * 60) || (m >= 17 * 60 && m < 22 * 60);

// The next few times from a daily list, and what's first tomorrow when today's are done.
export function nextTimes(list, now = new Date(), count = 3) {
  const m = minuteOfDay(now);
  const next = list.filter((t) => mins(t) >= m).slice(0, count);
  return { next, done: next.length === 0, first: list[0], last: list[list.length - 1] };
}

// Whether a bus route is running now from JB, and roughly how often.
export function busNow(route, now = new Date()) {
  const m = minuteOfDay(now);
  if (route === 'CW1') {
    const running = m >= 4 * 60; // 04:00 to 00:00 from JB CIQ (the last one leaves at midnight)
    return { running, every: !running ? null : peak(m) ? 'about every 5 min' : 'every 15–30 min', hours: 'Leaves JB 04:00 to midnight' };
  }
  if (route === 'CW2') {
    const night = m >= 23 * 60 || m < 4 * 60;
    return { running: true, every: night ? 'every 30 min (night)' : peak(m) ? 'about every 5 min' : 'every 15–20 min', hours: '24 hours' };
  }
  if (route === 'CW5') {
    const running = m >= 5 * 60 && m <= 22 * 60 + 30;
    return { running, every: !running ? null : peak(m) ? 'about every 20 min' : 'about every 45 min', hours: 'Leaves JB 05:00 to 22:30' };
  }
  return null;
}

// ---- Best-estimate arrival in Singapore ----
// Not published anywhere: rough journey times, to be tuned (LTA travel times on the BKE once the
// key is in, and what drivers see). Heavy = the morning rush into Singapore (05:00–09:00).
export const JB_EST = {
  ktmOut: 15, // train arrives at Woodlands -> through immigration and out
  jbToWoodlands: 20, jbToWoodlandsHeavy: 45, // bus leaves JB CIQ -> out of Woodlands Checkpoint
  woodlandsToKranji: 10, woodlandsToQueenSt: 35, woodlandsToNewton: 25, woodlandsToNewtonHeavy: 35,
};
const heavy = (m) => m >= 5 * 60 && m < 9 * 60;
const atMin = (now, m) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return new Date(d.getTime() + m * 60000); };
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// What's coming next on each route: one line each, with the estimated time people come out at
// Woodlands and at the route's drop-off.
export function jbNext(now = new Date()) {
  const m = minuteOfDay(now);
  const E = JB_EST;
  const rows = [];
  const ktm = nextTimes(KTM_ARRIVALS, now, 1);
  if (!ktm.done) {
    const arr = mins(ktm.next[0]);
    rows.push({ id: 'ktm', name: 'KTM Shuttle Tebrau', drop: 'Woodlands Train Checkpoint', what: `Train arrives ${ktm.next[0]}`, short: `Train ${ktm.next[0]}`,
      woodlands: hhmm(atMin(now, arr + E.ktmOut)), dropAt: hhmm(atMin(now, arr + E.ktmOut)) });
  } else rows.push({ id: 'ktm', name: 'KTM Shuttle Tebrau', drop: 'Woodlands Train Checkpoint', what: `No more trains today (first ${ktm.first})`, woodlands: null, dropAt: null });
  const toW = heavy(m) ? E.jbToWoodlandsHeavy : E.jbToWoodlands;
  for (const [id, drop, extra] of [['CW1', 'Kranji MRT', E.woodlandsToKranji], ['CW2', 'Queen Street', E.woodlandsToQueenSt]]) {
    const b = busNow(id, now);
    rows.push(b.running
      ? { id, name: `Causeway Link ${id}`, drop, what: `Leaving JB ${b.every}`, short: b.every.replace('about every ', 'every ~').replace(' (night)', ''), woodlands: hhmm(atMin(now, m + toW)), dropAt: hhmm(atMin(now, m + toW + extra)) }
      : { id, name: `Causeway Link ${id}`, drop, what: `Not running now (${b.hours.toLowerCase()})`, woodlands: null, dropAt: null });
  }
  const cw5 = nextTimes(CW5_FROM_WOODLANDS, now, 1);
  rows.push(!cw5.done
    ? { id: 'CW5', name: 'Causeway Link CW5', drop: 'Newton', what: `Next leaves Woodlands ${cw5.next[0]}`, short: `Leaves ${cw5.next[0]}`, woodlands: cw5.next[0],
      dropAt: hhmm(atMin(now, mins(cw5.next[0]) + (heavy(mins(cw5.next[0])) ? E.woodlandsToNewtonHeavy : E.woodlandsToNewton))) }
    : { id: 'CW5', name: 'Causeway Link CW5', drop: 'Newton', what: `Done for today (first ${cw5.first})`, woodlands: null, dropAt: null });
  return rows;
}

// Where a driver can be when these matter. At Woodlands every route passes through (everyone
// clears immigration there); at a drop-off, only that route.
export const JB_PLACES = [
  { id: 'woodlands', name: 'Woodlands Checkpoint', lat: 1.4450, lng: 103.7686, km: 2, routes: ['ktm', 'CW1', 'CW2', 'CW5'], at: 'woodlands' },
  { id: 'kranji', name: 'Kranji MRT', lat: 1.4251, lng: 103.7620, km: 0.8, routes: ['CW1'], at: 'drop' },
  { id: 'queen-street', name: 'Queen Street Bus Terminal', lat: 1.3008, lng: 103.8555, km: 0.6, routes: ['CW2'], at: 'drop' },
  { id: 'newton', name: 'Newton (CW5 stop)', lat: 1.3123, lng: 103.8393, km: 0.6, routes: ['CW5'], at: 'drop' },
];
const kmTo = (a, b) => {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};
export function jbPlace(loc) {
  if (!loc) return null;
  let best = null;
  for (const p of JB_PLACES) {
    const d = kmTo(loc, p);
    if (d <= p.km && (!best || d < best.d)) best = { ...p, d };
  }
  return best;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Compact rows. place: show only its routes, and the time that matters there.
// Minutes from now until an "HH:MM" today (past midnight counts as tomorrow).
const minsUntil = (t, now) => { let d = mins(t) - minuteOfDay(now); if (d < -12 * 60) d += 24 * 60; return d; };

// Radar: only what's immediately next at this place, and only if it's within the hour.
export function jbSoonest(now = new Date(), place, withinMin = 60) {
  let best = null;
  for (const r of jbNext(now).filter((x) => place.routes.includes(x.id))) {
    const when = place.at === 'woodlands' ? r.woodlands : r.dropAt;
    if (!when) continue;
    const d = minsUntil(when, now);
    if (d < 0 || d > withinMin) continue;
    if (!best || d < best.d) best = { ...r, when, d };
  }
  return best;
}

export function jbRowsHtml(now = new Date(), place = null) {
  if (place) {
    const r = jbSoonest(now, place);
    return r ? `<div class="jb-row compact"><b>${esc(r.id === 'ktm' ? 'KTM' : r.id)}</b><span class="note">${esc(r.short || r.what)}</span><span class="jb-eta">~${r.when}</span></div>` : '';
  }
  const rows = jbNext(now);
  return rows.map((r) => {
    const when = place && place.at === 'woodlands' ? r.woodlands : r.dropAt;
    const where = place && place.at === 'woodlands' ? 'out at Woodlands' : `at ${r.drop}`;
    if (place) {
      // Radar: one short line each, so the earnings cards stay in view.
      return `<div class="jb-row compact"><b>${esc(r.id === 'ktm' ? 'KTM' : r.id)}</b><span class="note">${esc(r.short || r.what)}</span><span class="jb-eta">${when ? `~${when}` : '—'}</span></div>`;
    }
    return `<div class="jb-row"><div><b>${esc(r.name)}</b><div class="note">${esc(r.what)}</div></div>
      <div class="jb-eta">${when ? `~${when}<div class="note">${esc(where)}</div>` : '<div class="note">—</div>'}</div></div>`;
  }).join('');
}
