import { BANDS, ZONES, DEFAULT_SETTINGS, mergeSettings, predict, bandFor, accuracy, isTrainable } from './model.js';
import { findArea, isPostal, classifyZone } from './places.js';
import * as db from './db.js';

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
};

// ---------- small helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
const dollars = (n) => `$${Math.round(n)}`;
const fare = (n) => `S$${Number(n).toFixed(2)}`;
const zoneLabel = (id) => ZONES.find((z) => z.id === id)?.label ?? '—';
const bandLabel = (id) => (BANDS.find((b) => b.id === id)?.label ?? '—') + ' km';
const when = (ts) => new Date(ts).toLocaleString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const placeLabel = (p, text) => (p && p.label) || text || '—';

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

async function api(path) {
  const headers = state.apiKey ? { 'x-fareit-key': state.apiKey } : {};
  const res = await fetch(path, { headers });
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
    const el = button(esc(z.short), `tap${z.dead ? ' dead' : ''}`, () => pick('zone', z.id));
    el.dataset.id = z.id;
    el.setAttribute('aria-label', `${z.label}${z.dead ? ', usually a dead drop' : ''}`);
    zones.append(el);
  }
  const v = $('#verdict');
  v.addEventListener('click', resetWindow);
  v.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); resetWindow(); } });
  renderVerdict(null);
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
  const p = predict({ band: state.band, zone: state.zone, ts: now }, state.trips, state.settings);
  renderVerdict(p);

  // A change within 15 seconds is a correction of the same job, not a new one.
  let trip = state.currentId && now - state.currentAt < 15000 ? state.trips.find((t) => t.id === state.currentId) : null;
  if (!trip) {
    trip = { id: uid(), ts: now, status: 'pending', source: 'window' };
    state.trips.push(trip);
    state.currentId = trip.id;
    state.currentAt = now;
  }
  trip.band = state.band;
  trip.zone = state.zone;
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
  if (p.returnMin >= 10) why.push(`+ about ${p.returnMin} min empty drive back`);
  const stage = p.stage === 'seed'
    ? 'Fare-structure estimate. No reconciled trips yet.'
    : `${p.stage === 'trained' ? 'Based on' : 'Learning from'} ${p.basis} reconciled trip${p.basis === 1 ? '' : 's'}.`;
  v.className = `verdict ${p.verdict === 'TAKE' ? 'take' : 'skip'}`;
  v.innerHTML = `
    <div class="top-row"><span class="word">${p.verdict}</span><span class="clear">Tap to clear</span></div>
    <div class="nums">
      <span><span class="big">${dollars(p.net)}</span> <span class="rng">${dollars(p.lo)}–${dollars(p.hi)}</span></span>
      <span><span class="big">${dollars(p.perHour)}/hr</span> <span class="rng">line ${dollars(state.settings.targetPerHour)}</span></span>
    </div>
    <div class="why">${esc(why.join(' '))}. ${esc(stage)}</div>`;
}

