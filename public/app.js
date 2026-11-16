import { BANDS, ZONES, DEFAULT_SETTINGS, mergeSettings, predict, bandFor, accuracy, isTrainable, dropAreaTrial } from './model.js';
import { findArea, isPostal, classifyZone } from './places.js';
import * as db from './db.js';
import { pushJobs, pullJobs } from './sync.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  trips: [],
  settings: mergeSettings(),
  apiKey: '',
  band: null,
  zone: null,
  currentId: null,
  currentAt: 0,
  resetTimer: null,
  view: 'window',
  form: null,
  wakeLock: null,
  loc: null, // last known position of this phone, roughly where the pickup will be
  shared: [], // local copy of the shared pool (other drivers' anonymous jobs)
  device: '', // random id so this phone can correct its own pool rows; not linked to anyone
  syncing: null,
  lastSync: null,
  syncError: '',
};

// Your own jobs plus everyone else's from the pool (your own rows in the pool are skipped).
function trainingSet() {
  const own = new Set(state.trips.map((t) => t.id));
  return state.shared.length ? [...state.trips, ...state.shared.filter((r) => !own.has(r.id))] : state.trips;
}

// ---------- small helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
const dollars = (n) => `$${Math.round(n)}`;
const fare = (n) => `S$${Number(n).toFixed(2)}`;
const zoneLabel = (id) => ZONES.find((z) => z.id === id)?.label ?? '—';
const bandLabel = (id) => (BANDS.find((b) => b.id === id)?.label ?? '—') + ' km';
const when = (ts) => new Date(ts).toLocaleString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const placeLabel = (p, text) => (p && p.label) || text || '—';
const clock = (ts) => new Date(ts).toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', hour12: false });
const decisionLabel = (d) => (d === 'took' ? 'Took it' : d === 'cancelled' ? 'Cancelled' : 'No decision');
const DAY_NAMES = { weekday: 'weekday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
function toLocalInput(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function button(html, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.innerHTML = html;
  b.addEventListener('click', onClick);
  return b;
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

async function api(path, body) {
  const headers = state.apiKey ? { 'x-fareit-key': state.apiKey } : {};
  const init = { headers };
  if (body !== undefined) {
    init.method = 'POST';
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- status ----------
async function checkStatus() {
  const chip = $('#status');
  if (!navigator.onLine) {
    chip.textContent = 'Offline · saving on phone';
    chip.className = 'chip warn';
    return;
  }
  try {
    const s = await api('/api/status');
    if (s.keyRequired && !s.authorized) { chip.textContent = 'Access key needed'; chip.className = 'chip warn'; }
    else if (!s.map) { chip.textContent = 'Map not set up'; chip.className = 'chip warn'; }
    else { chip.textContent = 'OneMap ready'; chip.className = 'chip ok'; }
  } catch {
    chip.textContent = 'Server unreachable';
    chip.className = 'chip warn';
  }
}

function renderBadge() {
  const n = state.trips.filter((t) => t.status === 'pending').length;
  const b = $('#badge');
  b.hidden = n === 0;
  b.textContent = String(n);
}

// ---------- views ----------
function show(view) {
  if (!['window', 'reconcile', 'trips', 'settings'].includes(view)) view = 'window';
  state.view = view;
  for (const v of $$('.view')) v.hidden = v.id !== `view-${view}`;
  for (const t of $$('.tabs button')) t.classList.toggle('on', t.dataset.view === view);
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  if (view === 'reconcile') { if (!state.form) renderReconList(); }
  if (view === 'trips') renderTrips();
  keepAwake();
}

// ---------- window: two taps -> verdict ----------
function buildWindow() {
  const bands = $('#bands');
  bands.innerHTML = '';
  for (const b of BANDS) {
    const el = button(esc(b.label), 'tap mono', () => pick('band', b.id));
    el.dataset.id = b.id;
    el.setAttribute('aria-label', `${b.label} kilometres`);
    bands.append(el);
  }
  const zones = $('#zones');
  zones.innerHTML = '';
  for (const z of ZONES) {
    const el = button(esc(z.short), 'tap', () => pick('zone', z.id));
    el.dataset.id = z.id;
    zones.append(el);
  }
  markDeadDrops();
  $('#verdict').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'clear') resetWindow();
    else recordDecision(b.dataset.act);
  });
  renderVerdict(null);
}

// The red dot marks your own dead drops (Settings), not a general rule.
function markDeadDrops() {
  for (const el of $$('#zones .tap')) {
    const z = ZONES.find((x) => x.id === el.dataset.id);
    const dead = state.settings.deadZones.includes(z.id);
    el.classList.toggle('dead', dead);
    el.setAttribute('aria-label', `${z.label}${dead ? ', a dead drop for you' : ''}`);
  }
}

function markSelection() {
  for (const el of $$('#bands .tap')) el.classList.toggle('sel', el.dataset.id === state.band);
  for (const el of $$('#zones .tap')) el.classList.toggle('sel', el.dataset.id === state.zone);
}

function pick(kind, id) {
  state[kind] = id;
  markSelection();
  clearTimeout(state.resetTimer);
  state.resetTimer = setTimeout(resetWindow, 30000);
  if (state.band && state.zone) decide();
  else renderVerdict(null);
}

function resetWindow() {
  clearTimeout(state.resetTimer);
  state.band = null;
  state.zone = null;
  state.currentId = null;
  markSelection();
  renderVerdict(null);
}

async function decide() {
  const now = Date.now();
  const loc = state.loc && now - state.loc.at < 10 * 60 * 1000 ? state.loc : null;
  const p = predict({ band: state.band, zone: state.zone, ts: now, loc }, trainingSet(), state.settings);
  renderVerdict(p);

  // A change within 15 seconds is a correction of the same job, not a new one.
  let trip = state.currentId && now - state.currentAt < 15000 ? state.trips.find((t) => t.id === state.currentId) : null;
  if (!trip) {
    trip = { id: uid(), ts: now, status: 'pending', source: 'window', rideType: 'standard' };
    state.trips.push(trip);
    state.currentId = trip.id;
    state.currentAt = now;
  }
  trip.band = state.band;
  trip.zone = state.zone;
  if (loc && !trip.tapLoc) trip.tapLoc = { lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy };
  trip.prediction = {
    net: p.net, lo: p.lo, hi: p.hi, perHour: p.perHour, verdict: p.verdict,
    km: p.km, tripMin: p.tripMin, returnMin: p.returnMin, stage: p.stage, basis: p.basis,
  };
  await db.putTrip(trip);
  renderBadge();
}

function renderVerdict(p) {
  const v = $('#verdict');
  if (!p) {
    v.className = 'verdict idle';
    const ask = state.band ? 'Now tap the drop area.' : state.zone ? 'Now tap the distance band.' : 'Tap the distance band and the drop area from the job card.';
    v.innerHTML = `<p>${ask}</p>`;
    return;
  }
  const why = [`${Math.round(p.tripMin)} min trip`];
  if (p.deadDrop && p.returnMin > 0) why.push(`+ about ${p.returnMin} min empty drive back (a dead drop for you)`);
  const stage = p.stage === 'seed'
    ? 'Fare-structure estimate. No reconciled jobs yet.'
    : `${p.stage === 'trained' ? 'Based on' : 'Learning from'} ${p.basis} job${p.basis === 1 ? '' : 's'}${p.shared ? ` (${p.shared} from other drivers)` : ''}, ${p.nearTime} within an hour of now on a ${DAY_NAMES[p.dayClass]}.`;
  v.className = `verdict ${p.verdict === 'TAKE' ? 'take' : 'skip'}`;
  v.innerHTML = `
    <div class="top-row"><span class="word">${p.verdict}</span><button type="button" class="clear" data-act="clear">Clear</button></div>
    <div class="nums">
      <span><span class="big">${dollars(p.net)}</span> <span class="rng">${dollars(p.lo)}–${dollars(p.hi)}</span></span>
      <span><span class="big">${dollars(p.perHour)}/hr</span> <span class="rng">line ${dollars(state.settings.targetPerHour)}</span></span>
    </div>
    <div class="why">${esc(why.join(' '))}. ${esc(stage)}</div>
    <div class="decide">
      <button type="button" data-act="took">Took it</button>
      <button type="button" data-act="cancelled">Cancelled</button>
    </div>`;
}

// Records what you did and when. Taken or cancelled, the job stays in Reconcile so its fare
// can be added: a cancelled job whose fare you saw trains the model like any other.
async function recordDecision(decision) {
  const trip = state.trips.find((t) => t.id === state.currentId);
  if (!trip) return;
  const now = Date.now();
  trip.decision = decision;
  trip.decidedAt = now;
  trip.decideSeconds = Math.round((now - trip.ts) / 1000);
  resetWindow();
  toast(`${decisionLabel(decision)} at ${clock(now)}. Add the fare later in Reconcile.`);
  await db.putTrip(trip);
}

// ---------- reconcile ----------
function renderReconList() {
  const box = $('#recon-list');
  const pending = state.trips.filter((t) => t.status === 'pending').sort((a, b) => b.ts - a.ts);
  box.hidden = false;
  $('#recon-form').hidden = true;
  box.innerHTML = `
    <div class="head"><h2>To reconcile</h2><button type="button" class="primary small" id="add-trip">Add a trip</button></div>
    ${pending.length ? '' : '<p class="empty">Nothing waiting. Every job you tap on the Window tab lands here, taken or cancelled, so you can add its fare once you are parked.</p>'}`;
  $('#add-trip').addEventListener('click', () => openForm(null));
  for (const t of pending) {
    const p = t.prediction;
    const card = document.createElement('div');
    card.className = 'card';
    const decided = t.decision ? `<span class="pill ${t.decision}">${decisionLabel(t.decision)} ${clock(t.decidedAt)}</span>` : '';
    card.innerHTML = `
      <div class="line1"><span class="when">${esc(when(t.ts))}</span><span class="acts">${decided}${p ? `<span class="pill ${p.verdict === 'TAKE' ? 'take' : 'skip'}">${p.verdict}</span>` : ''}</span></div>
      <div class="meta">${esc(bandLabel(t.band))} · ${esc(zoneLabel(t.zone))}${p ? ` · predicted ${dollars(p.net)}` : ''}</div>`;
    const acts = document.createElement('div');
    acts.className = 'acts';
    acts.append(
      button('Add fare', 'primary small', () => openForm(t)),
      button('No fare seen', 'ghost small', () => markNoFare(t)),
    );
    card.append(acts);
    box.append(card);
  }
}

// Keeps the job (time, band, area, decision) but it can't teach the fare without one.
async function markNoFare(t) {
  t.status = 'nofare';
  await db.putTrip(t);
  renderBadge();
  renderReconList();
  toast('Kept with its time and decision. Without a fare it can’t train the price.');
  syncNow();
}

function buildReconForm() {
  const zoneBox = $('#rf-zone');
  for (const z of ZONES) {
    const b = button(esc(z.short), '', () => { state.form.zone = z.id; markFormZone(); });
    b.dataset.v = z.id;
    zoneBox.append(b);
  }
  for (const b of $$('#rf-decision button')) {
    b.addEventListener('click', () => {
      state.form.decision = b.dataset.v;
      markFormDecision();
    });
  }
  for (const b of $$('#rf-pay button')) {
    b.addEventListener('click', () => {
      state.form.pay = state.form.pay === b.dataset.v ? null : b.dataset.v;
      for (const x of $$('#rf-pay button')) x.classList.toggle('sel', x.dataset.v === state.form.pay);
    });
  }
  wirePlace('rf-pickup', 'pickup');
  wirePlace('rf-drop', 'drop');
  $('#rf-back').addEventListener('click', () => { state.form = null; renderReconList(); });
  $('#recon-form').addEventListener('submit', saveRecon);
}

function markFormDecision() {
  for (const b of $$('#rf-decision button')) b.classList.toggle('sel', b.dataset.v === state.form.decision);
  $('#rf-fare-label').textContent = state.form.decision === 'cancelled' ? 'Fare shown when you cancelled (S$)' : 'Fare you were paid (S$)';
}

function markFormZone() {
  for (const b of $$('#rf-zone button')) b.classList.toggle('sel', b.dataset.v === state.form.zone);
  zoneHint();
}

function zoneHint() {
  const hint = $('#rf-zone-hint');
  const d = state.form && state.form.drop;
  if (!d || !(d.lat > 0) || !state.form.zone) { hint.textContent = ''; return; }
  const suggested = classifyZone(d.lat, d.lng);
  hint.textContent = suggested !== state.form.zone ? `On the map this drop-off sits in ${zoneLabel(suggested)}. Change it if you tapped the wrong area.` : '';
}

function openForm(trip) {
  state.form = {
    id: trip ? trip.id : null, pickup: trip?.pickup || null, drop: trip?.drop || null,
    zone: trip?.zone || null, pay: trip?.payment || null, decision: trip?.decision || 'took',
  };
  $('#recon-list').hidden = true;
  const f = $('#recon-form');
  f.hidden = false;
  $('#rf-title').textContent = trip ? 'Add the real fare' : 'Add a trip';
  $('#rf-sub').textContent = trip
    ? `${when(trip.ts)} · ${bandLabel(trip.band)} · ${zoneLabel(trip.zone)}${trip.prediction ? ` · predicted ${dollars(trip.prediction.net)}` : ''}`
    : 'A trip you didn’t tap in the window.';
  $('#rf-pickup').value = trip?.pickupText || '';
  $('#rf-pickup-hint').textContent = '';
  if (trip && !trip.pickupText && trip.tapLoc?.lat) prefillPickup(trip);
  $('#rf-drop').value = trip?.dropText || '';
  $('#rf-min').value = trip?.tripMin || '';
  $('#rf-fare').value = trip?.fare || '';
  $('#rf-when').value = toLocalInput(trip ? trip.ts : Date.now());
  markFormDecision();
  $('#rf-pickup-s').innerHTML = '';
  $('#rf-drop-s').innerHTML = '';
  for (const x of $$('#rf-pay button')) x.classList.toggle('sel', x.dataset.v === state.form.pay);
  markFormZone();
  msg('');
  $('#rf-save').disabled = false;
  if (!state.form.pickup) $('#rf-pickup').focus();
}

// The pickup starts as where Phone 2 was when you tapped. That's usually 1–5 km from the real
// pickup: close enough for the area, and you can type over it if the pickup was far off.
function prefillPickup(trip) {
  const input = $('#rf-pickup');
  const hint = $('#rf-pickup-hint');
  const tap = { label: 'Where you tapped', lat: trip.tapLoc.lat, lng: trip.tapLoc.lng, precision: 'tap' };
  state.form.pickup = tap;
  input.value = tap.label;
  hint.textContent = 'From where you were when you tapped. Change it if the pickup was far from there.';
  api(`/api/near?at=${tap.lat.toFixed(5)},${tap.lng.toFixed(5)}`).then((r) => {
    // Only replace it if the form is still showing this job's untouched prefill.
    if (!state.form || state.form.id !== trip.id || state.form.pickup !== tap) return;
    state.form.pickup = { label: r.label, address: r.address, postal: r.postal, lat: tap.lat, lng: tap.lng, precision: 'tap' };
    input.value = r.label;
  }).catch(() => { /* keep "Where you tapped"; the coordinates are what matter */ });
}

function msg(text, isError = false) {
  const m = $('#rf-msg');
  m.textContent = text;
  m.classList.toggle('err', isError);
}

function wirePlace(inputId, key) {
  const input = $(`#${inputId}`);
  const list = $(`#${inputId}-s`);
  let timer;
  let seq = 0;
  input.addEventListener('input', () => {
    if (state.form) state.form[key] = null;
    if (key === 'pickup') $('#rf-pickup-hint').textContent = '';
    clearTimeout(timer);
    const q = input.value.trim();
    const area = findArea(q);
    renderSuggestions(list, area ? [area] : [], key, input);
    if (q.length < 3) return;
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const { results } = await api(`/api/search?q=${encodeURIComponent(q)}`);
        if (mine !== seq) return;
        const items = results.map((r) => ({
          label: r.label, address: r.address, postal: r.postal, lat: r.lat, lng: r.lng,
          precision: isPostal(q) ? 'postal' : 'exact',
        }));
        renderSuggestions(list, [...(area ? [area] : []), ...items].slice(0, 6), key, input);
      } catch { /* search is optional; the address is resolved again on save */ }
    }, 300);
  });
}

