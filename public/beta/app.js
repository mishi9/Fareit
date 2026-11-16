import { BANDS, mergeSettings, predict, bandFor, bandMidKm, estDriveMin, accuracy, isTrainable } from './model.js';

const KM_MIN = 1;
const KM_MAX = 50; // the top of the slider means 50 km or more
import { findArea, isPostal } from './places.js';
import * as db from './db.js';
import { pushJobs, pullJobs } from './sync.js';
import { buildLab, syncLab } from './lab.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  trips: [],
  settings: mergeSettings(),
  apiKey: '',
  km: null, // the distance on the job card, from the slider
  shown: null, // the prediction on screen, saved as a job only on Took it / Cancelled
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
const PRICING_LABEL = { surge: 'Surge', normal: 'Normal', bad: 'Bad' };
const distLabel = (t) => (t.cardKm > 0 ? `${t.cardKm >= KM_MAX ? '50+' : t.cardKm} km on card` : bandLabel(t.band));
const bandLabel = (id) => (BANDS.find((b) => b.id === id)?.label ?? (id ? id.replace('-', '–') : '—')) + ' km';
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
  if (!['window', 'reconcile', 'trips', 'lab', 'settings'].includes(view)) view = 'window';
  state.view = view;
  for (const v of $$('.view')) v.hidden = v.id !== `view-${view}`;
  for (const t of $$('.tabs button')) t.classList.toggle('on', t.dataset.view === view);
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  if (view === 'reconcile') { if (!state.form) renderReconList(); }
  if (view === 'trips') renderTrips();
  if (view === 'lab') syncLab();
  keepAwake();
}

// ---------- window: slide the card's km -> predicted fare ----------
function buildWindow() {
  const track = $('#km-track');
  const ticks = $('.km-ticks');
  ticks.innerHTML = [1, 10, 20, 30, 40, 50].map((k) => `<span style="left:${kmPos(k)}%">${k === KM_MAX ? '50+' : k}</span>`).join('');
  const fromX = (x) => {
    const r = $('.km-rail').getBoundingClientRect();
    return Math.round(KM_MIN + Math.min(1, Math.max(0, (x - r.left) / r.width)) * (KM_MAX - KM_MIN));
  };
  // Touch anywhere to jump there; the fare follows the drag; the job is saved on release.
  let dragging = false;
  track.addEventListener('pointerdown', (e) => {
    dragging = true;
    track.setPointerCapture(e.pointerId);
    preview(fromX(e.clientX));
  });
  track.addEventListener('pointermove', (e) => { if (dragging) preview(fromX(e.clientX)); });
  const release = () => { if (!dragging) return; dragging = false; commitKm(); };
  track.addEventListener('pointerup', release);
  track.addEventListener('pointercancel', release);
  track.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    preview((state.km ?? 10) + step);
    commitKm();
  });
  for (const b of $$('.nudge')) {
    b.addEventListener('click', () => {
      preview((state.km ?? 10) + Number(b.dataset.nudge));
      commitKm();
    });
  }
  const onAct = (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'clear') resetWindow();
    else recordDecision(b.dataset.act);
  };
  $('#verdict').addEventListener('click', onAct);
  $('#decide').addEventListener('click', onAct);
  renderVerdict(null);
}

const kmPos = (km) => ((km - KM_MIN) / (KM_MAX - KM_MIN)) * 100;

function markKm() {
  const track = $('#km-track');
  track.classList.toggle('empty', state.km === null);
  track.style.setProperty('--pos', state.km === null ? 0 : kmPos(state.km) / 100);
  track.setAttribute('aria-valuenow', state.km ?? '');
  $('#km-val').textContent = state.km === null ? '—' : state.km === KM_MAX ? '50+' : state.km;
}

const nowLoc = () => (state.loc && Date.now() - state.loc.at < 10 * 60 * 1000 ? state.loc : null);

