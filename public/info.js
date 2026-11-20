// Info tab: what's going on around Singapore that matters for driving. Events (owner-added),
// the airport (taxis waiting, queue readings), arrivals from JB, and, once the LTA DataMall key
// is set up, road incidents and expressway travel times. Display only: nothing here changes the
// estimates, except that trips around an event are kept apart from normal (formula.js).
import { eventsList, venuesList, loadEvents, addEvent, deleteEvent, onEventsChange } from './events.js';
import { here } from './where.js';
import { isOwner, isOwnerPhone } from './access.js';
import { eventNow, surgingAreas } from './lab.js';
import { loadSurge } from './surge.js';
import { ERP_GROUPS, erpNow, roadErp, hhmm, shortWhere, ROAD_TOWNS, routeChoices, incidentsOn, pickedRoutes, setPicked } from './erp.js';
import { queueAppsNow, updatedText } from './queue.js';
import { jbRowsHtml, jbSummary } from './jb.js';
import { flightsSoon, renderFlights } from './flights.js';
import { boldPlaces, unstamp, mrtStretch } from './glance.js';
import { FERRY_TERMINALS, ferryRowsHtml, ferrySummary } from './ferries.js';
import { loadRain, rainData, rainInfoHtml, isWet, rainAt } from './rain.js';

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

// Below the top (MRT, My routes, Surging now) every section is folded to one line: its title and a
// short summary; tap to open.
const FOLD_KEY = 'agaration-info-open';
const foldsOpen = () => { try { return JSON.parse(localStorage.getItem(FOLD_KEY) || '[]'); } catch { return []; } };
const fold = (id, title, body) => `<details class="fold" data-fold="${id}"${foldsOpen().includes(id) ? ' open' : ''}><summary><span class="fold-title">${title}</span><span class="fold-sum" id="sum-${id}"></span><span class="fold-chev" aria-hidden="true"></span></summary><div class="fold-body stack">${body}</div></details>`;
const hideFold = (id, hide) => { const el = info.root && info.root.querySelector(`details.fold[data-fold="${id}"]`); if (el) el.hidden = hide; };
const summary = (id, html) => { const el = info.root && info.root.querySelector(`#sum-${id}`); if (el) el.innerHTML = html; };

export function buildInfo(root) {
  info.root = root;
  root.innerHTML = `
    <div id="info-old"></div>
    <div id="info-train"></div>
    <section class="stack"><h2>My routes</h2><div id="info-routes" class="stack"></div></section>
    <section class="stack"><h2>Surging now</h2><div id="info-surging" class="stack"></div></section>
    ${fold('incidents', 'Road incidents', '<div id="info-incidents" class="stack"></div>')}
    ${fold('events', 'Events', '<div id="info-events" class="stack"></div><div id="info-event-add"></div>')}
    ${fold('rain', 'Rain', '<div id="info-rain" class="stack"></div>')}
    ${fold('airport', 'Airport', '<div id="info-airport" class="stack"></div>')}
    ${fold('jb', 'From JB', '<div id="info-jb" class="stack"></div>')}
    ${fold('ferries', 'Ferries', '<div id="info-ferries" class="stack"></div>')}
    ${fold('travel', 'All expressways', '<div id="info-travel" class="stack"></div>')}`;
  // Folded sections remember being open (on this phone).
  for (const d of root.querySelectorAll('details.fold')) d.addEventListener('toggle', () => {
    const open = new Set(foldsOpen());
    if (d.open) open.add(d.dataset.fold); else open.delete(d.dataset.fold);
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...open])); } catch { /* private mode */ }
  });
  onEventsChange(() => renderEvents());
  buildEventForm();
}