function renderSuggestions(list, items, key, input) {
  list.innerHTML = '';
  for (const it of items) {
    const sub = it.precision === 'area' ? 'Area only, approximate' : it.address || '';
    const b = button(`<span>${esc(it.label)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}`, '', () => {
      state.form[key] = it;
      input.value = it.label;
      list.innerHTML = '';
      if (key === 'drop') {
        if (!state.form.zone) { state.form.zone = classifyZone(it.lat, it.lng); markFormZone(); }
        else zoneHint();
      }
    });
    list.append(b);
  }
}

class NotFound extends Error {}

// Turns what was typed into a place with coordinates. Returns { text, pending: true } when the
// map can't be reached, so the trip can still be saved and resolved later.
async function resolvePlace(text, chosen) {
  if (chosen && chosen.lat) return chosen;
  const area = findArea(text);
  if (area) return area;
  try {
    const { results } = await api(`/api/search?q=${encodeURIComponent(text)}`);
    const r = results[0];
    if (!r) throw new NotFound(`OneMap can’t find “${text}”. Try a postal code or an area name like Tampines.`);
    return { label: r.label, address: r.address, postal: r.postal, lat: r.lat, lng: r.lng, precision: isPostal(text) ? 'postal' : 'exact' };
  } catch (e) {
    if (e instanceof NotFound) throw e;
    return { text, pending: true };
  }
}

