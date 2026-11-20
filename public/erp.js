// ERP and "My routes" on Info. Drivers pick the roads they're on (PIE to Tuas, CTE to the city...)
// and Info shows, for each: travel time, ERP on it now and next, accidents, and rain along it.
//
// ERP rates: LTA's base rate table for cars and taxis, effective 7 Sep 2026 (DataMall static
// dataset "ERP Rates", 1PCU_ERP_Rates_Report.pdf), weekdays only (no charge on Saturdays in that
// table, Sundays or public holidays). Gantry groups and where they are: the table's own headings
// and DataMall's API guide Annex D. Roads use LTA's travel-time directions: 1 = east to west or
// south to north, 2 = west to east or north to south. Times are minutes after midnight [from, to).
// When LTA revises rates (usually each school term), replace ERP_GROUPS and ERP_FROM.
export const ERP_FROM = '7 Sep 2026';
export const ERP_GROUPS = [
  { road: 'AYE|1', name: 'AYE to Tuas, before Clementi Rd', gantries: [41], wkd: [[1020,  1025,  0.5],  [1025,  1050,  1.0],  [1050,  1055,  2.0],  [1055,  1075,  3.0],  [1075,  1080,  2.5],  [1080,  1110,  2.0],  [1110,  1115,  2.5],  [1115,  1135,  3.0],  [1135,  1140,  2.0],  [1140,  1165,  1.0],  [1165,  1170,  0.5]] },
  { road: 'AYE|2', name: 'AYE to city, before Alexandra Rd', gantries: [36], wkd: [[480,  485,  0.5],  [485,  510,  1.0],  [510,  515,  1.5],  [515,  535,  2.0],  [535,  540,  1.5],  [540,  565,  1.0],  [565,  570,  0.5]] },
  { road: 'AYE|2', name: 'AYE to city, Clementi', gantries: [52,  53,  74], wkd: [[420,  425,  0.5],  [425,  450,  1.0],  [450,  455,  3.0],  [455,  475,  5.0],  [475,  480,  3.5],  [480,  510,  2.0],  [510,  515,  3.0],  [515,  535,  4.0],  [535,  540,  3.5],  [540,  565,  3.0],  [565,  570,  2.5],  [570,  595,  2.0],  [595,  600,  1.0],  [1050,  1055,  1.5],  [1055,  1075,  3.0],  [1075,  1080,  2.0],  [1080,  1105,  1.0],  [1105,  1110,  0.5]] },
  { road: 'CITY', name: 'Orchard cordon', gantries: [4,  12,  13,  14,  15,  21,  22,  26,  27], wkd: [[660,  665,  0.5],  [665,  1135,  1.0],  [1135,  1140,  0.5]] },
  { road: 'CITY', name: 'YMCA (Orchard Rd) / Fort Canning Tunnel', gantries: [47,  49], wkd: [[660,  665,  0.5],  [665,  1135,  1.0],  [1135,  1140,  0.5]] },
  { road: 'CTE|1', name: 'CTE northbound, after PIE', gantries: [46,  67], wkd: [[1050,  1055,  2.0],  [1055,  1135,  4.0],  [1135,  1140,  3.5],  [1140,  1165,  3.0],  [1165,  1170,  2.0],  [1170,  1195,  1.0],  [1195,  1200,  0.5]] },
  { road: 'CTE|1', name: 'CTE northbound, before PIE exit', gantries: [51], wkd: [[1050,  1055,  0.5],  [1055,  1135,  1.0],  [1135,  1140,  0.5]] },
  { road: 'CTE|2', name: 'CTE to city, after Braddell Rd', gantries: [31,  33,  34], wkd: [[450,  455,  1.0],  [455,  480,  2.0],  [480,  485,  3.0],  [485,  510,  4.0],  [510,  515,  4.5],  [515,  535,  5.0],  [535,  540,  4.5],  [540,  565,  4.0],  [565,  570,  3.5],  [570,  595,  3.0],  [595,  600,  1.5]] },
  { road: 'CTE|2', name: 'CTE to city, before Braddell Rd', gantries: [35], wkd: [[420,  425,  1.0],  [425,  480,  2.0],  [480,  485,  2.5],  [485,  565,  3.0],  [565,  570,  2.0],  [570,  595,  1.0],  [595,  600,  0.5]] },
  { road: 'CTE|2', name: 'CTE slip road to PIE (Changi)', gantries: [68], wkd: [[450,  455,  1.0],  [455,  480,  2.0],  [480,  485,  2.5],  [485,  510,  3.0],  [510,  515,  4.0],  [515,  535,  5.0],  [535,  540,  4.5],  [540,  565,  4.0],  [565,  570,  3.5],  [570,  595,  3.0],  [595,  600,  1.5]] },
  { road: 'KPE|2', name: 'KPE southbound, after Defu Flyover', gantries: [50], wkd: [[420,  425,  0.5],  [425,  450,  1.0],  [450,  455,  2.5],  [455,  480,  4.0],  [480,  485,  4.5],  [485,  510,  5.0],  [510,  515,  5.5],  [515,  535,  6.0],  [535,  540,  4.0],  [540,  565,  2.0],  [565,  570,  1.5],  [570,  595,  1.0],  [595,  600,  0.5]] },
  { road: 'MCE|2', name: 'MCE eastbound', gantries: [92,  93], wkd: [[1110,  1115,  0.5],  [1115,  1135,  1.0],  [1135,  1140,  0.5]] },
  { road: 'PIE|1', name: 'PIE after Kallang Bahru, Woodsville', gantries: [32,  45], wkd: [[420,  425,  0.5],  [425,  450,  1.0],  [450,  455,  1.5],  [455,  510,  2.0],  [510,  515,  3.0],  [515,  535,  4.0],  [535,  540,  3.0],  [540,  565,  2.0],  [565,  570,  1.5],  [570,  595,  1.0],  [595,  600,  0.5]] },
  { road: 'PIE|1', name: 'PIE slip road into CTE', gantries: [42], wkd: [[450,  455,  1.0],  [455,  480,  2.0],  [480,  485,  3.0],  [485,  510,  4.0],  [510,  515,  4.5],  [515,  535,  5.0],  [535,  540,  4.5],  [540,  565,  4.0],  [565,  570,  3.5],  [570,  595,  3.0],  [595,  600,  1.5]] },
  { road: 'PIE|1', name: 'PIE westbound, before Eunos Link', gantries: [65], wkd: [[450,  455,  0.5],  [455,  510,  1.0],  [510,  515,  1.5],  [515,  535,  2.0],  [535,  540,  1.5],  [540,  565,  1.0],  [565,  570,  0.5]] },
  { road: 'PIE|2', name: 'PIE to Changi, after Adam Rd', gantries: [37,  38], wkd: [[450,  455,  1.0],  [455,  505,  2.0],  [505,  510,  1.5],  [510,  565,  1.0],  [565,  570,  0.5]] },
];

