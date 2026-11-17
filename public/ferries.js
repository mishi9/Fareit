// Ferries into Singapore: the operators' own published timetables (not live), worked out against
// the clock. Indonesian departure times are WIB (UTC+7), one hour behind Singapore, so a 08:35
// Bintan departure is 09:35 Singapore time; arrival adds the crossing time. Crossing times are the
// operator's or terminal's published figure where there is one, else marked as an estimate.
// Days: 'daily', or day numbers (0 Sun .. 6 Sat). Public holidays aren't known to the app: on a
// public holiday the weekend list is the better guide.

const WIB_OFFSET_MIN = 60; // Singapore = WIB + 1 h

export const FERRY_TERMINALS = [
  { id: 'tmft', name: 'Tanah Merah Ferry Terminal', short: 'Tanah Merah', lat: 1.3155, lng: 103.9890, km: 1 },
  { id: 'hfc', name: 'HarbourFront Centre', short: 'HarbourFront', lat: 1.2650, lng: 103.8205, km: 0.8 },
];

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];
const ALL = [0, 1, 2, 3, 4, 5, 6];

// Each sailing list: terminal, operator(s), origin, crossing minutes (est: true when not published),
// and departures in WIB with the days they run.
export const FERRY_ROUTES = [
  // Bintan Resort Ferries, brf.com.sg/ferry-schedule: "approximately 1 hour and 10 minutes".
  { to: 'tmft', op: 'Bintan Resort Ferries', from: 'Bintan (Bandar Bentan Telani)', min: 70, src: 'brf.com.sg', runs: [
    { days: ALL, times: ['08:35', '11:35', '14:35', '18:35'] },
    { days: [5], times: ['16:35'] }, // Friday only, from 1 Apr 2026
  ] },
  // Majestic Fast Ferry, timetable effective 15 May 2026. Batam crossing ~60 min (Singapore Cruise Centre).
  { to: 'tmft', op: 'Majestic', from: 'Batam Centre', min: 60, src: 'majesticfastferry.com.sg (15 May 2026)', runs: [
    { days: WEEKDAYS, times: ['06:15', '08:25', '12:00', '15:30', '18:00'] },
    { days: [5], times: ['19:50'] },
    { days: WEEKEND, times: ['06:15', '08:25', '09:40', '12:00', '13:00', '15:30', '17:00', '18:00', '19:50'] },
  ] },
  { to: 'tmft', op: 'Majestic', from: 'Tanjung Pinang', min: 120, est: true, src: 'majesticfastferry.com.sg (15 May 2026)', runs: [
    { days: WEEKEND, times: ['07:30', '13:00'] }, // weekends, public holidays and their eves only
  ] },
  // Batam Fast, schedule with effect from 1 Nov 2026 (two of these are Sindo-operated).
  { to: 'tmft', op: 'Batam Fast / Sindo', from: 'Batam Centre', min: 60, src: 'batamfast.com (1 Nov 2026), sindoferry.com.sg', runs: [
    { days: [0, 4, 5, 6], times: ['07:45'] },
    { days: ALL, times: ['08:00', '09:20', '11:30', '13:20'] },
  ] },
  { to: 'tmft', op: 'Batam Fast', from: 'Nongsapura (Batam)', min: 60, src: 'batamfast.com (1 Nov 2026)', runs: [
    { days: ALL, times: ['06:00', '08:00', '09:30', '12:10', '14:20', '15:40', '17:30', '20:00'] },
  ] },
  { to: 'tmft', op: 'Sindo', from: 'Tanjung Pinang', min: 120, est: true, src: 'sindoferry.com.sg', runs: [
    { days: ALL, times: ['06:45', '13:30'] },
  ] },
];

const mins = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// Arrivals in Singapore time for the day containing `now` and the next, soonest first.
export function ferryArrivals(terminal, now = new Date()) {
  const out = [];
  for (const dayShift of [0, 1]) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + dayShift);
    const dow = day.getDay();
    for (const r of FERRY_ROUTES.filter((x) => x.to === terminal)) {
      const seen = new Set();
      for (const run of r.runs) {
        if (!run.days.includes(dow)) continue;
        for (const t of run.times) {
          if (seen.has(t)) continue;
          seen.add(t);
          const arrive = new Date(day.getTime() + (mins(t) + WIB_OFFSET_MIN + r.min) * 60000);
          out.push({ at: arrive, arrive: hhmm(arrive), departWib: t, from: r.from, op: r.op, est: Boolean(r.est) });
        }
      }
    }
  }
  return out.filter((a) => a.at.getTime() >= now.getTime() - 10 * 60000).sort((a, b) => a.at - b.at);
}

const kmTo = (a, b) => {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};
export const ferryTerminalAt = (loc) => (loc ? FERRY_TERMINALS.find((t) => kmTo(loc, t) <= t.km) || null : null);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// What's next into a terminal. compact: Radar's short rows.
export function ferryRowsHtml(terminal, now = new Date(), { count = 3, compact = false } = {}) {
  const list = ferryArrivals(terminal, now).slice(0, count);
  if (!list.length) return '<p class="note">No more sailings listed today.</p>';
  return list.map((a) => {
    const day = a.at.getDate() !== now.getDate() ? ' tmrw' : '';
    return compact
      ? `<div class="jb-row compact"><span class="note">${esc(a.from)}</span><span class="jb-eta">~${a.arrive}${day}</span></div>`
      : `<div class="jb-row"><div><b>${esc(a.from)}</b><div class="note">${esc(a.op)} · leaves ${a.departWib} Indonesian time</div></div>
        <div class="jb-eta">~${a.arrive}${day}<div class="note">${a.est ? 'arrives (est.)' : 'arrives'}</div></div></div>`;
  }).join('');
}
