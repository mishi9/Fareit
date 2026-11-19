// Info tab: what's going on around Singapore that matters for driving. Events (owner-added),
// the airport (taxis waiting, queue readings), arrivals from JB, and, once the LTA DataMall key
// is set up, road incidents and expressway travel times. Display only: nothing here changes the
// estimates, except that trips around an event are kept apart from normal (formula.js).
import { eventsList, venuesList, loadEvents, addEvent, deleteEvent, onEventsChange } from './events.js';
import { here } from './where.js';
import { isOwner, isOwnerPhone } from './access.js';
import { eventNow } from './lab.js';
import { queueWaitNow, waitHtml, updatedText } from './queue.js';
import { jbRowsHtml } from './jb.js';
import { boldPlaces, unstamp, mrtStretch } from './glance.js';
import { FERRY_TERMINALS, ferryRowsHtml } from './ferries.js';
import { loadRain, rainData, rainInfoHtml } from './rain.js';

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
    <div id="info-train"></div>
    <section class="stack"><h2>Road incidents</h2><div id="info-incidents" class="stack"></div></section>
    <section class="stack"><h2>Expressway travel times</h2><div id="info-travel" class="stack"></div></section>
    <section class="stack"><h2>Events</h2><div id="info-events" class="stack"></div><div id="info-event-add"></div></section>
    <section class="stack"><h2>Rain</h2><div id="info-rain" class="stack"></div></section>
    <section class="stack"><h2>From JB</h2><div id="info-jb" class="stack"></div></section>
    <section class="stack"><h2>Ferries</h2><div id="info-ferries" class="stack"></div></section>
    <section class="stack"><h2>Airport</h2><div id="info-airport" class="stack"></div></section>`;
  onEventsChange(() => renderEvents());
  buildEventForm();
}

export function showInfo() {
  if (!info.root) return;
  loadEvents();
  renderEvents();
  renderLive();
  loadLive();
  const rain = () => { const box = info.root.querySelector('#info-rain'); if (box) box.innerHTML = rainInfoHtml(rainData(), here()); };
  rain();
  loadRain(rain);
  clearInterval(info.timer);
  // every 2 minutes: as often as LTA's own feeds change (the server keeps one shared copy)
  info.timer = setInterval(() => { if (!info.root.closest('[hidden]')) { loadLive(); renderEvents(); loadRain(rain); } }, 2 * 60 * 1000);
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
        <div class="note"><b>${esc(e.venue_name)}</b>${dist != null ? ` · ${dist < 1 ? '<1' : Math.round(dist)} km` : ''}</div>
        <div class="ev-when">${ended ? `Ended ${hm(e.ends_at)} · crowd out now` : `${e.ends_at > now + 2 * 3600000 ? `${dayLabel(e.ends_at)} · ` : ''}ends ~${hm(e.ends_at)}`}</div>
      </div>${del}</div>`;
  };
  // Only what's next: everything ending soon, then the next two (the owner sees all, to manage them).
  const next = isOwnerPhone() ? later : later.slice(0, 2);
  box.innerHTML = `
    ${soon.length ? `<div class="band-head">Ending soon</div>${soon.map(card).join('')}` : '<p class="note">Nothing ending in the next 2 h.</p>'}
    ${next.length ? `<div class="band-head">Next up</div>${next.map(card).join('')}` : ''}
    ${lift.n ? `<p class="note">After events, fares ran <b>${signed(lift.lift)}</b> (${lift.n} trip${lift.n === 1 ? '' : 's'}).</p>` : ''}`;
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
  box.innerHTML = '<button type="button" class="ghost wide" id="ev-open">+ Add event</button>';
  // The form is a card over the page, like Got a job.
  const sheet = document.createElement('div');
  sheet.id = 'event-sheet';
  sheet.className = 'sheet';
  sheet.hidden = true;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Add event');
  sheet.innerHTML = `
    <div class="sheet-head"><div class="sheet-title">Add event</div><button type="button" class="ghost small" id="ev-close">Close</button></div>
    <div class="sheet-body stack">
      <div class="field"><label for="ev-name">What</label><input id="ev-name" type="text" maxlength="60" placeholder="e.g. Coldplay concert"></div>
      <div class="field"><label for="ev-venue">Where</label><select id="ev-venue"></select></div>
      <div class="field"><label for="ev-date">Date</label><input id="ev-date" type="date"></div>
      <div class="row2">
        <div class="field"><label for="ev-start">Starts (optional)</label><input id="ev-start" type="time"></div>
        <div class="field"><label for="ev-end">Ends (about)</label><input id="ev-end" type="time" value="22:30"></div>
      </div>
      <p class="note">The end time matters most: that's when the crowd comes out. Past midnight? Keep the start date.</p>
      <button type="button" class="primary wide" id="ev-save">Add event</button>
      <p class="msg" id="ev-msg" role="status"></p>
    </div>`;
  document.body.append(sheet);
  const $s = (q) => sheet.querySelector(q);
  const fillVenues = () => {
    const sel = $s('#ev-venue');
    const cur = sel.value;
    sel.innerHTML = venuesList().map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('');
    if (cur) sel.value = cur;
  };
  const open = () => {
    const t = new Date();
    $s('#ev-date').value = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
    $s('#ev-msg').textContent = '';
    sheet.hidden = false;
    document.body.classList.add('sheet-open');
    loadEvents(true).then(fillVenues);
    fillVenues();
  };
  const close = () => { sheet.hidden = true; document.body.classList.remove('sheet-open'); };
  box.querySelector('#ev-open').addEventListener('click', open);
  $s('#ev-close').addEventListener('click', close);
  onEventsChange(fillVenues);
  $s('#ev-save').addEventListener('click', async () => {
    const msg = $s('#ev-msg');
    const name = $s('#ev-name').value.trim();
    const date = $s('#ev-date').value;
    const start = $s('#ev-start').value;
    const end = $s('#ev-end').value;
    if (!name || !date || !end) { msg.textContent = 'Add what it is, the date and roughly when it ends.'; msg.classList.add('err'); return; }
    const startsAt = start ? new Date(`${date}T${start}`).getTime() : null;
    let endsAt = new Date(`${date}T${end}`).getTime();
    if (startsAt && endsAt <= startsAt) endsAt += 86400000; // ends after midnight
    if (!startsAt && end < '06:00') endsAt += 86400000;
    const btn = $s('#ev-save');
    btn.disabled = true;
    try {
      await addEvent({ name, venue: $s('#ev-venue').value, starts_at: startsAt, ends_at: endsAt });
      $s('#ev-name').value = '';
      $s('#ev-start').value = '';
      close();
      renderEvents();
    } catch (e) { msg.textContent = e.message; msg.classList.add('err'); }
    btn.disabled = false;
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
  const taxis = L.taxis;
  r.querySelector('#info-airport').innerHTML = `
    <div class="band-head">Grab queue</div>
    ${waitHtml(queueWaitNow())}
    <div class="band-head">Taxis waiting at Changi</div>
    <div class="q-wait"><div class="q-wait-min">${taxis && Number.isFinite(taxis.changi) ? taxis.changi : '—'}</div>
      <div class="note">street taxis free${taxis ? ` · updated ${updatedText(taxis.at)}` : info.liveErr ? ` · ${esc(info.liveErr)}` : ''}</div></div>`;
  renderJb();
  renderFerries();
  renderLta(L.lta || {});
}

// ---------- LTA DataMall: MRT disruptions, road incidents, floods, expressway times ----------
const INCIDENT_ORDER = ['Accident', 'Road Block', 'Fire', 'Vehicle breakdown', 'Heavy Traffic', 'Obstacle', 'Unattended Vehicle', 'Diversion', 'Weather', 'Reverse Flow', 'Plant Failure', 'Miscellaneous', 'Roadwork'];
function renderLta(lta) {
  const r = info.root;
  const inc = r.querySelector('#info-incidents');
  const trv = r.querySelector('#info-travel');
  const trn = r.querySelector('#info-train');
  if (!lta.ready) {
    const t = isOwner() || isOwnerPhone() ? 'Needs the LTA DataMall key to switch on.' : 'Coming soon.';
    inc.innerHTML = `<p class="note">${t}</p>`;
    trv.innerHTML = `<p class="note">${t}</p>`;
    trn.innerHTML = '';
    return;
  }
  if (!lta.at) {
    const t = info.liveErr ? esc(info.liveErr) : 'Loading…';
    inc.innerHTML = `<p class="note">${t}</p>`;
    trv.innerHTML = `<p class="note">${t}</p>`;
    return;
  }
  const loc = here();
  const upd = `Last updated ${updatedText(lta.at)}.`;
  // MRT: only when something's wrong
  const tr = lta.train;
  const st = tr && tr.disrupted ? mrtStretch(tr.messages[0] || '') : null;
  trn.innerHTML = tr && tr.disrupted ? `<div class="alert-card ${tr.major ? 'bad' : ''}"><b>${esc([...new Set(tr.lines.map((x) => x.line))].join(', ') || 'MRT')} ${tr.major ? 'down' : 'delays'}${st ? `: ${esc(st.from)} – ${esc(st.to)}` : ''}</b>
    ${tr.messages.slice(0, 1).map((m) => `<div class="note">${boldPlaces(unstamp(m).replace(/^[A-Z]{2,4}\s*[-–]\s*/, ''))}</div>`).join('')}</div>` : '';
  // Floods and incidents, nearest first
  const dist = (p) => (loc && p.lat && p.lng ? kmApart(loc, p) : null);
  const floods = (lta.floods || []).map((f) => ({ ...f, d: dist(f) })).sort((a, b) => (a.d ?? 1e9) - (b.d ?? 1e9));
  const incidents = (lta.incidents || []).map((x) => ({ ...x, d: dist(x) }))
    .sort((a, b) => (loc ? (a.d ?? 1e9) - (b.d ?? 1e9) : INCIDENT_ORDER.indexOf(a.type) - INCIDENT_ORDER.indexOf(b.type)));
  const main = incidents.filter((x) => x.type !== 'Roadwork');
  const km = (d) => (d == null ? '' : ` · ${d < 1 ? '<1' : Math.round(d)} km`);
  const row = (x) => `<div class="inc-row"><div class="note"><span class="inc-type t-${esc(x.type.toLowerCase().replace(/[^a-z]/g, ''))}">${esc(x.type)}</span>${km(x.d)}</div>
    <div>${boldPlaces(unstamp(x.msg).replace(new RegExp(`^${x.type}\\s+`, 'i'), ''))}</div></div>`;
  // Everything that matters to a driver, no tapping to see more; roadworks left out.
  const shown = main.slice(0, 8);
  inc.innerHTML = `
    ${floods.map((f) => `<div class="alert-card bad"><div><b>Flash flood</b>${km(f.d)}</div><div>${boldPlaces(unstamp(f.desc))}</div></div>`).join('')}
    ${shown.length ? shown.map(row).join('') : '<p class="note">No accidents or breakdowns now.</p>'}
    ${main.length > 8 ? `<p class="note">+${main.length - 8} further away.</p>` : ''}
    <p class="note">LTA · ${upd.replace(/^Last updated /, 'updated ').replace(/\.$/, '')}</p>`;
  // Expressway times: one row per expressway, both directions
  const by = new Map();
  for (const t of lta.travel || []) { if (!by.has(t.name)) by.set(t.name, []); by.get(t.name).push(t); }
  trv.innerHTML = by.size ? `${[...by.entries()].map(([name, dirs]) => `<div class="jb-row compact"><b>${esc(name)}</b>
      <span class="note">${dirs.map((d) => `to ${esc(titleCase(d.to))} <b>${d.min} min</b>`).join(' · ')}</span></div>`).join('')}
    <p class="note">Full length · LTA · ${upd.replace(/^Last updated /, 'updated ').replace(/\.$/, '')}</p>` : `<p class="note">No travel times now.</p>`;
}
const titleCase = (s) => String(s).toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Pie|Cte|Aye|Ecp|Bke|Kje|Kpe|Mce|Sle|Tpe|Nsc)\b/g, (m) => m.toUpperCase());

