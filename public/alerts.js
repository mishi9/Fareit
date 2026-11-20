// Radar's urgent strip, from LTA (via /api/info, shared and cached on the server): a major MRT
// disruption anywhere (stranded commuters book rides), and a flood alert within 3 km of you.
import { here } from './where.js';
import { esc, mrtStretch, floodPlace } from './glance.js';

const al = { lta: null, at: 0, loading: false };
const kmApart = (a, b) => {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

export async function loadAlerts(onDone) {
  if (al.loading || Date.now() - al.at < 2 * 60000) return;
  al.loading = true;
  try {
    const res = await fetch('/api/info');
    if (res.ok) { al.lta = (await res.json()).lta || null; al.at = Date.now(); }
  } catch { /* offline */ }
  al.loading = false;
  onDone();
}

// Pure, for the tests: what Radar should show for this LTA data and location. html is ready to
// show: one short line each, places in bold.
export function radarAlerts(lta, loc) {
  const out = [];
  if (!lta) return out;
  const tr = lta.train;
  if (tr && tr.major) {
    const lines = [...new Set(tr.lines.map((x) => x.line))].join(', ');
    const st = mrtStretch(tr.messages[0] || '');
    out.push({ kind: 'mrt', html: `<b>${esc(lines || 'MRT')}</b> down${st ? `: <b>${esc(st.from)}</b> – <b>${esc(st.to)}</b>` : tr.lines[0] && tr.lines[0].stations ? `: ${esc(tr.lines[0].stations)}` : ''}` });
  }
  for (const f of lta.floods || []) {
    if (!loc || !f.lat) continue;
    const d = kmApart(loc, f);
    if (d > 3) continue;
    const place = floodPlace(f.desc) || f.area;
    out.push({ kind: 'flood', html: `Flash flood${place ? ` <b>${esc(place)}</b>` : ''} · ${d < 1 ? '<1' : d.toFixed(1)} km` });
  }
  return out;
}

// The current alerts as a list ({ kind: 'mrt' | 'flood', html }), for Radar's notices.
export const alertsList = () => radarAlerts(al.lta, here());

export function alertsHtml() {
  return radarAlerts(al.lta, here()).map((a) => `<div class="glance-line bad">${a.html}</div>`).join('');
}