// Singapore public holidays, from MOM (mom.gov.sg/employment-practices/public-holidays, 2026-27).
// No ERP on these. A holiday on a Sunday makes the Monday after a holiday too (isHoliday does that).
// Add the next year when MOM publishes it.
export const PUBLIC_HOLIDAYS = [
  '2026-01-01', '2026-02-17', '2026-02-18', '2026-03-21', '2026-04-03', '2026-05-01', '2026-05-27', '2026-05-31',
  '2026-08-09', '2026-11-08', '2026-12-25',
  '2027-01-01', '2027-02-06', '2027-02-07', '2027-03-10', '2027-03-26', '2027-05-01', '2027-05-17', '2027-05-20',
  '2027-08-09', '2027-10-28', '2027-12-25',
];
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function isHoliday(ts = Date.now()) {
  const d = new Date(ts);
  if (PUBLIC_HOLIDAYS.includes(ymd(d))) return true;
  const y = new Date(ts - 86400000);
  return d.getDay() === 1 && y.getDay() === 0 && PUBLIC_HOLIDAYS.includes(ymd(y));
}

// Charge now and what's next for one gantry group. ts: a time (Singapore). holiday: no ERP.
export function erpNow(group, ts = Date.now(), holiday = isHoliday(ts)) {
  const d = new Date(ts);
  const day = d.getDay();
  const min = d.getHours() * 60 + d.getMinutes();
  const free = holiday || day === 0 || day === 6;
  const slots = free ? [] : group.wkd;
  const cur = slots.find(([a, b]) => min >= a && min < b);
  const now = cur ? cur[2] : 0;
  // next change today: the next slot with a different amount (or the end of charging)
  let next = null;
  if (!free) {
    for (const [a, b, v] of slots) {
      if (a <= min && b > min) continue;
      if (a > min && v !== now) { next = { at: a, amount: v }; break; }
    }
    if (cur && !next) {
      const last = slots.filter(([a]) => a >= cur[0]);
      let end = cur[1];
      for (const [a, b] of last) if (a === end) end = b;
      next = { at: end, amount: 0 };
    }
    if (cur && next && next.amount !== 0) {
      // charging continues; also tell when it stops
      let end = cur[1];
      for (const [a, b] of slots) if (a === end) end = b;
      if (end <= 24 * 60) next.ends = end;
    }
  }
  return { now, next, free };
}
// One road's ERP in a few words: { now: [lo, hi] dollars or null, until, from, amount, free }.
export function roadErp(groups, ts = Date.now()) {
  const es = groups.map((g) => erpNow(g, ts));
  if (!es.length) return null;
  if (es.every((e) => e.free)) return { free: true };
  const on = es.filter((e) => e.now);
  if (on.length) {
    const ends = on.map((e) => (e.next ? (e.next.amount === 0 ? e.next.at : (e.next.ends || e.next.at)) : 0));
    return { now: [Math.min(...on.map((e) => e.now)), Math.max(...on.map((e) => e.now))], until: Math.max(...ends) };
  }
  const nx = es.filter((e) => e.next).sort((a, b) => a.next.at - b.next.at)[0];
  return nx ? { from: nx.next.at, amount: nx.next.amount } : { done: true };
}
export const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// Towns (NEA 2-hour forecast areas) each expressway runs through, for "rain along this road".
export const ROAD_TOWNS = {
  PIE: ['Changi', 'Tampines', 'Bedok', 'Paya Lebar', 'Geylang', 'Kallang', 'Toa Payoh', 'Novena', 'Bukit Timah', 'Clementi', 'Jurong East', 'Jurong West', 'Boon Lay', 'Pioneer', 'Tuas'],
  AYE: ['City', 'Bukit Merah', 'Queenstown', 'Clementi', 'Jurong East', 'Jurong West', 'Pioneer', 'Tuas'],
  CTE: ['City', 'Bukit Merah', 'Novena', 'Toa Payoh', 'Bishan', 'Ang Mo Kio', 'Seletar', 'Yishun'],
  ECP: ['Changi', 'Bedok', 'Marine Parade', 'Kallang', 'City'],
  KPE: ['Marine Parade', 'Geylang', 'Paya Lebar', 'Hougang', 'Sengkang', 'Punggol'],
  MCE: ['City', 'Kallang', 'Marine Parade'],
  BKE: ['Bukit Timah', 'Bukit Panjang', 'Mandai', 'Sungei Kadut', 'Woodlands'],
  KJE: ['Bukit Batok', 'Tengah', 'Choa Chu Kang', 'Sungei Kadut'],
  SLE: ['Woodlands', 'Mandai', 'Sembawang', 'Yishun', 'Seletar'],
  TPE: ['Pasir Ris', 'Tampines', 'Punggol', 'Sengkang', 'Seletar'],
  CITY: ['City', 'Tanglin', 'Novena', 'Bukit Merah', 'Kallang'],
};

