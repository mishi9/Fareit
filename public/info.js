// Info tab: what's going on around Singapore that matters for driving. Events (owner-added),
// the airport (taxis waiting, queue readings), arrivals from JB, and, once the LTA DataMall key
// is set up, road incidents and expressway travel times. Display only: nothing here changes the
// estimates, except that trips around an event are kept apart from normal (formula.js).
import { eventsList, venuesList, loadEvents, addEvent, deleteEvent, onEventsChange } from './events.js';
import { here } from './where.js';
import { isOwner, isOwnerPhone } from './access.js';
import { eventNow } from './lab.js';
import { queueNow } from './queue.js';
import { KTM_ARRIVALS, CW5_FROM_WOODLANDS, nextTimes, busNow } from './jb.js';

const info = { root: null, live: null, liveAt: 0, liveErr: '', timer: null };
const LIVE_REFRESH = 2 * 60 * 1000;
const pad = (n) => String(n).padStart(2, '0');
const hm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const signed = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(0)}%`;
const kmApart = (a, b) => {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};
const dayLabel = (ts) => {
  const d = new Date(ts); const t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - t) / 86400000);
  return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : d.toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short' });
};

export function buildInfo(root) {
  info.root = root;
  root.innerHTML = `
    <div id="info-old"></div>
    <section class="stack"><h2>Events</h2><div id="info-events" class="stack"></div><div id="info-event-add"></div></section>
    <section class="stack"><h2>Airport</h2><div id="info-airport" class="stack"></div></section>
    <section class="stack"><h2>From JB</h2><div id="info-jb" class="stack"></div></section>
    <section class="stack"><h2>Road incidents</h2><div id="info-incidents"></div></section>
    <section class="stack"><h2>Expressway travel times</h2><div id="info-travel"></div></section>`;
  onEventsChange(() => renderEvents());
  buildEventForm();
}

export function showInfo() {
  if (!info.root) return;
  loadEvents();
  renderEvents();
  renderLive();
  loadLive();
  clearInterval(info.timer);
  info.timer = setInterval(() => { if (!info.root.closest('[hidden]')) { loadLive(); renderEvents(); } }, 60 * 1000);
}

// ---------- events ----------
function renderEvents() {
  const box = info.root?.querySelector('#info-events');
  if (!box) return;
  const now = Date.now();
  const loc = here();
  const list = eventsList().filter((e) => e.ends_at > now - 60 * 60000 && e.ends_at < now + 7 * 86400000).sort((a, b) => a.ends_at - b.ends_at);
  const soon = list.filter((e) => e.ends_at <= now + 2 * 3600000);
  const later = list.filter((e) => e.ends_at > now + 2 * 3600000);
  const lift = eventNow();
  const card = (e) => {
    const ended = e.ends_at <= now;
    const dist = loc ? kmApart(loc, e) : null;
    const del = isOwnerPhone() ? `<button type="button" class="ghost small" data-del="${esc(e.id)}">Delete</button>` : '';
    return `<div class="ev-card ${ended ? 'out' : e.ends_at <= now + 2 * 3600000 ? 'soon' : ''}">
      <div class="ev-main"><b>${esc(e.name)}</b>
        <div class="note">${esc(e.venue_name)}${dist != null ? ` · ${dist < 1 ? 'under 1' : Math.round(dist)} km from you` : ''}</div>
        <div class="ev-when">${ended ? `Ended ${hm(e.ends_at)}: crowd leaving now` : `${e.ends_at > now + 2 * 3600000 ? `${dayLabel(e.ends_at)} · ` : ''}${e.starts_at ? `${hm(e.starts_at)} to ` : 'ends '}~${hm(e.ends_at)}`}</div>
      </div>${del}</div>`;
  };
  box.innerHTML = `
    ${soon.length ? `<div class="band-head">Ending soon</div>${soon.map(card).join('')}` : '<p class="note">Nothing letting out in the next 2 hours.</p>'}
    ${later.length ? `<div class="band-head">Coming up</div>${later.map(card).join('')}` : ''}
    <p class="note">${lift.n ? `Around events, fares have run <b>${signed(lift.lift)}</b> vs normal (${lift.n} trip${lift.n === 1 ? '' : 's'}).` : 'No trips around events yet.'} Trips within about 1.5 km of a venue, from 30 min before an event ends to 90 min after, are kept out of the normal estimates, so a busy event night doesn't make that area look busy every night.</p>`;
  for (const b of box.querySelectorAll('[data-del]')) {
    let armed = false;
    b.addEventListener('click', async () => {
      if (!armed) { armed = true; b.textContent = 'Tap again'; setTimeout(() => { armed = false; b.textContent = 'Delete'; }, 4000); return; }
      try { await deleteEvent(b.dataset.del); } catch (e) { b.textContent = e.message; }
    });
  }
}