async function fetchDistance(trip) {
  if (trip.pickup?.pending) trip.pickup = await resolvePlace(trip.pickupText, null).catch(() => trip.pickup);
  if (trip.drop?.pending) trip.drop = await resolvePlace(trip.dropText, null).catch(() => trip.drop);
  if (!trip.zone && trip.drop?.lat) trip.zone = classifyZone(trip.drop.lat, trip.drop.lng);
  if (!(trip.pickup?.lat && trip.drop?.lat)) { trip.distanceStatus = 'pending'; return false; }
  try {
    const r = await api(`/api/route?from=${trip.pickup.lat},${trip.pickup.lng}&to=${trip.drop.lat},${trip.drop.lng}`);
    trip.km = r.km;
    trip.driveMin = r.min;
    trip.distanceStatus = 'ok';
    trip.distanceSource = 'onemap';
    delete trip.distanceError;
    if (!trip.band) trip.band = bandFor(trip.km).id;
    return true;
  } catch (e) {
    trip.distanceStatus = e.status === 404 ? 'failed' : 'pending';
    trip.distanceError = e.message;
    return false;
  }
}

async function saveRecon(ev) {
  ev.preventDefault();
  const pickupText = $('#rf-pickup').value.trim();
  const dropText = $('#rf-drop').value.trim();
  const paid = parseFloat($('#rf-fare').value);
  const minRaw = $('#rf-min').value.trim();
  const mins = minRaw ? parseFloat(minRaw) : null;
  const jobTs = new Date($('#rf-when').value).getTime();
  if (!pickupText || !dropText) return msg('Add both the pickup and the drop-off.', true);
  if (!(paid > 0)) return msg(state.form.decision === 'cancelled' ? 'Add the fare the card showed when you cancelled.' : 'Add the fare you were paid.', true);
  if (!Number.isFinite(jobTs)) return msg('Add the job time. Time of day matters for the prediction.', true);
  if (jobTs > Date.now() + 5 * 60 * 1000) return msg('The job time is in the future.', true);
  if (mins !== null && !(mins > 0 && mins <= 300)) return msg('Trip time should be between 1 and 300 minutes.', true);

  const save = $('#rf-save');
  save.disabled = true;
  msg('Finding both places and the road distance on OneMap…');
  let pickup;
  let drop;
  try {
    pickup = await resolvePlace(pickupText, state.form.pickup);
    drop = await resolvePlace(dropText, state.form.drop);
  } catch (e) {
    save.disabled = false;
    return msg(e.message, true);
  }

  let trip = state.form.id ? state.trips.find((t) => t.id === state.form.id) : null;
  if (!trip) {
    trip = { id: uid(), ts: Date.now(), source: 'manual', rideType: 'standard' };
    state.trips.push(trip);
  }
  // Keep the minute-level time from the window tap unless it was changed here.
  if (toLocalInput(trip.ts) !== $('#rf-when').value) trip.ts = jobTs;
  Object.assign(trip, {
    status: 'reconciled',
    reconciledAt: Date.now(),
    decision: state.form.decision,
    pickupText, dropText, pickup, drop,
    fare: paid,
    tripMin: mins,
    payment: state.form.pay || null,
    zone: state.form.zone || trip.zone || null,
  });
  const gotDistance = await fetchDistance(trip);
  await db.putTrip(trip);

  state.form = null;
  renderBadge();
  renderReconList();
  const p = trip.prediction;
  const off = p ? Math.round(((p.net - paid) / paid) * 100) : null;
  const vs = p ? ` Predicted ${dollars(p.net)}, paid ${fare(paid)} (${off === 0 ? 'spot on' : `${Math.abs(off)}% ${off > 0 ? 'high' : 'low'}`}).` : '';
  toast(gotDistance ? `Saved with OneMap road distance ${trip.km} km.${vs}` : `Saved. Road distance will be fetched when OneMap is reachable.${vs}`);
  syncNow();
}