// The roads drivers can pick: from LTA's travel times (name + direction + where it ends), plus
// the city (CBD and Orchard ERP). key 'PIE|1'.
export function routeChoices(travel) {
  const out = (travel || []).map((t) => ({ key: `${t.name}|${t.dir}`, name: t.name, dir: t.dir, to: t.to }));
  out.push({ key: 'CITY', name: 'City', dir: 0, to: 'CBD / Orchard' });
  return out;
}

// LTA incident text names the road and often "(towards X)": keep those on this road and direction.
export function incidentsOn(route, incidents) {
  if (route.key === 'CITY') return [];
  const name = new RegExp(`\\b${route.name}\\b`);
  const toWord = String(route.to || '').trim().split(/\s+/)[0].toLowerCase();
  return (incidents || []).filter((x) => {
    if (!name.test(x.msg)) return false;
    const m = /\(towards ([^)]+)\)/i.exec(x.msg);
    if (!m) return true;
    const t = m[1].trim().toLowerCase();
    return !toWord || t.startsWith(toWord) || toWord.startsWith(t.split(/\s+/)[0]);
  });
}

// Where an incident is, in a few words, from LTA's text: "... after Clementi Ave 6 Exit. Avoid lane 1."
// -> "after Clementi Ave 6". null when it can't tell.
export function shortWhere(msg) {
  const m = /\b(after|before|at|near|from)\s+([^.]+)/i.exec(String(msg || '').replace(/^\(\d+\/\d+\)\d+:\d+\s*/, ''));
  if (!m) return null;
  let place = m[2].replace(/\s+(Exit|Entrance|Entry)\b.*$/i, '').replace(/\s+to\s+.*$/i, '').trim();
  if (place.length > 24) place = `${place.slice(0, 23).trim()}…`;
  return `${m[1].toLowerCase()} ${place}`;
}

const PICK_KEY = 'agaration-routes';
export const pickedRoutes = () => { try { return JSON.parse(localStorage.getItem(PICK_KEY) || '[]'); } catch { return []; } };
export function setPicked(keys) { try { localStorage.setItem(PICK_KEY, JSON.stringify(keys)); } catch { /* private mode */ } }