// ---------- reconcile ----------
function renderReconList() {
  const box = $('#recon-list');
  const pending = state.trips.filter((t) => t.status === 'pending').sort((a, b) => b.ts - a.ts);
  box.hidden = false;
  $('#recon-form').hidden = true;
  box.innerHTML = `
    <div class="head"><h2>To reconcile</h2><button type="button" class="primary small" id="add-trip">Add a trip</button></div>
    ${pending.length ? '' : '<p class="empty">Nothing waiting. Every job you tap on the Window tab lands here, so you can add the real fare once you are parked.</p>'}`;
  $('#add-trip').addEventListener('click', () => openForm(null));
  for (const t of pending) {
    const p = t.prediction;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="line1"><span class="when">${esc(when(t.ts))}</span>${p ? `<span class="pill ${p.verdict === 'TAKE' ? 'take' : 'skip'}">${p.verdict}</span>` : ''}</div>
      <div class="meta">${esc(bandLabel(t.band))} · ${esc(zoneLabel(t.zone))}${p ? ` · predicted ${dollars(p.net)}` : ''}</div>`;
    const acts = document.createElement('div');
    acts.className = 'acts';
    acts.append(
      button('Add real fare', 'primary small', () => openForm(t)),
      button('Didn’t take it', 'ghost small', () => markSkipped(t)),
    );
    card.append(acts);
    box.append(card);
  }
}

async function markSkipped(t) {
  t.status = 'skipped';
  await db.putTrip(t);
  renderBadge();
  renderReconList();
  toast('Marked as not taken. It won’t be used for training.');
}

function buildReconForm() {
  const zoneBox = $('#rf-zone');
  for (const z of ZONES) {
    const b = button(esc(z.short), '', () => { state.form.zone = z.id; markFormZone(); });
    b.dataset.v = z.id;
    zoneBox.append(b);
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
  state.form = { id: trip ? trip.id : null, pickup: trip?.pickup || null, drop: trip?.drop || null, zone: trip?.zone || null, pay: trip?.payment || null };
  $('#recon-list').hidden = true;
  const f = $('#recon-form');
  f.hidden = false;
  $('#rf-title').textContent = trip ? 'Add the real fare' : 'Add a trip';
  $('#rf-sub').textContent = trip
    ? `${when(trip.ts)} · ${bandLabel(trip.band)} · ${zoneLabel(trip.zone)}${trip.prediction ? ` · predicted ${dollars(trip.prediction.net)}` : ''}`
    : 'A trip you didn’t tap in the window.';
  $('#rf-pickup').value = trip?.pickupText || '';
  $('#rf-drop').value = trip?.dropText || '';
  $('#rf-min').value = trip?.tripMin || '';
  $('#rf-fare').value = trip?.fare || '';
  $('#rf-pickup-s').innerHTML = '';
  $('#rf-drop-s').innerHTML = '';
  for (const x of $$('#rf-pay button')) x.classList.toggle('sel', x.dataset.v === state.form.pay);
  markFormZone();
  msg('');
  $('#rf-save').disabled = false;
  $('#rf-pickup').focus();
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
  if (!pickupText || !dropText) return msg('Add both the pickup and the drop-off.', true);
  if (!(paid > 0)) return msg('Add the fare you were actually paid.', true);
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
    trip = { id: uid(), ts: Date.now(), source: 'manual' };
    state.trips.push(trip);
  }
  Object.assign(trip, {
    status: 'reconciled',
    reconciledAt: Date.now(),
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
}

// ---------- trips ----------
function renderTrips() {
  const box = $('#view-trips');
  const rec = state.trips.filter((t) => t.status === 'reconciled').sort((a, b) => b.ts - a.ts);
  const trainable = rec.filter(isTrainable).length;
  const acc = accuracy(state.trips);
  const pending = rec.filter((t) => t.distanceStatus === 'pending').length;
  const bias = acc.bias === null ? '' : acc.bias > 0.02 ? `Predictions run ${Math.round(acc.bias * 100)}% high` : acc.bias < -0.02 ? `Predictions run ${Math.round(-acc.bias * 100)}% low` : 'No consistent lean';
  box.innerHTML = `
    <div class="tiles">
      <div class="tile"><span class="v">${rec.length}</span><span class="k">Reconciled trips</span></div>
      <div class="tile"><span class="v">${trainable}</span><span class="k">Training the model</span></div>
      <div class="tile"><span class="v">${acc.mape === null ? '—' : `${Math.round(acc.mape * 100)}%`}</span><span class="k">Average prediction error</span></div>
      <div class="tile"><span class="v">${pending}</span><span class="k">Waiting for road distance</span></div>
    </div>
    ${bias ? `<p class="note">${esc(bias)} across ${acc.count} trip${acc.count === 1 ? '' : 's'}.</p>` : ''}
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
      <div class="meta">${esc(dist)} · ${esc(zoneLabel(t.zone))}${t.tripMin ? ` · ${t.tripMin} min trip` : ''}${t.payment ? ` · ${t.payment === 'cash' ? 'Cash' : 'Cashless'}` : ''}${p ? ` · predicted ${dollars(p.net)}` : ''}</div>`;
    const acts = document.createElement('div');
    acts.className = 'acts';
    acts.append(button('Edit', 'ghost small', () => { show('reconcile'); openForm(t); }));
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
  'st-target': ['targetPerHour', 1],
  'st-pickup': ['pickupMin', 1],
  'st-base': ['base', 1],
  'st-km': ['perKm', 1],
  'st-min': ['perMin', 1],
  'st-comm': ['commission', 100],
};

function buildSettings() {
  const box = $('#st-returns');
  for (const z of ZONES) {
    const f = document.createElement('div');
    f.className = 'field';
    f.innerHTML = `<label for="st-ret-${z.id}">${esc(z.short)}</label><input id="st-ret-${z.id}" type="number" inputmode="numeric" min="0" max="120" step="1">`;
    box.append(f);
  }
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
  for (const z of ZONES) $(`#st-ret-${z.id}`).value = state.settings.returnMin[z.id];
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
  next.commission = Math.min(Math.max(next.commission, 0), 0.6);
  if (!(next.targetPerHour > 0)) next.targetPerHour = DEFAULT_SETTINGS.targetPerHour;
  for (const z of ZONES) {
    const v = parseFloat($(`#st-ret-${z.id}`).value);
    if (Number.isFinite(v) && v >= 0) next.returnMin[z.id] = v;
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
  const [trips, saved, key] = await Promise.all([db.allTrips(), db.getKV('settings'), db.getKV('apiKey')]);
  state.trips = trips || [];
  state.settings = mergeSettings(saved);
  state.apiKey = key || '';

  buildWindow();
  buildReconForm();
  buildSettings();
  for (const t of $$('.tabs button')) t.addEventListener('click', () => { if (t.dataset.view === 'reconcile') state.form = null; show(t.dataset.view); });
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  window.addEventListener('online', checkStatus);
  window.addEventListener('offline', checkStatus);
  document.addEventListener('visibilitychange', keepAwake);

  renderBadge();
  show(location.hash.slice(1) || 'window');
  checkStatus();
  if (db.isMemoryOnly()) toast('This browser is blocking storage, so trips won’t be kept. Add Fareit to your Home Screen.');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