// ---------- shared pool ----------
// Uploads your new or edited jobs (if sharing is on) and pulls everyone else's. Never blocks
// the window: it runs in the background and quietly retries on the next trigger.
function syncNow() {
  if (state.syncing) return state.syncing;
  if (!navigator.onLine) return Promise.resolve();
  state.syncing = (async () => {
    try {
      // Jobs saved while OneMap was unreachable or not set up are held on the phone without a
      // road distance, and the pool only takes jobs with one. Retry them here so they reach the
      // pool without anyone tapping a button.
      const waiting = state.trips.filter((t) => t.status === 'reconciled' && t.distanceStatus === 'pending').slice(0, 20);
      for (const t of waiting) {
        if (await fetchDistance(t)) await db.putTrip(t);
        else if (/isn’t set up|Signing in to OneMap failed/.test(t.distanceError || '')) break; // server not ready; try next sync
      }
      await pushJobs({
        trips: state.trips,
        device: state.device,
        post: (body) => api('/api/jobs', body),
        save: (ts) => db.putTrips(ts),
      });
      const since = (await db.getKV('poolCursor')) || 0;
      const { cursor, total } = await pullJobs({
        since,
        get: (c) => api(`/api/jobs?since=${c}`),
        store: (rows) => db.putShared(rows),
      });
      if (total) state.shared = await db.allShared();
      await db.setKV('poolCursor', cursor);
      state.lastSync = Date.now();
      state.syncError = '';
    } catch (e) {
      state.syncError = e.status === 503 ? 'The shared pool isn’t set up on the server yet.' : 'Couldn’t reach the shared pool. Will retry.';
    } finally {
      state.syncing = null;
      if (state.view === 'trips') renderTrips();
    }
  })();
  return state.syncing;
}