// People coming in from JB by train or bus often take a Grab from where they're dropped off.
// What's next on each route, with a best-estimate time they're out in Singapore (jb.js).
function renderJb() {
  const box = info.root?.querySelector('#info-jb');
  if (!box) return;
  box.innerHTML = `${jbRowsHtml(new Date())}
    <p class="note">~ = estimate (timetable + journey + immigration); later when checkpoints are busy.</p>`;
}

// Ferries from Batam and Bintan: the next few arrivals at each terminal, from the operators'
// published timetables (ferries.js).
function renderFerries() {
  const box = info.root?.querySelector('#info-ferries');
  if (!box) return;
  const now = new Date();
  box.innerHTML = `${FERRY_TERMINALS.map((t) => `<div class="band-head">Into <b>${esc(t.short)}</b></div>${ferryRowsHtml(t.id, now)}`).join('')}
    <p class="note">Published timetables, Singapore time; then immigration.</p>`;
}

// Old jobs from before Radar (the slider) that still need a fare.
export function renderOldJobs(n) {
  const box = info.root?.querySelector('#info-old');
  if (!box) return;
  box.innerHTML = n ? `<div class="band-latest">${n} old job${n === 1 ? '' : 's'} need a fare · <a href="#reconcile">Finish</a></div>` : '';
}