export function showInfo() {
  if (!info.root) return;
  loadEvents();
  renderEvents();
  renderLive();
  loadLive();
  const rain = () => {
    const box = info.root.querySelector('#info-rain');
    const d = rainData();
    if (box) box.innerHTML = rainInfoHtml(d, here());
    const near = d && d.at ? rainAt(here(), d) : null;
    const wetAreas = d && d.areas ? d.areas.filter((a) => isWet(a.f)).length : 0;
    summary('rain', !d || !d.at ? '' : near ? `<b class="sum-rain">${near.kind === 'now' ? 'Raining near you' : 'Rain expected here'}</b>` : wetAreas ? `${wetAreas} area${wetAreas === 1 ? '' : 's'} forecast rain` : 'Dry');
    renderRoutes();
  };
  rain();
  loadRain(rain);
  renderSurging();
  loadSurge(renderSurging, true);
  clearInterval(info.timer);
  // every 2 minutes: as often as LTA's own feeds change (the server keeps one shared copy)
  info.timer = setInterval(() => { if (!info.root.closest('[hidden]')) { loadLive(); renderEvents(); loadRain(rain); loadSurge(renderSurging, true); } }, 2 * 60 * 1000);
}

// ---------- my routes ----------
// Tap the roads you're on (from LTA's travel times, e.g. PIE to Tuas); for each: travel time, ERP
// now and next, accidents on it in that direction, and rain along it. Picks stay on this phone.
// Picker label: PIE (TUAS), PIE (CHANGI), BKE (WOODLANDS), CTE (AYE/MCE), CITY.
const chipLabel = (r) => (r.key === 'CITY' ? 'CITY' : `${r.name} (${String(r.to).trim().split(/\s+/)[0].toUpperCase()})`);
const arrow = (r) => (r.key === 'CITY' ? 'City · CBD / Orchard' : `${r.name} → ${titleCase(r.to)}`);
function renderRoutes() {
  const box = info.root && info.root.querySelector('#info-routes');
  if (!box) return;
  const lta = (info.live && info.live.lta) || {};
  const choices = routeChoices(lta.travel);
  const picked = pickedRoutes();
  const chips = `<div class="st-apps route-chips">${choices.map((r) => `<button type="button" class="${picked.includes(r.key) ? 'on' : ''}" data-route="${esc(r.key)}"><span class="box"></span>${esc(chipLabel(r))}</button>`).join('')}</div>`;
  const cards = choices.filter((r) => picked.includes(r.key)).map((r) => routeCard(r, lta)).join('');
  box.innerHTML = chips + (cards || `<p class="note">${choices.length > 1 ? 'Tap the roads you’re on: travel time, ERP, accidents and rain along each show here.' : 'Expressways show once LTA’s travel times load; ERP for the city is ready.'}</p>`);
  for (const b of box.querySelectorAll('[data-route]')) b.addEventListener('click', () => {
    const k = b.dataset.route;
    const cur = pickedRoutes();
    setPicked(cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]);
    renderRoutes();
  });
  for (const c of box.querySelectorAll('[data-open]')) c.addEventListener('click', () => {
    const k = c.dataset.open;
    if (openRoutes.has(k)) openRoutes.delete(k); else openRoutes.add(k);
    renderRoutes();
  });
}
// One line per road: name and time, then three short tags (ERP, accidents, rain). Tap for details.
const openRoutes = new Set();
function routeCard(r, lta) {
  const now = Date.now();
  const t = (lta.travel || []).find((x) => `${x.name}|${x.dir}` === r.key);
  const groups = ERP_GROUPS.filter((g) => g.road === r.key);
  const e = roadErp(groups, now);
  const m = (v) => `$${v % 1 ? v.toFixed(2) : v}`;
  const erpTag = !e ? '<span class="rt off">No ERP</span>'
    : e.free ? '<span class="rt off">No ERP today</span>'
    : e.now ? `<span class="rt erp">ERP ${e.now[0] === e.now[1] ? m(e.now[0]) : `${m(e.now[0])}–${m(e.now[1])}`} · till ${hhmm(e.until)}</span>`
    : e.from != null ? `<span class="rt off">ERP from ${hhmm(e.from)}</span>`
    : '<span class="rt off">ERP done today</span>';
  const inc = r.key === 'CITY' ? [] : incidentsOn(r, (lta.incidents || []).filter((x) => x.type !== 'Roadwork'));
  const kind = (x) => x.type.replace(/^Vehicle breakdown$/i, 'Breakdown').replace(/^Unattended Vehicle$/i, 'Stalled car');
  const incTag = r.key === 'CITY' ? '' : inc.length
    ? inc.slice(0, 2).map((x) => { const w = shortWhere(x.msg); return `<span class="rt bad">${esc(kind(x))}${w ? ` ${esc(w)}` : ''}</span>`; }).join('') + (inc.length > 2 ? `<span class="rt bad">+${inc.length - 2} more</span>` : '')
    : '<span class="rt off">Clear</span>';
  const rd = rainData() || {};
  const towns = ROAD_TOWNS[r.key === 'CITY' ? 'CITY' : r.name] || [];
  const areas = (rd.areas || []).filter((a) => towns.includes(a.name));
  const wetNow = areas.filter((a) => (rd.wet || []).some((g) => kmApart(a, g) <= 3)).map((a) => a.name);
  const fc = areas.filter((a) => isWet(a.f) && !wetNow.includes(a.name));
  const rainTag = wetNow.length ? `<span class="rt rain">Rain · ${esc(wetNow[0])}${wetNow.length > 1 ? ` +${wetNow.length - 1}` : ''}</span>` : fc.length ? `<span class="rt rain">Rain expected</span>` : '';
  const open = openRoutes.has(r.key);
  // Details, when tapped
  let more = '';
  if (open) {
    const lines = groups.map((g) => {
      const x = erpNow(g, now);
      const what = x.free ? 'none today' : x.now ? `${m(x.now)} now${x.next && x.next.amount ? `, ${m(x.next.amount)} at ${hhmm(x.next.at)}` : ''}` : x.next ? `${m(x.next.amount)} at ${hhmm(x.next.at)}` : 'done today';
      return `<div class="rd-line"><span>${esc(g.name.replace(/^(AYE|PIE|CTE|KPE|MCE) /, ''))}</span><b>${what}</b></div>`;
    });
    for (const x of inc) lines.push(`<div class="rd-line bad">${boldPlaces(unstamp(x.msg))}</div>`);
    if (wetNow.length) lines.push(`<div class="rd-line">Raining near ${wetNow.map(esc).join(', ')}</div>`);
    if (fc.length) lines.push(`<div class="rd-line">Forecast: ${fc.map((a) => `${esc(a.name)} (${esc(a.f)})`).join(', ')}</div>`);
    if (t && t.slow && t.slow.min >= 5 && t.slow.min < t.min) lines.push(`<div class="rd-line"><span>Slowest: ${esc(titleCase(t.slow.from))} → ${esc(titleCase(t.slow.to))}</span><b>${t.slow.min} min</b></div>`);
    more = `<div class="route-more">${lines.join('') || '<div class="rd-line">Nothing else to show.</div>'}</div>`;
  }
  return `<div class="route-card${open ? ' open' : ''}" data-open="${esc(r.key)}" role="button" tabindex="0">
    <div class="route-head"><b>${esc(arrow(r))}</b>${t ? `<span class="route-min">${t.min} min</span>` : ''}</div>
    <div class="route-tags">${erpTag}${incTag}${rainTag}<span class="route-chev">${open ? '▴' : '▾'}</span></div>${more}</div>`;
}