// While sliding: move the thumb and show the fare for this km, without saving anything yet.
function preview(km) {
  km = Math.min(KM_MAX, Math.max(KM_MIN, km));
  if (km === state.km) return;
  state.km = km;
  markKm();
  renderVerdict(predict({ km, ts: Date.now(), loc: nowLoc() }, trainingSet(), state.settings));
}

function commitKm() {
  if (state.km === null) return;
  clearTimeout(state.resetTimer);
  state.resetTimer = setTimeout(resetWindow, 30000);
  decide();
}

function resetWindow() {
  clearTimeout(state.resetTimer);
  state.km = null;
  state.shown = null;
  markKm();
  renderVerdict(null);
}

// Shows the fare for the km on the slider. Nothing is saved here: a job is only recorded when you
// tap Took it or Cancelled, so trying a few km values never fills Reconcile.
function decide() {
  const now = Date.now();
  const loc = nowLoc();
  const p = predict({ km: state.km, ts: now, loc }, trainingSet(), state.settings);
  renderVerdict(p);
  state.shown = { km: state.km, p, loc, firstAt: state.shown?.firstAt ?? now };
}

function renderVerdict(p) {
  const v = $('#verdict');
  $('#decide').hidden = !p;
  if (!p) {
    v.className = 'verdict idle';
    v.innerHTML = '<p>Slide to the trip distance on the job card.</p>';
    return;
  }
  const stage = p.stage === 'seed'
    ? 'Fare-structure estimate. No reconciled jobs yet.'
    : `${p.stage === 'trained' ? 'Based on' : 'Learning from'} ${p.basis} job${p.basis === 1 ? '' : 's'}${p.shared ? ` (${p.shared} from other drivers)` : ''}, ${p.nearTime} within an hour of now on a ${DAY_NAMES[p.dayClass]}.`;
  v.className = `verdict fare ${p.surge.likely}`;
  v.innerHTML = `
    <div class="top-row"><span class="word">${dollars(p.net)}</span><button type="button" class="clear" data-act="clear">Clear</button></div>
    <div class="nums"><span class="rng">likely ${dollars(p.lo)}–${dollars(p.hi)} · ${p.km >= KM_MAX ? '50+' : p.km} km, about ${Math.round(p.tripMin)} min</span></div>
    <div class="why">${esc(surgeLine(p.surge))} ${esc(stage)}</div>`;
}

// What surge / normal / bad tags from around here, at this time, say about pricing right now.
function surgeLine(o) {
  const tags = o.near.surge + o.near.normal + o.near.bad;
  const how = o.inferredNear === tags ? 'judged from fares' : o.inferredNear ? 'tagged or judged from fares' : 'tagged';
  const counts = tags ? ` (${o.near.surge} surge, ${o.near.normal} normal, ${o.near.bad} bad near here within an hour, ${how})` : '';
  if (o.likely === 'surge') return `Surge likely here now, ${Math.round(o.chance.surge * 100)}%${counts}.`;
  if (o.likely === 'bad') return `Pricing usually low here now${counts}.`;
  return tags ? `Usually normal pricing here now${counts}.` : 'No jobs near here at this time yet to judge surge.';
}