function buildEventForm() {
  const box = info.root.querySelector('#info-event-add');
  if (!isOwnerPhone()) { box.innerHTML = ''; return; }
  const today = new Date();
  const iso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  box.innerHTML = `
    <details class="ev-add"><summary>Add an event</summary>
      <div class="stack">
        <div class="field"><label for="ev-name">What</label><input id="ev-name" type="text" maxlength="60" placeholder="e.g. Coldplay concert"></div>
        <div class="field"><label for="ev-venue">Where</label><select id="ev-venue"></select></div>
        <div class="field"><label for="ev-date">Date</label><input id="ev-date" type="date" value="${iso}"></div>
        <div class="row2">
          <div class="field"><label for="ev-start">Starts (optional)</label><input id="ev-start" type="time"></div>
          <div class="field"><label for="ev-end">Ends (about)</label><input id="ev-end" type="time" value="22:30"></div>
        </div>
        <p class="note">The end time matters most: that's when the crowd comes out. Ending after midnight? Use the start date; it's worked out.</p>
        <button type="button" class="primary" id="ev-save">Add event</button>
        <p class="msg" id="ev-msg" role="status"></p>
      </div>
    </details>`;
  const fillVenues = () => {
    const sel = box.querySelector('#ev-venue');
    const cur = sel.value;
    sel.innerHTML = venuesList().map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('');
    if (cur) sel.value = cur;
  };
  fillVenues();
  onEventsChange(fillVenues);
  box.querySelector('details').addEventListener('toggle', () => { loadEvents(true).then(fillVenues); });
  box.querySelector('#ev-save').addEventListener('click', async () => {
    const msg = box.querySelector('#ev-msg');
    const name = box.querySelector('#ev-name').value.trim();
    const date = box.querySelector('#ev-date').value;
    const start = box.querySelector('#ev-start').value;
    const end = box.querySelector('#ev-end').value;
    if (!name || !date || !end) { msg.textContent = 'Add what it is, the date and roughly when it ends.'; msg.classList.add('err'); return; }
    const startsAt = start ? new Date(`${date}T${start}`).getTime() : null;
    let endsAt = new Date(`${date}T${end}`).getTime();
    if (startsAt && endsAt <= startsAt) endsAt += 86400000; // ends after midnight
    if (!startsAt && end < '06:00') endsAt += 86400000;
    try {
      await addEvent({ name, venue: box.querySelector('#ev-venue').value, starts_at: startsAt, ends_at: endsAt });
      msg.classList.remove('err');
      msg.textContent = `Added: ${name}, ends ~${hm(endsAt)} ${dayLabel(endsAt).toLowerCase()}.`;
      box.querySelector('#ev-name').value = '';
    } catch (e) { msg.textContent = e.message; msg.classList.add('err'); }
  });
}

// ---------- live: airport taxis, from JB, LTA ----------
async function loadLive() {
  if (Date.now() - info.liveAt < LIVE_REFRESH) return;
  info.liveAt = Date.now();
  try {
    const res = await fetch('/api/info');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Couldn’t get live info.');
    info.live = body;
    info.liveErr = '';
  } catch (e) {
    info.liveErr = navigator.onLine ? e.message : 'Offline: live info shows when you’re connected.';
    info.liveAt = Date.now() - LIVE_REFRESH + 30 * 1000;
  }
  renderLive();
}