// ---------- surging now ----------
// Where drivers are reporting surge right now, with what a 10 km job from there would earn:
// enough to judge whether it's worth heading over, without a full price list.
const money2 = (n) => `S$${n.toFixed(2)}`;
function renderSurging() {
  const box = info.root && info.root.querySelector('#info-surging');
  if (!box) return;
  const list = surgingAreas(renderSurging);
  if (!list.length) { box.innerHTML = '<p class="note">Nowhere surging right now.</p>'; return; }
  box.innerHTML = list.map((a) => {
    const ago = a.latest ? Math.max(0, Math.round((Date.now() - a.latest) / 60000)) : null;
    const sub = a.airport ? `${a.jobs} airport jobs in the last hour` : `${a.drivers} drivers · ${ago < 1 ? 'now' : `${ago} min ago`}`;
    return `<div class="surging-row"><div><b>${esc(a.name || 'Nearby area')}</b>${a.km != null ? ` <span class="note">· ${a.km < 1 ? '<1' : a.km.toFixed(1)} km away</span>` : ''}<div class="note">${sub}</div></div>
      <div class="surging-price"><b>${money2(a.now)}</b><div class="note">10 km · ${signed(a.lift)}</div></div></div>`;
  }).join('') + '<p class="note">About what a 10 km job picked up there would earn now, after the app\u2019s cut (normal 10 km: ' + money2(list[0].normal) + ').</p>';
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
  const first = soon[0] || later[0];
  summary('events', first ? `${soon.length ? '<b class="sum-hot">' : ''}${esc(first.name)} · ${first.ends_at <= now ? 'out now' : `${first.ends_at > now + 2 * 3600000 ? `${dayLabel(first.ends_at)} ` : ''}~${hm(first.ends_at)}`}${soon.length ? '</b>' : ''}${list.length > 1 ? ` · +${list.length - 1}` : ''}` : 'None listed');
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
    ${queueHtml()}
    <div id="info-flights"></div>
    <div class="band-head">Taxis waiting at Changi</div>
    <div class="q-wait"><div class="q-wait-min">${taxis && Number.isFinite(taxis.changi) ? taxis.changi : '—'}</div>
      <div class="note">street taxis free${taxis ? ` · updated ${updatedText(taxis.at)}` : info.liveErr ? ` · ${esc(info.liveErr)}` : ''}</div></div>`;
  renderAirportLine(taxis);
  renderJb();
  renderFerries();
  renderLta(L.lta || {});
}

// Each app's queue: what its queue screen says (from drivers' latest reading) and the real wait
// drivers got when the job came (Got a job).
function queueHtml() {
  const qa = queueAppsNow();
  const row = (app, name) => {
    const x = qa[app];
    const says = x.est != null || x.cars != null
      ? `<b>${x.est != null ? `~${x.est} min` : '—'}</b>${app === 'grab' && x.cars != null ? ` · ${x.cars} cars` : ''} <span class="note">· ${updatedText(x.at)}</span>`
      : '<span class="note">no reading in the last 45 min</span>';
    const real = x.actual != null
      ? `<b>~${x.actual} min</b> <span class="note">· ${x.actualAt ? `job ${updatedText(x.actualAt)}` : `usual for this hour (${x.actualN})`}</span>`
      : '<span class="note">no jobs recorded yet</span>';
    return `<div class="q-app"><div class="q-app-name">${name}</div>
      <div class="q-line"><span>${name} says</span><span>${says}</span></div>
      <div class="q-line"><span>Real wait</span><span>${real}</span></div></div>`;
  };
  return `<div class="band-head">Queue</div>${row('grab', 'Grab')}${row('tada', 'TADA')}`;
}

// Airport line: flights still in the air that land within 45 minutes (landed ones not counted).
function renderAirportLine(taxis) {
  const again = () => renderAirportLine(taxis);
  const n = flightsSoon(again);
  const fl = info.root && info.root.querySelector('#info-flights');
  if (fl) renderFlights(fl, () => {});
  summary('airport', n != null ? `<b class="${n >= 10 ? 'sum-hot' : ''}">${n} flight${n === 1 ? '' : 's'} landing in the next 45 min</b>` : taxis && Number.isFinite(taxis.changi) ? `${taxis.changi} taxis waiting` : '');
}

// ---------- LTA DataMall: MRT disruptions, road incidents, floods, expressway times ----------
const INCIDENT_ORDER = ['Accident', 'Road Block', 'Fire', 'Vehicle breakdown', 'Heavy Traffic', 'Obstacle', 'Unattended Vehicle', 'Diversion', 'Weather', 'Reverse Flow', 'Plant Failure', 'Miscellaneous', 'Roadwork'];
function renderLta(lta) {
  renderRoutes();
  const r = info.root;
  const inc = r.querySelector('#info-incidents');
  const trv = r.querySelector('#info-travel');
  const trn = r.querySelector('#info-train');
  if (!lta.ready) {
    const t = isOwner() || isOwnerPhone() ? 'Needs the LTA DataMall key to switch on.' : 'Coming soon.';
    inc.innerHTML = `<p class="note">${t}</p>`;
    trv.innerHTML = `<p class="note">${t}</p>`;
    trn.innerHTML = '';
    summary('incidents', 'Coming soon');
    return;
  }
  if (!lta.at) {
    const t = info.liveErr ? esc(info.liveErr) : 'Loading…';
    inc.innerHTML = `<p class="note">${t}</p>`;
    trv.innerHTML = `<p class="note">${t}</p>`;
    summary('incidents', info.liveErr ? 'Not available' : 'Loading…');
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
  // The nearest within 5 km, with where ("Accident · PIE after Clementi Ave 6 · 2 km").
  const kmTxt = (d) => `${d < 1 ? '<1' : Math.round(d)} km`;
  const nearFlood = floods.find((f) => f.d != null && f.d <= 5);
  const near = main.find((x) => x.d != null && x.d <= 5);
  const road = (m) => { const r = /\bon\s+(.+?)\s+(?:\(towards|after|before|at|near|from)\b/i.exec(unstamp(m)); return r ? r[1] : ''; };
  const floodFirst = nearFlood && (!near || nearFlood.d <= near.d);
  summary('incidents', floodFirst ? `<b class="sum-bad">Flash flood · ${kmTxt(nearFlood.d)}</b>`
    : near ? `<b class="sum-bad">${esc(near.type.replace(/^Vehicle breakdown$/i, 'Breakdown'))} · ${kmTxt(near.d)}</b> · ${esc([road(near.msg), shortWhere(near.msg)].filter(Boolean).join(' '))}`
    : loc ? 'None within 5 km' : main.length ? `${main.length} on the roads` : 'None now');
  inc.innerHTML = `
    ${floods.map((f) => `<div class="alert-card bad"><div><b>Flash flood</b>${km(f.d)}</div><div>${boldPlaces(unstamp(f.desc))}</div></div>`).join('')}
    ${shown.length ? shown.map(row).join('') : '<p class="note">No accidents or breakdowns now.</p>'}
    ${main.length > 8 ? `<p class="note">+${main.length - 8} further away.</p>` : ''}
    <p class="note">LTA · ${upd.replace(/^Last updated /, 'updated ').replace(/\.$/, '')}</p>`;
  // Expressway times: one row per expressway, both directions
  const by = new Map();
  for (const t of lta.travel || []) { if (!by.has(t.name)) by.set(t.name, []); by.get(t.name).push(t); }
  summary('travel', by.size ? `${by.size} expressways, both ways` : '');
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
  // Only when something's due within 3 hours; otherwise the section is hidden.
  const js = jbSummary(new Date());
  hideFold('jb', !js);
  summary('jb', js ? esc(js) : '');
  box.innerHTML = `${jbRowsHtml(new Date())}
    <p class="note">~ = estimate (timetable + journey + immigration); later when checkpoints are busy.</p>`;
}

// Ferries from Batam and Bintan: the next few arrivals at each terminal, from the operators'
// published timetables (ferries.js).
function renderFerries() {
  const box = info.root?.querySelector('#info-ferries');
  if (!box) return;
  const now = new Date();
  const fs = ferrySummary(new Date());
  hideFold('ferries', !fs);
  summary('ferries', fs ? esc(fs) : '');
  box.innerHTML = `${FERRY_TERMINALS.map((t) => `<div class="band-head">Into <b>${esc(t.short)}</b></div>${ferryRowsHtml(t.id, now)}`).join('')}
    <p class="note">Published timetables, Singapore time; then immigration.</p>`;
}

// Old jobs from before Radar (the slider) that still need a fare.
export function renderOldJobs(n) {
  const box = info.root?.querySelector('#info-old');
  if (!box) return;
  box.innerHTML = n ? `<div class="band-latest">${n} old job${n === 1 ? '' : 's'} need a fare · <a href="#reconcile">Finish</a></div>` : '';
}
