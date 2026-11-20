// Changi arrivals for Radar's airport screen: per terminal, flights landing in the next 30 minutes,
// about how many people are on them, and about how many of those will book a ride-hailing car
// (RIDE_SHARE). The server works it out from open flight-tracking data (public/arrivals.js) every
// 5 minutes and shares it with every phone; this only asks the server.
const TERMINALS = ['T1', 'T2', 'T3', 'T4'];
// Half flights: a Singapore Airlines flight we can't place is counted half at T2, half at T3.
const count = (n) => (n % 1 ? `${Math.floor(n) || ''}½` : String(n));
const REFRESH = 5 * 60 * 1000;
const f = { data: null, at: 0, loading: false, error: '' };
const pad = (n) => String(n).padStart(2, '0');
const hm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

async function load(onDone) {
  if (f.loading || Date.now() - f.at < REFRESH) return;
  f.loading = true;
  try {
    const res = await fetch('/api/flights');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Couldn’t get flights.');
    f.data = body;
    f.error = '';
    f.at = Date.now();
  } catch (e) {
    f.error = navigator.onLine ? e.message : 'Offline: flights show when you’re connected.';
    f.at = Date.now() - REFRESH + 60 * 1000; // try again in a minute
  }
  f.loading = false;
  onDone();
}

// For Info's Airport line: flights still in the air landing within 45 min (null until loaded).
export function flightsSoon(onDone) {
  load(onDone);
  return f.data && f.data.ready ? (Number.isFinite(f.data.soon) ? f.data.soon : null) : null;
}

export function renderFlights(box, onDone) {
  load(() => renderFlights(box, onDone));
  const d = f.data;
  if (!d && !f.error) { box.innerHTML = '<div class="band-head">Arrivals</div><p class="note">Loading…</p>'; return; }
  if (!d || d.ready === false) {
    box.innerHTML = `<div class="band-head">Arrivals</div><p class="note">${f.error || 'Flight arrivals coming soon.'}</p>`;
    return;
  }
  const t = d.terminals || {};
  const u = d.unknown || { next: 0 };
  box.innerHTML = `
    <div class="band-head">Landing in the next 30 min · updated ${hm(d.updated_at)}${d.stale ? ' (old)' : ''}</div>
    <div class="ap-grid">
      ${TERMINALS.map((k) => {
        const x = t[k] || { next: 0, pax: 0, riders: 0, landed: 0, landedRiders: 0 };
        const busy = x.next >= 4 ? 'busy' : x.next === 0 && x.landed === 0 ? 'quiet' : '';
        return `<div class="ap-term ${busy}">
          <div class="ap-name">${k}</div>
          <div class="ap-big">${count(x.next)}<span class="ap-unit"> flight${x.next === 1 ? '' : 's'}</span></div>
          <div class="ap-riders">${x.next ? `~${x.riders} riders` : '—'}</div>
          <div class="ap-sub">${x.next ? `~${x.pax} on board · ` : ''}${count(x.landed)} landed last 30 min${x.landed ? ` (~${x.landedRiders} riders)` : ''}</div>
        </div>`;
      }).join('')}
    </div>
    <p class="note">${u.next ? `+${u.next} more landing, terminal not known. ` : ''}Riders: about 30% of passengers (planes ~80% full) booking Grab or another app; a family is one booking. Terminals from Changi Airport\u2019s airline and arrivals lists; a Singapore Airlines flight we can\u2019t place counts half at T2, half at T3. Flight data: <b>adsb.lol</b> (open data, thanks to its volunteer receivers).</p>
    ${f.error ? `<p class="note">${f.error}</p>` : ''}`;
}