// Records what you did and when. Taken or cancelled, the job stays in Reconcile so its fare
// can be added: a cancelled job whose fare you saw trains the model like any other.
async function recordDecision(decision) {
  const shown = state.shown;
  if (!shown) return;
  const now = Date.now();
  const { p, loc } = shown;
  // The job's time is when you took or cancelled it, not when you slid the km or reconciled.
  const trip = {
    id: uid(), ts: now, status: 'pending', source: 'window', rideType: 'standard',
    cardKm: shown.km, band: bandFor(shown.km).id,
    decision, decidedAt: now, decideSeconds: Math.round((now - shown.firstAt) / 1000),
    prediction: {
      net: p.net, lo: p.lo, hi: p.hi, km: p.km, tripMin: p.tripMin, stage: p.stage, basis: p.basis,
      surge: p.surge.likely, surgeChance: Math.round(p.surge.chance.surge * 100) / 100,
    },
  };
  const here = nowLoc() || loc;
  if (here) trip.tapLoc = { lat: here.lat, lng: here.lng, accuracy: here.accuracy };
  state.trips.push(trip);
  resetWindow();
  toast(`${decisionLabel(decision)} at ${clock(now)}. Add the fare later in Reconcile.`);
  await db.putTrip(trip);
  renderBadge();
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
      <div class="line1"><span class="when">${esc(when(t.ts))}</span><span class="acts">${decided}${p && p.surge === 'surge' ? '<span class="pill surge">Surge likely</span>' : ''}</span></div>
      <div class="meta">${esc(distLabel(t))}${p ? ` · predicted ${dollars(p.net)}` : ''}</div>`;
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

// Keeps the job (time, band, decision) but it can't teach the fare without one.
async function markNoFare(t) {
  t.status = 'nofare';
  await db.putTrip(t);
  renderBadge();
  renderReconList();
  toast('Kept with its time and decision. Without a fare it can’t train the price.');
  syncNow();
}

function buildReconForm() {
  for (const b of $$('#rf-decision button')) {
    b.addEventListener('click', () => {
      state.form.decision = b.dataset.v;
      markFormDecision();
    });
  }
  for (const b of $$('#rf-pricing button')) {
    b.addEventListener('click', () => {
      state.form.pricing = state.form.pricing === b.dataset.v ? null : b.dataset.v;
      markFormPricing();
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

function markFormPricing() {
  for (const b of $$('#rf-pricing button')) b.classList.toggle('sel', b.dataset.v === state.form.pricing);
}

function openForm(trip) {
  state.form = {
    id: trip ? trip.id : null, pickup: trip?.pickup || null, drop: trip?.drop || null,
    pricing: trip?.pricing || null, decision: trip?.decision || 'took',
  };
  $('#recon-list').hidden = true;
  const f = $('#recon-form');
  f.hidden = false;
  $('#rf-title').textContent = trip ? 'Add the real fare' : 'Add a trip';
  $('#rf-sub').textContent = trip
    ? `${when(trip.ts)} · ${distLabel(trip)}${trip.prediction ? ` · predicted ${dollars(trip.prediction.net)}` : ''}`
    : 'A trip you didn’t tap in the window.';
  $('#rf-pickup').value = trip?.pickupText || '';
  $('#rf-pickup-hint').textContent = '';
  if (trip && !trip.pickupText && trip.tapLoc?.lat) prefillPickup(trip);
  $('#rf-drop').value = trip?.dropText || '';
  $('#rf-min').value = trip?.tripMin || '';
  $('#rf-km').value = trip?.kmTyped || '';
  $('#rf-km').placeholder = trip?.cardKm ? `${trip.cardKm} on card` : '45.8';
  $('#rf-fare').value = trip?.fare || '';
  $('#rf-when').value = toLocalInput(trip ? trip.ts : Date.now());
  markFormDecision();
  $('#rf-pickup-s').innerHTML = '';
  $('#rf-drop-s').innerHTML = '';
  markFormPricing();
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
  // No drop-off: the km you typed, or failing that the middle of the band you tapped.
  if (!trip.dropText) {
    const km = trip.kmTyped > 0 ? trip.kmTyped : trip.cardKm > 0 ? trip.cardKm : bandMidKm(trip.band);
    if (!km) { trip.distanceStatus = 'failed'; trip.distanceError = 'No drop-off, trip km or band.'; return false; }
    trip.km = km;
    trip.driveMin = estDriveMin(km);
    trip.distanceStatus = 'ok';
    trip.distanceSource = trip.kmTyped > 0 ? 'typed' : trip.cardKm > 0 ? 'card' : 'band';
    delete trip.distanceError;
    if (!trip.band) trip.band = bandFor(km).id;
    return true;
  }
  if (!(trip.pickup?.lat && trip.drop?.lat)) { trip.distanceStatus = 'pending'; return false; }
  if (trip.kmTyped > 0) {
    // You read the km off Grab's trip details: that beats a route guess. OneMap still gives the time.
    try {
      const r = await api(`/api/route?from=${trip.pickup.lat},${trip.pickup.lng}&to=${trip.drop.lat},${trip.drop.lng}`);
      trip.driveMin = r.min;
    } catch { trip.driveMin = estDriveMin(trip.kmTyped); }
    trip.km = trip.kmTyped;
    trip.distanceStatus = 'ok';
    trip.distanceSource = 'typed';
    delete trip.distanceError;
    if (!trip.band) trip.band = bandFor(trip.km).id;
    return true;
  }
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
  const kmRaw = $('#rf-km').value.trim();
  const kmTyped = kmRaw ? parseFloat(kmRaw) : null;
  const mins = minRaw ? parseFloat(minRaw) : null;
  const jobTs = new Date($('#rf-when').value).getTime();
  if (!pickupText) return msg('Add the pickup.', true);
  if (kmTyped !== null && !(kmTyped > 0 && kmTyped <= 150)) return msg('Trip km should be between 0.1 and 150.', true);
  const formTrip = state.form.id ? state.trips.find((t) => t.id === state.form.id) : null;
  if (!dropText && !kmTyped && !formTrip?.cardKm && !formTrip?.band) return msg('Add the drop-off or the trip km, so Fareit knows the distance.', true);
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
    drop = dropText ? await resolvePlace(dropText, state.form.drop) : null;
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
    pickupText, dropText, pickup, drop, kmTyped,
    fare: paid,
    tripMin: mins,
    pricing: state.form.pricing || null,
  });
  const gotDistance = await fetchDistance(trip);
  await db.putTrip(trip);

  state.form = null;
  renderBadge();
  renderReconList();
  const p = trip.prediction;
  const off = p ? Math.round(((p.net - paid) / paid) * 100) : null;
  const vs = p ? ` Predicted ${dollars(p.net)}, paid ${fare(paid)} (${off === 0 ? 'spot on' : `${Math.abs(off)}% ${off > 0 ? 'high' : 'low'}`}).` : '';
  const how = { onemap: `OneMap road distance ${trip.km} km`, typed: `your trip km (${trip.km} km)`, card: `the card's ${trip.km} km`, band: `the ${bandLabel(trip.band)} band (about ${trip.km} km)` }[trip.distanceSource];
  toast(gotDistance ? `Saved with ${how}.${vs}` : `Saved. Road distance will be fetched when OneMap is reachable.${vs}`);
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
      await flushDeletes();
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
        store: async (rows) => {
          // Jobs their owner deleted come back as tombstones: drop our copy.
          const gone = rows.filter((r) => r.deleted).map((r) => r.id);
          if (gone.length) await db.deleteShared(gone);
          const live = rows.filter((r) => !r.deleted);
          if (live.length) await db.putShared(live);
        },
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

// ---------- deleting a job ----------
// Removes a job from this phone and, if it reached the shared pool, from the pool too. If the pool
// can't be reached, the deletion is queued and sent on the next sync.
async function deleteJob(t) {
  state.trips = state.trips.filter((x) => x.id !== t.id);
  state.shared = state.shared.filter((x) => x.id !== t.id);
  await db.deleteTrips([t.id]);
  await db.deleteShared([t.id]);
  const queue = (await db.getKV('pendingDeletes')) || [];
  if (!queue.includes(t.id)) queue.push(t.id);
  await db.setKV('pendingDeletes', queue);
  renderBadge();
  toast('Job deleted from this phone. Removing it from the shared pool…');
  await flushDeletes().catch(() => {});
  if (state.view === 'trips') renderTrips();
}

async function flushDeletes() {
  const queue = (await db.getKV('pendingDeletes')) || [];
  if (!queue.length || !navigator.onLine) return;
  const res = await api('/api/jobs/delete', { device: state.device, ids: queue.slice(0, 50) });
  const done = new Set([...(res.deleted || []), ...(res.missing || [])]);
  await db.setKV('pendingDeletes', queue.filter((id) => !done.has(id)));
}

// A Delete button that asks for a second tap, so a stray touch can't remove a job.
function deleteButton(t) {
  let armed = false;
  let timer;
  const b = button('Delete', 'ghost small danger', () => {
    if (!armed) {
      armed = true;
      b.textContent = 'Tap again to delete';
      timer = setTimeout(() => { armed = false; b.textContent = 'Delete'; }, 4000);
      return;
    }
    clearTimeout(timer);
    deleteJob(t);
  });
  return b;
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
      <div class="meta">${esc(dist)}${t.tripMin ? ` · ${t.tripMin} min trip` : ''}${t.pricing ? ` · ${PRICING_LABEL[t.pricing]}` : ''}${p ? ` · predicted ${dollars(p.net)}` : ''}</div>
      ${t.decision ? `<div class="acts"><span class="pill ${t.decision}">${decisionLabel(t.decision)}${t.decidedAt ? ` ${clock(t.decidedAt)}` : ''}</span></div>` : ''}`;
    const acts = document.createElement('div');
    acts.className = 'acts';
    acts.append(button('Edit', 'ghost small', () => { show('reconcile'); openForm(t); }), deleteButton(t));
    card.append(acts);
    box.append(card);
  }
  // Jobs kept without a fare (No fare seen): listed so a duplicate or mistake can be removed.
  const noFareJobs = state.trips.filter((t) => t.status === 'nofare').sort((a, b) => b.ts - a.ts);
  if (noFareJobs.length) {
    const h = document.createElement('h2');
    h.textContent = 'Kept without a fare';
    box.append(h);
  }
  for (const t of noFareJobs.slice(0, 100)) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="line1"><span class="when">${esc(when(t.ts))}</span><span class="when">No fare seen</span></div>
      <div class="meta">${esc(distLabel(t))}${t.decision ? ` · ${decisionLabel(t.decision)}` : ''}</div>`;
    const acts = document.createElement('div');
    acts.className = 'acts';
    acts.append(deleteButton(t));
    card.append(acts);
    box.append(card);
  }
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
  'st-minfare': ['minFare', 1],
  'st-base': ['base', 1],
  'st-km': ['perKm', 1],
  'st-min': ['perMin', 1],
};

