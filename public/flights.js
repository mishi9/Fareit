// Changi arrivals for Radar's airport screen: how many flights land at each terminal soon.
// The server fetches the schedule from a flight data service a few times an hour and shares it
// with every phone; this only asks the server. No passenger estimate: flight counts only.

const TERMINALS = ['T1', 'T2', 'T3', 'T4'];
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

export function renderFlights(box, onDone) {
  load(() => renderFlights(box, onDone));
  const d = f.data;
  if (!d && !f.error) { box.innerHTML = '<div class="band-head">Arrivals</div><p class="note">Loading…</p>'; return; }
  if (!d || d.ready === false) {
    box.innerHTML = `<div class="band-head">Arrivals</div><p class="note">${f.error || 'Flight arrivals coming soon.'}</p>`;
    return;
  }
  const t = d.terminals || {};
  box.innerHTML = `
    <div class="band-head">Landing next hour · updated ${hm(d.updated_at)}${d.stale ? ' (old)' : ''}</div>
    <div class="ap-grid">
      ${TERMINALS.map((k) => {
        const x = t[k] || { landed: 0, next: 0, later: 0 };
        const busy = x.next >= 8 ? 'busy' : x.next === 0 && x.landed === 0 ? 'quiet' : '';
        return `<div class="ap-term ${busy}">
          <div class="ap-name">${k}</div>
          <div class="ap-big">${x.next}</div>
          <div class="ap-sub">${x.landed} just landed · ${x.later} after</div>
        </div>`;
      }).join('')}
    </div>
    ${f.error ? `<p class="note">${f.error}</p>` : ''}`;
}
