// Radar's urgent strip, from LTA (via /api/info, shared and cached on the server): a major MRT
// disruption anywhere (stranded commuters book rides), and a flood alert within 3 km of you.
import { here } from './where.js';

const al = { lta: null, at: 0, loading: false };
const kmApart = (a, b) => {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

// Pure, for the tests: what Radar should show for this LTA data and location.
export function radarAlerts(lta, loc) {
  const out = [];
  if (!lta) return out;
  const tr = lta.train;
  if (tr && tr.major) {
    out.push({ kind: 'mrt', title: `MRT disruption${tr.lines.length ? `: ${[...new Set(tr.lines.map((x) => x.line))].join(', ')}` : ''}`, text: tr.messages[0] || 'See Info for details.' });
  }
  for (const f of lta.floods || []) {
    if (!loc || !f.lat) continue;
    const d = kmApart(loc, f);
    if (d <= 3) out.push({ kind: 'flood', title: `${f.headline} · ${d < 1 ? 'under 1' : d.toFixed(1)} km away`, text: f.desc });
  }
  return out;
}

export function alertsHtml() {
  // Short on Radar (the earnings stay in view); the full text is on Info.
  const short = (t) => { const x = String(t || '').replace(/^\d{3,4}hrs:\s*/i, ''); return x.length > 90 ? `${x.slice(0, 88).replace(/\s+\S*$/, '')}…` : x; };
  return radarAlerts(al.lta, here()).map((a) => `<div class="alert-card bad compact"><b>${esc(a.title)}</b><div class="note">${esc(short(a.text))}</div></div>`).join('');
}