// ---------- trips ----------
function renderTrips() {
  const box = $('#view-trips');
  const rec = state.trips.filter((t) => t.status === 'reconciled').sort((a, b) => b.ts - a.ts);
  const own = new Set(state.trips.map((t) => t.id));
  const poolOthers = state.shared.filter((r) => !own.has(r.id) && isTrainable(r)).length;
  const acc = accuracy(state.trips);
  const pending = rec.filter((t) => t.distanceStatus === 'pending').length;
  const decided = state.trips.filter((t) => t.decision);
  const cancelled = decided.filter((t) => t.decision === 'cancelled').length;
  const noFare = state.trips.filter((t) => t.status === 'nofare').length;
  const bias = acc.bias === null ? '' : acc.bias > 0.02 ? `Predictions run ${Math.round(acc.bias * 100)}% high` : acc.bias < -0.02 ? `Predictions run ${Math.round(-acc.bias * 100)}% low` : 'No consistent lean';
  box.innerHTML = `
    <div class="tiles">
      <div class="tile"><span class="v">${rec.length}</span><span class="k">Your reconciled jobs</span></div>
      <div class="tile"><span class="v">${poolOthers}</span><span class="k">Jobs from other drivers</span></div>
      <div class="tile"><span class="v">${acc.mape === null ? '—' : `${Math.round(acc.mape * 100)}%`}</span><span class="k">Average prediction error</span></div>
      <div class="tile"><span class="v">${pending}</span><span class="k">Waiting for road distance</span></div>
    </div>
    ${bias ? `<p class="note">${esc(bias)} across ${acc.count} trip${acc.count === 1 ? '' : 's'}.</p>` : ''}
    <p class="note">${state.syncError ? esc(state.syncError) : state.lastSync ? `Shared pool synced at ${clock(state.lastSync)}.` : 'Shared pool not synced yet.'}</p>
    ${decided.length ? `<p class="note">${decided.length} decision${decided.length === 1 ? '' : 's'} logged: ${decided.length - cancelled} taken, ${cancelled} cancelled.${noFare ? ` ${noFare} kept without a fare.` : ''}</p>` : ''}
    ${trialNote()}
    ${pending ? '<button type="button" class="primary wide" id="retry-dist">Fetch road distances now</button>' : ''}
    <h2>Reconciled</h2>
    ${rec.length ? '' : '<p class="empty">No reconciled trips yet. Add the real fare for a job on the Reconcile tab.</p>'}`;
  if (pending) $('#retry-dist').addEventListener('click', retryDistances);
  for (const t of rec.slice(0, 200)) {
    const p = t.prediction;
    const dist = t.distanceStatus === 'ok' ? `${t.km} km · ${Math.round(t.driveMin)} min drive` : t.distanceStatus === 'failed' ? 'No route found' : 'Distance pending';
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="line1"><span class="when">${esc(when(t.ts))}</span><span class="when">${fare(t.fare)}</span></div>
      <div class="meta">${esc(placeLabel(t.pickup, t.pickupText))} → ${esc(placeLabel(t.drop, t.dropText))}</div>
      <div class="meta">${esc(dist)} · ${esc(zoneLabel(t.zone))}${t.tripMin ? ` · ${t.tripMin} min trip` : ''}${t.payment ? ` · ${t.payment === 'cash' ? 'Cash' : 'Cashless'}` : ''}${p ? ` · predicted ${dollars(p.net)}` : ''}</div>
      ${t.decision ? `<div class="acts"><span class="pill ${t.decision}">${decisionLabel(t.decision)}${t.decidedAt ? ` ${clock(t.decidedAt)}` : ''}</span></div>` : ''}`;
    const acts = document.createElement('div');
    acts.className = 'acts';
    acts.append(button('Edit', 'ghost small', () => { show('reconcile'); openForm(t); }));
    card.append(acts);
    box.append(card);
  }
}

// The drop-area trial: would predictions have been closer matching on drop area, or ignoring it?
let trialCache = { key: '', html: '' };
function trialNote() {
  const data = trainingSet();
  const key = `${data.length}:${state.settings.matchDropArea}`;
  if (trialCache.key === key) return trialCache.html;
  const r = dropAreaTrial(data, state.settings);
  let html = '';
  if (r.count < 10) {
    html = `<p class="note">Drop-area trial: fares are predicted from distance, time and pickup area, ignoring the drop area. A comparison shows here after 10 jobs with a fare (${r.count} so far).</p>`;
  } else {
    const a = Math.round(r.withoutDrop * 100);
    const b = Math.round(r.withDrop * 100);
    const verdict = Math.abs(a - b) < 2 ? 'About the same so far.' : a < b ? 'Ignoring the drop area is closer.' : 'Matching on the drop area is closer.';
    html = `<p class="note">Drop-area trial on your last ${r.count} jobs: ignoring the drop area is ${a}% off on average, matching on it is ${b}% off. ${verdict}</p>`;
  }
  trialCache = { key, html };
  return html;
}

async function retryDistances() {
  const btn = $('#retry-dist');
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  let ok = 0;
  const todo = state.trips.filter((t) => t.status === 'reconciled' && t.distanceStatus === 'pending');
  for (const t of todo) {
    if (await fetchDistance(t)) ok++;
    await db.putTrip(t);
  }
  toast(`${ok} of ${todo.length} distances fetched.`);
  renderTrips();
}

// ---------- settings ----------
const settingInputs = {
  'st-target': ['targetPerHour', 1],
  'st-pickup': ['pickupMin', 1],
  'st-minfare': ['minFare', 1],
  'st-base': ['base', 1],
  'st-km': ['perKm', 1],
  'st-min': ['perMin', 1],
  'st-deadmin': ['deadReturnMin', 1],
};

function buildSettings() {
  const dead = $('#st-dead');
  for (const z of ZONES) {
    const b = button(esc(z.short), '', async () => {
      const set = new Set(state.settings.deadZones);
      if (set.has(z.id)) set.delete(z.id);
      else set.add(z.id);
      state.settings = { ...state.settings, deadZones: ZONES.map((x) => x.id).filter((id) => set.has(id)) };
      await db.setKV('settings', state.settings);
      fillSettings();
      markDeadDrops();
      settingsMsg(set.has(z.id) ? `${z.label} is now a dead drop for you.` : `${z.label} is no longer a dead drop for you.`);
    });
    b.dataset.v = z.id;
    dead.append(b);
  }
  fillSettings();
  $('#settings-form').addEventListener('change', onSettingsChange);
  $('#settings-form').addEventListener('submit', (e) => e.preventDefault());
  $('#st-reset').addEventListener('click', async () => {
    state.settings = mergeSettings();
    await db.setKV('settings', state.settings);
    fillSettings();
    markDeadDrops();
    settingsMsg('Starting values restored.');
  });
  $('#st-export').addEventListener('click', exportData);
  $('#st-import').addEventListener('change', importData);
  let armed = false;
  let disarm;
  $('#st-clear').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (!armed) {
      armed = true;
      b.textContent = 'Tap again to delete every trip';
      disarm = setTimeout(() => { armed = false; b.textContent = 'Delete all trips'; }, 4000);
      return;
    }
    clearTimeout(disarm);
    armed = false;
    b.textContent = 'Delete all trips';
    await db.clearTrips();
    state.trips = [];
    resetWindow();
    renderBadge();
    settingsMsg('All trips deleted.');
  });
}

function fillSettings() {
  for (const [id, [key, scale]] of Object.entries(settingInputs)) $(`#${id}`).value = +(state.settings[key] * scale).toFixed(2);
  for (const b of $$('#st-dead button')) b.classList.toggle('sel', state.settings.deadZones.includes(b.dataset.v));
  $('#st-key').value = state.apiKey;
}

function settingsMsg(text, isError = false) {
  const m = $('#st-msg');
  m.textContent = text;
  m.classList.toggle('err', isError);
}

async function onSettingsChange(e) {
  if (e.target.id === 'st-import') return;
  if (e.target.id === 'st-key') {
    state.apiKey = e.target.value.trim();
    await db.setKV('apiKey', state.apiKey);
    checkStatus();
    settingsMsg('Access key saved.');
    return;
  }
  const next = mergeSettings(state.settings);
  for (const [id, [key, scale]] of Object.entries(settingInputs)) {
    const v = parseFloat($(`#${id}`).value);
    if (Number.isFinite(v) && v >= 0) next[key] = v / scale;
  }
  if (!(next.targetPerHour > 0)) next.targetPerHour = DEFAULT_SETTINGS.targetPerHour;
  state.settings = next;
  await db.setKV('settings', next);
  settingsMsg('Saved.');
}

async function exportData() {
  const payload = JSON.stringify({ app: 'fareit', version: 1, exportedAt: new Date().toISOString(), settings: state.settings, trips: state.trips }, null, 2);
  const name = `fareit-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([payload], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Fareit trips' });
      settingsMsg(`Exported ${state.trips.length} trips.`);
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  settingsMsg(`Exported ${state.trips.length} trips.`);
}

async function importData(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'fareit' || !Array.isArray(data.trips)) throw new Error('This file isn’t a Fareit export.');
    const valid = data.trips.filter((t) => t && typeof t.id === 'string' && Number.isFinite(t.ts));
    const byId = new Map(state.trips.map((t) => [t.id, t]));
    for (const t of valid) byId.set(t.id, t);
    state.trips = [...byId.values()];
    await db.putTrips(valid);
    if (data.settings) {
      state.settings = mergeSettings(data.settings);
      await db.setKV('settings', state.settings);
      fillSettings();
      markDeadDrops();
    }
    renderBadge();
    settingsMsg(`Imported ${valid.length} trips.`);
  } catch (err) {
    settingsMsg(err instanceof SyntaxError ? 'That file couldn’t be read as JSON.' : err.message, true);
  }
}

// ---------- keep the mounted screen awake on the Window tab ----------
async function keepAwake() {
  try {
    if (state.view === 'window' && document.visibilityState === 'visible' && 'wakeLock' in navigator) {
      if (!state.wakeLock) {
        state.wakeLock = await navigator.wakeLock.request('screen');
        state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
      }
    } else if (state.wakeLock) {
      await state.wakeLock.release();
      state.wakeLock = null;
    }
  } catch { /* not supported or refused; the screen may dim */ }
}

// ---------- boot ----------
async function boot() {
  const [trips, saved, key, shared, device] = await Promise.all([
    db.allTrips(), db.getKV('settings'), db.getKV('apiKey'), db.allShared(), db.getKV('device'),
  ]);
  state.trips = trips || [];
  state.settings = mergeSettings(saved);
  state.apiKey = key || '';
  state.shared = shared || [];
  state.device = device || uid();
  if (!device) await db.setKV('device', state.device);

  buildWindow();
  buildReconForm();
  buildSettings();
  for (const t of $$('.tabs button')) t.addEventListener('click', () => { if (t.dataset.view === 'reconcile') state.form = null; show(t.dataset.view); });
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  window.addEventListener('online', () => { checkStatus(); syncNow(); });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 5 * 60 * 1000);
  window.addEventListener('offline', checkStatus);
  document.addEventListener('visibilitychange', keepAwake);

  renderBadge();
  show(location.hash.slice(1) || 'window');
  checkStatus();
  syncNow();
  if (db.isMemoryOnly()) toast('This browser is blocking storage, so trips won’t be kept. Add Fareit to your Home Screen.');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  watchLocation();
}

// Where Phone 2 is when a job comes in is roughly the pickup area (Orchard at 2:45 is not
// Tampines at 2:45). Low accuracy is plenty and saves battery. If refused, everything else works.
function watchLocation() {
  if (!('geolocation' in navigator)) return;
  try {
    navigator.geolocation.watchPosition(
      (pos) => { state.loc = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy), at: Date.now() }; },
      () => {},
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 30000 },
    );
  } catch { /* not available */ }
}

boot();