function buildSettings() {
  fillSettings();
  $('#settings-form').addEventListener('change', onSettingsChange);
  $('#settings-form').addEventListener('submit', (e) => e.preventDefault());
  $('#st-reset').addEventListener('click', async () => {
    state.settings = mergeSettings();
    await db.setKV('settings', state.settings);
    fillSettings();
    settingsMsg('Starting values restored.');
  });
  $('#st-export').addEventListener('click', exportData);
  $('#st-beta-leave').addEventListener('click', () => {
    try { localStorage.setItem('fareit-channel', 'main'); } catch { /* fine */ }
    location.href = '../#settings';
  });
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
  // Earlier versions saved a job on every distance tap. Ones never taken or cancelled were just
  // looks, not jobs: drop them so Reconcile only holds real decisions.
  const looks = state.trips.filter((t) => t.source === 'window' && t.status === 'pending' && !t.decision);
  if (looks.length) {
    await db.deleteTrips(looks.map((t) => t.id));
    state.trips = state.trips.filter((t) => !looks.includes(t));
  }
  state.settings = mergeSettings(saved);
  state.apiKey = key || '';
  state.shared = shared || [];
  state.device = device || uid();
  if (!device) await db.setKV('device', state.device);

  // The Window fills the screen below the header so the distance buttons sit just above the tabs.
  const sizeWindow = () => {
    const top = $('.top').offsetHeight + parseFloat(getComputedStyle($('main')).paddingTop || '0');
    document.documentElement.style.setProperty('--top-h', `${top}px`);
  };
  sizeWindow();
  window.addEventListener('resize', sizeWindow);
  buildWindow();
  buildLab($('#view-lab'));
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