function renderLive() {
  const r = info.root;
  if (!r) return;
  const L = info.live || {};
  const q = queueNow();
  const taxis = L.taxis;
  r.querySelector('#info-airport').innerHTML = `
    <div class="tiles">
      <div class="tile"><div class="v">${taxis && Number.isFinite(taxis.changi) ? taxis.changi : '—'}</div><div class="k">street taxis free at Changi${taxis ? ` · ${hm(taxis.at)}` : ''}</div></div>
      <div class="tile"><div class="v">${q && q.cars != null ? Math.round(q.cars) : '—'}</div><div class="k">cars ahead in the Grab queue, around this hour${q ? ` (${q.n} reading${q.n === 1 ? '' : 's'})` : ''}</div></div>
    </div>
    <p class="note">Taxis: available street taxis in the airport zone, from LTA (not Grab cars, but a fair sign of how crowded the airport rank is). Queue: from drivers' readings on Radar at the airport.${!L.taxis && info.liveErr ? ` ${esc(info.liveErr)}` : ''}</p>`;
  renderJb();
  const ltaText = L.lta && L.lta.ready ? 'Loading…'
    : isOwner() || isOwnerPhone() ? 'Needs the LTA DataMall key (free) to switch on.' : 'Coming soon.';
  r.querySelector('#info-incidents').innerHTML = `<p class="note">${ltaText}${L.lta && L.lta.ready ? '' : ' Accidents, breakdowns, roadworks and heavy traffic, nearest to you first.'}</p>`;
  r.querySelector('#info-travel').innerHTML = `<p class="note">${ltaText}${L.lta && L.lta.ready ? '' : ' e.g. "CTE to the city: 12 min".'}</p>`;
}

// People coming in from JB by train or bus often take a Grab from where they're dropped off.
// Published timetables (jb.js), worked out against the clock.
function renderJb() {
  const box = info.root?.querySelector('#info-jb');
  if (!box) return;
  const now = new Date();
  const ktm = nextTimes(KTM_ARRIVALS, now);
  const cw5 = nextTimes(CW5_FROM_WOODLANDS, now);
  const bus = (code, drop) => {
    const b = busNow(code, now);
    return `<div class="ev-card"><div class="ev-main"><b>Causeway Link ${code} → ${esc(drop)}</b>
      <div class="ev-when">${b.running ? `Running ${b.every}` : 'Not running now'}</div>
      <div class="note">${esc(b.hours)}. Arrival depends on the checkpoint queues.</div></div></div>`;
  };
  box.innerHTML = `
    <div class="ev-card"><div class="ev-main"><b>KTM Shuttle Tebrau → Woodlands Train Checkpoint</b>
      <div class="ev-when">${ktm.done ? `No more trains today. First tomorrow arrives ${ktm.first}` : `Next trains arrive ${ktm.next.join(', ')}`}</div>
      <div class="note">Arrival at Woodlands (5 min from JB Sentral), then Singapore immigration. ${KTM_ARRIVALS.length} a day, last ${ktm.last}.</div></div></div>
    ${bus('CW1', 'Kranji MRT')}
    ${bus('CW2', 'Queen Street Bus Terminal')}
    <div class="ev-card"><div class="ev-main"><b>Causeway Link CW5 → Newton Circus</b>
      <div class="ev-when">${cw5.done ? `Done for today. First tomorrow leaves Woodlands ${cw5.first}` : `Next leave Woodlands Checkpoint ${cw5.next.join(', ')}`}</div>
      <div class="note">Drops off at the Newton Food Centre car park. ${esc(busNow('CW5', now).hours)}.</div></div></div>
    <p class="note">Published timetables, not live: KTMB (effective 1 Jan 2026); bus hours from Land Transport Guru (2026), as Causeway Link's own sheet is from April 2023. Buses run to traffic. The KTM shuttle is due to stop after the RTS Link opens (reported for early 2027).</p>`;
}

// Old jobs from before Radar (the slider) that still need a fare.
export function renderOldJobs(n) {
  const box = info.root?.querySelector('#info-old');
  if (!box) return;
  box.innerHTML = n ? `<div class="band-latest">${n} older job${n === 1 ? '' : 's'} still waiting for a fare. <a href="#reconcile">Finish them</a></div>` : '';
}
