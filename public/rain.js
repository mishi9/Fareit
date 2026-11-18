// Rain near you, from NEA (via the server, refreshed every 5 minutes): rain gauges for "raining
// now" and the 2-hour forecast per town for "rain expected". Rain covers everything wet: light or
// heavy rain, showers, thundery showers. It may lift fares a little, or not: trips saved while
// it's raining are tagged so that's learned from what they paid (formula.js rainLift).
import { here } from './where.js';

export const RAIN_NEAR_KM = 3; // a gauge with rain within this of you: raining near you
export const FORECAST_NEAR_KM = 6; // the forecast town's centre within this of you
export const RAIN_STALE_MIN = 30; // older readings don't count
const WET = /rain|shower|thunder|drizzle/i;
export const isWet = (forecast) => WET.test(String(forecast || ''));
export const isThunder = (forecast) => /thunder/i.test(String(forecast || ''));

const kmApart = (a, b) => {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

// Pure, for the page and the tests. null when dry or unknown;
// { kind: 'now', mm, km, area, forecast } when a gauge within 3 km has rain in its latest 5 minutes;
// { kind: 'forecast', area, forecast, km } when your town's 2-hour forecast is wet.
export function rainAt(loc, data, now = Date.now()) {
  if (!loc || !data) return null;
  let town = null;
  for (const a of data.areas || []) {
    const km = kmApart(loc, a);
    if (km <= FORECAST_NEAR_KM && (!town || km < town.km)) town = { ...a, km };
  }
  const fresh = data.readAt && now - data.readAt <= RAIN_STALE_MIN * 60000;
  if (fresh) {
    let best = null;
    for (const s of data.wet || []) {
      const km = kmApart(loc, s);
      if (km <= RAIN_NEAR_KM && (!best || km < best.km)) best = { ...s, km };
    }
    if (best) return { kind: 'now', mm: best.mm, km: best.km, area: town ? town.name : null, forecast: town ? town.f : null };
  }
  const forecastLive = data.valid && data.valid.end ? now <= data.valid.end + 30 * 60000 : Boolean(data.at && now - data.at <= 3 * 3600000);
  if (town && forecastLive && isWet(town.f)) return { kind: 'forecast', area: town.name, forecast: town.f, km: town.km, until: data.valid ? data.valid.text : '' };
  return null;
}

// Saved with each trip: 1 raining (or forecast rain) near the pickup, 0 dry, null if not known.
export function rainTag(loc, data, ts = Date.now()) {
  if (!loc || !data || !data.at || ts - data.at > RAIN_STALE_MIN * 60000) return null;
  return rainAt(loc, data, ts) ? 1 : 0;
}

const rd = { data: null, at: 0, loading: false };
export async function loadRain(onDone, force = false) {
  if (rd.loading || (!force && Date.now() - rd.at < 3 * 60000)) return;
  rd.loading = true;
  try {
    const res = await fetch('/api/rain');
    if (res.ok) { const d = await res.json(); if (d && d.at) rd.data = d; rd.at = Date.now(); }
  } catch { /* offline: keep the last */ }
  rd.loading = false;
  if (onDone) onDone();
}
export const rainData = () => rd.data;
export const rainNow = (loc = here()) => rainAt(loc, rd.data);
export const rainTagNow = (loc = here(), ts = Date.now()) => rainTag(loc, rd.data, ts);

const e = (t) => String(t).replace(/[&<>"']/g, '');
// Radar: one line, place in bold.
export function rainBanner(r) {
  if (!r) return '';
  const icon = isThunder(r.forecast) ? '⛈' : '☔';
  const where = r.area ? ` · <b>${e(r.area)}</b>` : '';
  return r.kind === 'now'
    ? `<div class="glance-line rain"><span class="surge-up" aria-hidden="true">${icon}</span> <b>Raining</b> near you${where}<span class="glance-sub">${r.forecast && isWet(r.forecast) ? `${e(r.forecast)} · ` : ''}fares may run a little higher</span></div>`
    : `<div class="glance-line rain"><span class="surge-up" aria-hidden="true">${icon}</span> <b>${e(r.forecast)}</b> expected${where}<span class="glance-sub">${r.until ? `${e(r.until)} · ` : ''}NEA forecast</span></div>`;
}

// Info: wet towns grouped by forecast, wettest first.
export function rainInfoHtml(data, loc = null) {
  if (!data || !data.at) return '<p class="note">No weather data yet.</p>';
  const wet = (data.areas || []).filter((a) => isWet(a.f));
  const r = rainAt(loc, data);
  const head = r ? rainBanner(r) : '';
  if (!wet.length) return `${head}<p class="note">No rain forecast${data.valid && data.valid.text ? ` (${e(data.valid.text)})` : ''}. ${data.wet && data.wet.length ? `${data.wet.length} rain gauge${data.wet.length === 1 ? '' : 's'} reading rain.` : ''}</p>`;
  const rank = (f) => (/heavy/i.test(f) ? 0 : /thunder/i.test(f) ? 1 : /moderate|showers/i.test(f) ? 2 : 3);
  const by = new Map();
  for (const a of wet) { if (!by.has(a.f)) by.set(a.f, []); by.get(a.f).push(a.name); }
  const groups = [...by.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  return `${head}${groups.map(([f, names]) => `<div class="card"><div class="line1"><span><b>${isThunder(f) ? '⛈' : '☔'} ${e(f)}</b></span><span class="when">${names.length} area${names.length === 1 ? '' : 's'}</span></div><div class="meta">${names.map(e).join(', ')}</div></div>`).join('')}
    <p class="note">NEA 2-hour forecast${data.valid && data.valid.text ? `, ${e(data.valid.text)}` : ''}. ${data.wet && data.wet.length ? `${data.wet.length} of ${data.stations} rain gauges reading rain now.` : 'No rain gauge reading rain right now.'}</p>`;
}
