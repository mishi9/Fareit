// Formula tab (beta): type a trip's distance and Grab's time, see what the passenger should pay and
// what you should earn by the current formula, then type the real numbers. Saving records the
// predictions first, then re-fits, so every trip is an honest test. The trip's time is when you
// tap Save; it shows which hours run above the normal-price formula (surge-prone hours).
// Trips are uploaded to the formula dataset on the server (separate from the shared jobs pool)
// and everyone's trips are pulled in, so the formula learns from every tester.
import * as db from './db.js';
import { buildQueue, syncQueue, closeOpenReading } from './queue.js';
import { renderFlights } from './flights.js';
import { eventsList, onEventsChange, loadEvents } from './events.js';
import { jbPlace, jbRowsHtml } from './jb.js';
import { ferryTerminalAt, ferryRowsHtml } from './ferries.js';
import { loadSurge, surgeNow, surgeBanner, reportSurge } from './surge.js';
import { watchLocation, here, rounded, onMove, atAirport } from './where.js';
import { findArea, isPostal } from './places.js';
import {
  passengerFare, fitWeights, looError, fitCommission, driverEarns, cutOf, toCsv, timeOfDay, byTimeBlock, timeEstimator, withBase, surgeLift, airportLift, SURGE_HINT, bandOutlook, latestJob,
  markEvents, eventLift,
  MIN_PASSENGER, MIN_DRIVER, BASE_TRIPS,
} from './formula.js';

const KEY = 'formulaLab';

// The owner sees how the estimate is worked out (the formula, Grab's cut rule, the base trip,
// the raw surge %); testers see the estimates. A code in Settings, not real security.
import { isOwner } from './access.js';
export { isOwner };
// The form can sit in the Formula tab or in the Got a job card, so look it up anywhere.
const $ = (s, root = document) => root.querySelector(s) || document.querySelector(s);
const money = (n) => `S$${Number(n).toFixed(2)}`;
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const signed = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(0)}%`;
const num = (el) => {
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : null;
};
const pad = (n) => String(n).padStart(2, '0');
const offText = (pred, actual) => {
  const off = pred - actual;
  return Math.abs(off) < 0.005 ? 'exact' : `${money(Math.abs(off))} ${off > 0 ? 'high' : 'low'}`;
};

const lab = { trips: [], shared: {}, surge: 'normal', root: null, device: null, syncNote: '', version: 0, cache: null };

// Everyone's trips: yours (on this phone) plus other testers' (from the server). The same array is
// handed out until the trips change (changed()), so the formula, cut and time estimate built from
// it are worked out once per change. Nothing is dropped: it's always every trip.
const changed = () => { lab.version++; };
const dataset = () => {
  if (!lab.cache || lab.cache.version !== lab.version) {
    const mine = new Set(lab.trips.map((t) => t.id));
    // Trips around a listed event are marked, so they're kept apart from normal (formula.js).
    lab.cache = { version: lab.version, trips: markEvents([...lab.trips, ...Object.values(lab.shared).filter((t) => !mine.has(t.id))], eventsList()) };
  }
  return lab.cache.trips;
};
const weights = () => fitWeights(dataset());
// Around events, how fares have run vs normal (Info tab).
export const eventNow = () => eventLift(dataset());
onEventsChange(() => { changed(); if (lab.root) renderAll(); });
const commission = () => fitCommission(dataset());

// ---- the formula dataset on the server ----
const toRow = (t) => ({
  id: t.id, ts: t.ts, km: t.km, min: t.min ?? null, erp: t.erp || 0, paid: t.actual, earned: t.earned ?? null,
  surge: t.surge, predicted: t.predicted ?? null, predicted_earned: t.predictedEarned ?? null,
  card_min: t.cardMin ?? null, pickup_km: t.pickupKm ?? null, lat: t.lat ?? null, lng: t.lng ?? null,
});
const fromRow = (r) => ({
  id: r.id, ts: r.ts, km: r.km, min: r.min ?? null, erp: r.erp || 0, actual: r.paid, earned: r.earned, surge: r.surge,
  predicted: r.predicted, predictedEarned: r.predicted_earned, cardMin: r.card_min ?? null, pickupKm: r.pickup_km ?? null, lat: r.lat ?? null, lng: r.lng ?? null, shared: true,
});
// Surge or airport: the learned % on top of the normal fare (null for normal trips).
const liftFor = (kind, ts) => (kind === 'surge' ? surgeLift(dataset(), ts) : kind === 'airport' ? airportLift(dataset(), ts) : null);

// Trip time used for a prediction: what was typed, or the estimate from the km.
const estimate = () => timeEstimator(withBase(dataset()));
const printOf = (t) => JSON.stringify(toRow(t));

async function post(path, body) {
  const key = await db.getKV('apiKey');
  const headers = { 'content-type': 'application/json', ...(key ? { 'x-fareit-key': key } : {}) };
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let syncing = null;
export function syncLab() {
  if (!lab.device) return Promise.resolve(); // not set up yet: buildLab syncs once it is
  syncQueue();
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      if (!navigator.onLine) throw new Error('offline');
      // deletions waiting from earlier
      const dels = (await db.getKV('formulaDeletes')) || [];
      if (dels.length) {
        const r = await post('/api/formula/delete', { device: lab.device, ids: dels.slice(0, 50) });
        const done = new Set([...(r.deleted || []), ...(r.missing || [])]);
        await db.setKV('formulaDeletes', dels.filter((id) => !done.has(id)));
      }
      // your new or changed trips
      const todo = lab.trips.filter((t) => t.uploaded !== printOf(t));
      for (let i = 0; i < todo.length; i += 50) {
        const batch = todo.slice(i, i + 50);
        const r = await post('/api/formula', { device: lab.device, trips: batch.map(toRow) });
        const seen = new Set([...(r.accepted || []), ...(r.rejected || [])]);
        for (const t of batch) if (seen.has(t.id)) t.uploaded = printOf(t);
      }
      if (todo.length) await db.setKV(KEY, lab.trips);
      // everyone's trips since last time
      let cursor = (await db.getKV('formulaCursor')) || 0;
      for (let page = 0; page < 20; page++) {
        const res = await fetch(`/api/formula?since=${cursor}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        for (const r of data.trips || []) {
          if (r.deleted) delete lab.shared[r.id];
          else lab.shared[r.id] = fromRow(r);
          changed();
        }
        cursor = data.next ?? cursor;
        if (!data.more) break;
      }
      await db.setKV('formulaShared', lab.shared);
      await db.setKV('formulaCursor', cursor);
      const waiting = lab.trips.filter((t) => t.uploaded !== printOf(t)).length;
      lab.syncNote = waiting ? `${waiting} trip${waiting === 1 ? '' : 's'} waiting to upload.` : `Synced at ${new Date().toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', hour12: false })}.`;
    } catch {
      lab.syncNote = 'Couldn’t reach the server. Your trips are kept here and will upload later.';
    } finally {
      syncing = null;
      if (lab.root) renderAll();
    }
  })();
  return syncing;
}

export async function buildLab(root) {
  lab.root = root;
  lab.trips = (await db.getKV(KEY)) || [];
  lab.shared = (await db.getKV('formulaShared')) || {};
  changed();
  lab.device = await db.getKV('device');
  watchLocation();
  onMove(() => renderBands());
  // Trips saved before trip time and card time were split held the job card's total time (which
  // includes the drive to the pickup) as their time. Keep it as card time; trip time unknown.
  let moved = false;
  for (const t of lab.trips) {
    if (t.timeSplit) continue;
    if (t.min > 0 && t.cardMin == null) { t.cardMin = t.min; t.min = null; }
    t.timeSplit = true;
    moved = true;
  }
  if (moved) { changed(); await db.setKV(KEY, lab.trips); }
  root.innerHTML = `
    <div class="card lab-formula" id="lab-formula"></div>

    <div id="lab-form-home"><div id="lab-form" class="stack">
    <div class="row2">
      <div class="field"><label for="lab-km">Trip km (pickup → drop-off)</label>
        <input id="lab-km" type="number" inputmode="decimal" step="0.1" min="0"></div>
      <div class="field"><label for="lab-min">Trip min from pickup</label>
        <input id="lab-min" type="number" inputmode="decimal" step="1" min="0" placeholder="blank = estimate"></div>
    </div>
    <p class="hint">Trip only, from the pickup point: the passenger's price doesn't include your way there. The card's total time includes it, so put that below instead.</p>
    <div class="row2">
      <div class="field"><label for="lab-cardmin">Card total min (optional)</label>
        <input id="lab-cardmin" type="number" inputmode="decimal" step="1" min="0"></div>
      <div class="field"><label for="lab-pickupkm">Km to pickup (optional)</label>
        <input id="lab-pickupkm" type="number" inputmode="decimal" step="0.01" min="0"></div>
    </div>
    <div class="field"><span class="flabel">Pricing</span>
      <div id="lab-surge" class="seg g3">
        <button type="button" data-v="normal">Normal</button>
        <button type="button" data-v="surge">Surge ↑</button>
        <button type="button" data-v="airport">Airport</button>
      </div></div>

    <div class="lab-predict" id="lab-predict" aria-live="polite">
      <div class="lab-two">
        <div><div class="k">Paid by passenger</div><div class="v" id="lab-pred">—</div></div>
        <div><div class="k">You earn</div><div class="v sm" id="lab-pred-earn">—</div></div>
      </div>
      <div class="s" id="lab-pred-sub">Type the distance and time.</div>
      <div class="s" id="lab-tod"></div>
      <div class="s surge-est" id="lab-surge-est"></div>
    </div>

    <div class="row2">
      <div class="field"><label for="lab-actual">Paid by passenger, actual (S$)</label>
        <input id="lab-actual" type="number" inputmode="decimal" step="0.01" min="0"></div>
      <div class="field"><label for="lab-earned">You earned, actual (S$)</label>
        <input id="lab-earned" type="number" inputmode="decimal" step="0.01" min="0"></div>
    </div>
    <div class="lab-check" id="lab-check"></div>
    <p class="msg" id="lab-msg" role="status"></p>
    <div class="row2">
      <button type="button" class="primary" id="lab-save">Save trip</button>
      <button type="button" class="ghost" id="lab-clear">Clear</button>
    </div>
    </div></div>


    <h2>How close it's getting</h2>
    <div id="lab-stats"></div>
    <h2>By time of day</h2>
    <div id="lab-tod-table"></div>
    <h2 id="lab-cut-h">Grab's cut</h2>
    <div id="lab-cut"></div>
    <h2>Your trips</h2>
    <p class="note" id="lab-sync"></p>
    <div id="lab-list" class="stack"></div>
    <button type="button" class="ghost wide" id="lab-export">Export CSV</button>`;

  for (const id of ['lab-km', 'lab-min', 'lab-cardmin', 'lab-pickupkm', 'lab-actual', 'lab-earned']) $(`#${id}`, root).addEventListener('input', update);
  for (const b of root.querySelectorAll('#lab-surge button')) {
    b.addEventListener('click', () => { lab.surge = b.dataset.v; update(); });
  }
  $('#lab-save', root).addEventListener('click', save);
  $('#lab-clear', root).addEventListener('click', () => { lab.pending = null; clearForm(); });
  document.querySelector('#got-job')?.addEventListener('click', openJob);
  document.querySelector('#job-close')?.addEventListener('click', closeJob);
  $('#lab-export', root).addEventListener('click', exportCsv);
  renderAll();
  syncLab();
  const rq = document.querySelector('#radar-queue');
  if (rq) buildQueue(rq);
  loadEvents();
}

// ---- Beta Window: earnings by distance band ----
function latestLine(now) {
  const j = latestJob(dataset(), now);
  if (!j) return '';
  const t = j.trip;
  const d = new Date(t.ts);
  const mins = Math.round((now - t.ts) / 60000);
  const where = t.lat && t.lng ? areaName({ lat: t.lat, lng: t.lng }) : null;
  const cls = j.vs >= 0.1 ? 'good' : j.vs <= -0.1 ? 'bad' : '';
  return `<div class="band-latest ${cls}">Latest job · ${pad(d.getHours())}:${pad(d.getMinutes())} (${mins} min ago)${where ? ` · ${where}` : ''}${t.shared ? ' · another driver' : ''}${t.event ? ` · ${t.eventName || 'event'}` : ''}: ${t.km} km, earned <b>${money(j.earned)}</b> (${signed(j.vs)} vs normal)</div>`;
}

// The planning area for where the phone is, looked up once per ~1 km and kept for the session.
const areaCache = {};
function areaName(p) {
  if (!p) return null;
  const key = `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
  if (key in areaCache) return areaCache[key];
  areaCache[key] = null;
  fetch(`/api/area?at=${key}`).then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (d && d.area) { areaCache[key] = d.area; renderBands(); }
  }).catch(() => {});
  return null;
}

export function renderBands() {
  const box = document.querySelector('#band-cards');
  if (!box) return;
  const now = Date.now();
  const loc = here();
  // At Changi there's no 8-second window (jobs are auto-accepted), so Radar shows the queue
  // (above, from queue.js) and arrivals by terminal instead of the earnings cards.
  // Likely surging within 3 km (2+ drivers in the last 30 min): first thing on Radar.
  loadSurge(renderBands);
  const surgeBox = document.querySelector('#radar-surge');
  if (surgeBox) {
    const s = surgeNow();
    surgeBox.hidden = !s;
    if (s) surgeBox.innerHTML = surgeBanner(s, areaName({ lat: Math.round(s.lat * 100) / 100, lng: Math.round(s.lng * 100) / 100 }), now);
  }
  // Near Woodlands or a JB bus drop-off: what's arriving next, at the top, to decide whether to
  // head there or wait. (Ferry terminals next, once there's a timetable for them.)
  const placeBox = document.querySelector('#radar-place');
  if (placeBox) {
    // Only what's immediately next, and only within the hour; nothing coming -> nothing shown.
    const pl = jbPlace(loc);
    const ferry = pl ? null : ferryTerminalAt(loc);
    const rows = pl ? jbRowsHtml(new Date(now), pl) : ferry ? ferryRowsHtml(ferry.id, new Date(now), { compact: true }) : '';
    placeBox.hidden = !rows;
    if (rows) placeBox.innerHTML = pl
      ? `<div class="band-head">Next from JB · ${pl.at === 'woodlands' ? 'out at Woodlands' : `at ${pl.name}`} (est.)</div>${rows}`
      : `<div class="band-head">Next ferry into ${ferry.short}</div>${rows}`;
  }
  const airport = atAirport(loc);
  const ap = document.querySelector('#ap-flights');
  if (ap) {
    ap.hidden = !airport;
    if (airport) renderFlights(ap, renderBands);
  }
  box.hidden = airport;
  if (airport) return;
  const bands = bandOutlook(dataset(), now, loc);
  const h = new Date(now);
  const at = `${pad(h.getHours())}:${pad(h.getMinutes())}`;
  const place = loc ? (areaName(loc) || 'your area') : null;
  // What "now" is leaning on: every trip counts by closeness in time, place and recency.
  const b0 = bands[0];
  const cl = b0.closest;
  const clText = cl
    ? `closest is ${(() => { const d = new Date(cl.ts); return `a ${pad(d.getHours())}:${pad(d.getMinutes())} trip`; })()}${cl.km != null ? `, ${cl.km < 1 ? 'under 1' : Math.round(cl.km)} km away` : ''}`
    : '';
  const basis = !cl
    ? 'No trips yet, so "now" equals normal.'
    : b0.scope === 'here'
      ? `From all trips, closest counting most: ${b0.nearHour} within 3 km and 1½ h of now; ${clText}.`
      : `Nothing within 3 km and 1½ h yet, so leaning on the closest available: ${clText}.`;
  const word = { good: 'Above normal', normal: 'Normal', bad: 'Below normal' };
  box.innerHTML = `
    <div class="band-head">What you'd earn now · ${place ? `${place} · ` : ''}${at}</div>
    <div class="band-basis">${loc ? '' : 'Location off: using all areas. '}${basis}</div>
    ${latestLine(now)}
    ${bands.map((b) => `
      <div class="band-card ${b.state}">
        <div class="band-top"><span class="band-name">${b.label}</span><span class="band-tag">${word[b.state]}${b.state !== 'normal' ? ` ${signed(b.vs)}` : ''}</span></div>
        <div class="band-now">${money(b.now)}</div>
        <div class="band-sub">Normal ${money(b.normal)} · Surge ${money(b.surge)} <span class="band-km">(about ${Math.round(b.km)} km)</span></div>
        <div class="band-km">${b.inBandNear ? `From ${b.inBandNear} trip${b.inBandNear === 1 ? '' : 's'} in this range${loc ? ' near you' : ''} around this hour.` : 'No trips in this range near now: following the overall picture.'}</div>
      </div>`).join('')}
    <button type="button" class="ghost surge-report" id="surge-report">↑ Seeing surge here? Tap to tell other drivers</button>
    <p class="note" id="surge-report-msg" role="status"></p>
    <p class="note band-note">Grey: normal for now. Green: fares here at this hour have been running 10% or more above normal. Red: 10% or more below. Learns from every trip saved, from Got a job or the Est. tab.</p>`;
  const rb = box.querySelector('#surge-report');
  if (rb) rb.addEventListener('click', async () => {
    const msg = box.querySelector('#surge-report-msg');
    rb.disabled = true;
    try {
      await reportSurge(lab.device || (await db.getKV('device')));
      msg.classList.remove('err');
      msg.textContent = 'Thanks. Drivers within 3 km see it once another driver confirms (counts for 30 min).';
      loadSurge(() => {}, true);
    } catch (e) { msg.textContent = e.message; msg.classList.add('err'); }
    rb.disabled = false;
  });
}
setInterval(() => { if (lab.root) renderBands(); }, 60 * 1000);

function renderAll() {
  renderBands();
  renderFormula();
  update();
  renderStats();
  renderTimeTable();
  renderList();
}

function renderFormula() {
  const card = $('#lab-formula', lab.root);
  card.hidden = !isOwner();
  if (card.hidden) return;
  const w = weights();
  const learned = w.n - BASE_TRIPS.length;
  const others = Object.keys(lab.shared).filter((id) => !lab.trips.some((t) => t.id === id)).length;
  const basis = learned > 0
    ? `Fitted from the base trip and ${learned} normal trip${learned === 1 ? '' : 's'}${others ? ` (${others} trip${others === 1 ? '' : 's'} from other drivers in the dataset)` : ''}.`
    : 'From the base trip only (11.58 km, paid S$16.80): it sets the level, more trips sort out the split.';
  $('#lab-formula', lab.root).innerHTML = `
    <div class="k">Grab's published formula (Standard, normal pricing)</div>
    <div class="f">Paid by passenger = max(<b>${money(MIN_PASSENGER)}</b>, <b>${money(w.base)}</b> + <b>${money(w.perKm)}</b> × km + <b>${money(w.perMin)}</b> × min)</div>
    <div class="f">You earn = max(<b>${money(MIN_DRIVER)}</b>, ${(() => { const c = commission(); return c.kind === 'percent+fixed' ? `<b>${(c.keep * 100).toFixed(1)}%</b> × paid ${c.fixed < 0 ? '−' : '+'} <b>${money(Math.abs(c.fixed))}</b>` : `<b>${(c.keep * 100).toFixed(1)}%</b> × paid`; })()})</div>
    <div class="s">${basis} Weights update every time you save a trip.</div>`;
}

function readForm() {
  const r = lab.root;
  return {
    km: num($('#lab-km', r)), min: num($('#lab-min', r)), erp: 0, // ERP is added after the trip starts, not on the job card
    cardMin: num($('#lab-cardmin', r)), pickupKm: num($('#lab-pickupkm', r)), timeSplit: true,
    ts: lab.pending ? lab.pending.ts : Date.now(), // when you tapped Got a job, else when you save
    actual: num($('#lab-actual', r)), earned: num($('#lab-earned', r)), surge: lab.surge,
  };
}

// Live: the predicted fare and earnings appear as soon as distance and time are in.
function update() {
  const r = lab.root;
  for (const b of r.querySelectorAll('#lab-surge button')) b.classList.toggle('sel', b.dataset.v === lab.surge);
  const f = readForm();
  const pred = $('#lab-pred', r);
  const predEarn = $('#lab-pred-earn', r);
  const sub = $('#lab-pred-sub', r);
  const tod = $('#lab-tod', r);
  const check = $('#lab-check', r);
  if (!(f.km > 0)) {
    pred.textContent = '—';
    predEarn.textContent = '—';
    sub.textContent = 'Type the trip km (and trip minutes if you have them).';
    tod.textContent = '';
    check.innerHTML = '';
    $('#lab-predict', r).className = 'lab-predict';
    return;
  }
  const mins = f.min > 0 ? f.min : estimate()(f.km);
  const p = passengerFare(weights(), f.km, mins, f.erp);
  const c = commission();
  const normalEarn = driverEarns(c, p.fare, f.erp);
  // Surge pressed: normal-price fare plus the learned surge % (starting at +20%).
  const sl = liftFor(f.surge, f.ts);
  const shown = sl ? Math.round(p.fare * (1 + sl.lift) * 100) / 100 : p.fare;
  const earn = sl ? driverEarns(c, shown, f.erp) : normalEarn;
  pred.textContent = money(shown);
  predEarn.textContent = money(earn);
  const cutLabel = c.kind === 'percent+fixed' ? `Grab keeps ${pct(1 - c.keep)} + ${money(-c.fixed)}` : `Grab keeps ${pct(1 - c.keep)}${c.n < 3 ? `, from ${c.n} trip${c.n === 1 ? '' : 's'}` : ''}`;
  sub.textContent = `${p.atMinimum ? 'Minimum fare applies. ' : ''}${f.min > 0 ? '' : `Trip time estimated: ${Math.round(mins)} min. `}${isOwner() ? `Normal-price formula. ${cutLabel}.` : 'Normal price, no surge.'}`;
  const surgeEl = $('#lab-surge-est', r);
  const kindName = f.surge === 'airport' ? 'airport' : 'surge';
  const startText = f.surge === 'airport' ? 'No airport trips yet, so no difference is assumed: each airport trip you save shows whether they\'re priced differently.' : 'The +20% is a starting guess: each surge trip you save adjusts it.';
  surgeEl.innerHTML = sl && !isOwner()
    ? `${f.surge === 'airport' ? 'Airport' : 'Surge'} estimate: <b>${money(shown)}</b> (normal ${money(p.fare)}). ${sl.guess ? 'A starting guess for now: it learns from every ' + kindName + ' trip saved.' : `Learned from ${sl.n} ${kindName} trip${sl.n === 1 ? '' : 's'}.`}`
    : sl
    ? `${f.surge === 'airport' ? 'Airport' : 'Surge'}: normal fare <b>${money(p.fare)}</b> ${signed(sl.lift)} = <b>${money(shown)}</b>. ${sl.guess ? startText : `Learned from ${sl.n} ${kindName} trip${sl.n === 1 ? '' : 's'}${sl.near ? `, ${sl.near} around this hour` : ''}; adjusts with every ${kindName} trip.`}`
    : '';

  // Time of day: how fares near this hour have run against the formula (surge-prone hours).
  const t = timeOfDay(dataset(), f.ts);
  const h = new Date(f.ts);
  const at = `${pad(h.getHours())}:${pad(h.getMinutes())}`;
  if (t.near === 0) {
    tod.textContent = `Around ${at}: no trips near this hour yet.`;
  } else {
    const likely = Math.round(p.fare * (1 + t.lift) * 100) / 100;
    tod.textContent = `Around ${at}: fares have run ${signed(t.lift)} vs normal (${t.near} trip${t.near === 1 ? '' : 's'} within 1½ h${t.surgeNear ? `, ${t.surgeNear} surge` : ''}). With that, about ${money(likely)}.`;
  }
  // The prediction card in the Window's colours: green for surge or a busy hour (10%+ above
  // normal), red for a slow hour (10%+ below), grey otherwise.
  const hourLift = t.near ? t.lift : 0;
  const mood = f.surge === 'surge' || hourLift >= 0.1 ? 'good' : hourLift <= -0.1 ? 'bad' : 'normal';
  $('#lab-predict', r).className = `lab-predict ${mood}`;

  // Formula vs actual, in words: Close (within 5%), Off (5–15%), Far off (over 15%).
  const rows = [];
  const row = (label, formula, actual) => {
    const off = formula - actual;
    const rel = Math.abs(off) / actual;
    const grade = rel <= 0.05 ? ['close', 'Close'] : rel <= 0.15 ? ['off', 'Off'] : ['far', 'Far off'];
    const diff = Math.abs(off) < 0.005 ? 'Exact' : `${money(Math.abs(off))} too ${off > 0 ? 'high' : 'low'} (${(rel * 100).toFixed(0)}%)`;
    rows.push(`<div class="r ${grade[0]}"><span class="l">${label}</span><span>${money(formula)}</span><span>${money(actual)}</span><span class="d ${grade[0]}">${diff}<b>${grade[1]}</b></span></div>`);
  };
  if (f.actual > 0) row('Passenger paid', shown, f.actual);
  if (f.earned > 0) row('You earned', earn, f.earned);
  if (!rows.length) { check.innerHTML = ''; return; }
  // Marked normal but well above the normal formula: maybe untagged surge.
  let hint = '';
  if (f.actual > 0 && f.surge === 'normal') {
    const above = (f.actual - p.fare) / p.fare;
    if (above >= SURGE_HINT) {
      hint = `<div class="surge-hint">This paid <b>${(above * 100).toFixed(0)}% above</b> the normal estimate. Did the job card show the green ↑? If not, keep it Normal: it'll count as a busy time or area instead.
        <button type="button" class="ghost small" data-act="mark-surge">Mark as surge</button></div>`;
    }
  }
  let kept = '';
  if (f.actual > 0 && f.earned > 0) {
    const cut = cutOf(f);
    kept = `<div class="kept">Grab kept <b>${money(cut.cut)}</b> (${pct(cut.rate)} of what the passenger paid).${cut.rate < 0.15 ? ' <b>Low-cut trip:</b> counted separately, not in the usual rule.' : ''}</div>`;
  }
  check.innerHTML = `
    <div class="cmp">
      <div class="r h"><span></span><span>Estimate</span><span>Actual</span><span>Difference</span></div>
      ${rows.join('')}
    </div>${kept}
    <div class="key"><span class="close">Close</span> within 5% · <span class="off">Off</span> 5–15% · <span class="far">Far off</span> over 15%</div>${hint}`;
  const mark = check.querySelector('[data-act="mark-surge"]');
  if (mark) mark.addEventListener('click', () => { lab.surge = 'surge'; update(); });
}

async function save() {
  const f = readForm();
  const msg = $('#lab-msg', lab.root);
  if (!(f.km > 0)) { msg.textContent = 'Add the trip km.'; msg.classList.add('err'); return; }
  if (!(f.actual > 0)) { msg.textContent = 'Add what the passenger actually paid.'; msg.classList.add('err'); return; }
  // Predictions are recorded before this trip changes anything: an honest test each time.
  const w = weights();
  const normalFare = passengerFare(w, f.km, f.min > 0 ? f.min : estimate()(f.km), f.erp).fare;
  // A surge trip's prediction is the normal fare plus the surge % it was shown: the honest test
  // of the surge estimate. The normal-price figure is kept too.
  const sl = liftFor(f.surge, f.ts);
  const predicted = sl ? Math.round(normalFare * (1 + sl.lift) * 100) / 100 : normalFare;
  const c = commission();
  const predictedEarned = driverEarns(c, predicted, f.erp);
  const t = timeOfDay(dataset(), f.ts);
  changed();
  lab.trips.push({
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...f,
    // Where the phone was (about 1 km): on Got a job, near the pickup; otherwise on Save.
    ...((lab.pending && lab.pending.loc) || rounded(here()) || {}),
    predicted, predictedEarned, predictedNormal: normalFare, surgeLiftUsed: sl ? sl.lift : null, todLift: t.near ? t.lift : null,
    weightsBefore: { base: w.base, perKm: w.perKm, perMin: w.perMin },
  });
  await db.setKV(KEY, lab.trips);
  syncLab();
  msg.classList.remove('err');
  msg.textContent = `Saved. Paid: estimate ${money(predicted)} vs ${money(f.actual)} (${offText(predicted, f.actual)}).${f.earned > 0 ? ` Earned: ${money(predictedEarned)} vs ${money(f.earned)} (${offText(predictedEarned, f.earned)}).` : ''} Estimates updated.`;
  lab.pending = null;
  clearForm(true);
  renderAll();
}

// ---- Got a job (beta Window) ----
// A quick card: the trip km and what you'll earn, as the job card shows them. Tapping notes the
// time and where you are (about 1 km, near the pickup). Saved, it updates the Window straight
// away: the latest job, and "now" on the cards. Quick entries have no passenger fare, so they
// don't touch the formula or Grab's cut; full trips still go in the Formula tab.
const jobOpen = () => { const s = document.querySelector('#job-sheet'); return Boolean(s && !s.hidden); };
const quick = { surge: 'normal', route: null, seq: 0, timer: null };

function buildQuick() {
  const body = document.querySelector('#job-body');
  if (!body || body.dataset.built) return;
  body.dataset.built = '1';
  body.innerHTML = `
    <div class="row2">
      <div class="field"><label for="qj-km">Trip km or drop-off</label>
        <input id="qj-km" type="text" autocomplete="off" autocapitalize="words" placeholder="21, Tampines, 521111…"></div>
      <div class="field"><label for="qj-earned">You'll earn (S$)</label>
        <input id="qj-earned" type="number" inputmode="decimal" step="0.01" min="0"></div>
    </div>
    <div id="qj-surge" class="seg g3">
      <button type="button" data-v="normal">Normal</button>
      <button type="button" data-v="surge">Surge ↑</button>
      <button type="button" data-v="airport">Airport</button>
    </div>
    <div class="lab-check" id="qj-check"></div>
    <p class="msg" id="qj-msg" role="status"></p>
    <button type="button" class="primary wide" id="qj-save">Save job</button>
    <p class="note">Only km and earnings: this updates Radar now. To also sharpen the estimates, add the passenger fare in the Est. tab.</p>`;
  body.querySelector('#qj-km').addEventListener('input', onTripInput);
  body.querySelector('#qj-earned').addEventListener('input', quickUpdate);
  for (const b of body.querySelectorAll('#qj-surge button')) b.addEventListener('click', () => { quick.surge = b.dataset.v; quickUpdate(); });
  body.querySelector('#qj-save').addEventListener('click', quickSave);
}

// The trip box takes a km figure, or a drop-off (area, postal code or address): the road
// distance is then worked out on OneMap from where you were when you tapped Got a job.
const kmTyped = (text) => {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t) || isPostal(t)) return null;
  const v = parseFloat(t);
  return v > 0 && v <= 150 ? v : null;
};

function onTripInput() {
  const text = document.querySelector('#qj-km').value.trim();
  clearTimeout(quick.timer);
  quick.route = null;
  if (!text || kmTyped(text) !== null || text.length < 3) { quickUpdate(); return; }
  quick.route = { text, pending: true };
  quickUpdate();
  quick.timer = setTimeout(() => routeTo(text), 500);
}

async function routeTo(text) {
  const mine = ++quick.seq;
  const done = (r) => { if (mine === quick.seq) { quick.route = { text, ...r }; quickUpdate(); } };
  const from = (lab.pending && lab.pending.precise) || here();
  if (!from) { done({ error: 'Need your location to work out the distance. Type the km instead.' }); return; }
  try {
    let dest = findArea(text);
    if (!dest) {
      const res = await fetch(`/api/search?q=${encodeURIComponent(text)}`);
      const data = res.ok ? await res.json() : null;
      const r = data && data.results && data.results[0];
      if (!r) { done({ error: `Couldn't find “${text}”. Try a postal code or an area name.` }); return; }
      dest = { label: r.label, lat: r.lat, lng: r.lng };
    }
    const res = await fetch(`/api/route?from=${from.lat.toFixed(5)},${from.lng.toFixed(5)}&to=${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}`);
    const route = res.ok ? await res.json() : null;
    if (!route || !(route.km > 0)) { done({ error: 'Couldn\'t get the road distance right now. Type the km instead.' }); return; }
    done({ label: dest.label, km: route.km, min: route.min });
  } catch {
    done({ error: 'Couldn\'t reach the map. Type the km instead.' });
  }
}

function quickRead() {
  const n = (id) => { const v = parseFloat(document.querySelector(id).value); return Number.isFinite(v) ? v : null; };
  const text = document.querySelector('#qj-km').value.trim();
  const typed = kmTyped(text);
  const r = quick.route;
  const km = typed ?? (r && r.km > 0 ? r.km : null);
  return { km, drop: typed === null && r && r.km > 0 ? r.label : null, earned: n('#qj-earned'), surge: quick.surge };
}

function quickUpdate() {
  for (const b of document.querySelectorAll('#qj-surge button')) b.classList.toggle('sel', b.dataset.v === quick.surge);
  const f = quickRead();
  const box = document.querySelector('#qj-check');
  const r = quick.route;
  const routeLine = r
    ? `<div class="kept">${r.pending ? `Finding “${r.text}” on the map…` : r.error ? r.error : `→ ${r.label} · <b>${r.km} km</b>, about ${Math.round(r.min)} min by road from where you got the job.`}</div>`
    : '';
  if (!(f.km > 0)) { box.innerHTML = routeLine; return; }
  const est = estimate();
  const normalPaid = passengerFare(weights(), f.km, est(f.km)).fare;
  const normal = driverEarns(commission(), normalPaid);
  if (!(f.earned > 0)) { box.innerHTML = `${routeLine}<div class="kept">Normal for ${f.km} km: you'd earn about <b>${money(normal)}</b>.</div>`; return; }
  const vs = f.earned / normal - 1;
  const cls = vs >= 0.1 ? 'close' : vs <= -0.1 ? 'far' : '';
  box.innerHTML = `${routeLine}<div class="kept">Normal for ${f.km} km: about <b>${money(normal)}</b>. This job: <b class="${cls}">${money(f.earned)} (${signed(vs)})</b>.</div>`;
}

async function quickSave() {
  const f = quickRead();
  const msg = document.querySelector('#qj-msg');
  if (!(f.km > 0) || !(f.earned > 0)) {
    msg.textContent = quick.route && quick.route.pending ? 'Still working out the distance…' : 'Add the trip km (or drop-off) and what you\'ll earn.';
    msg.classList.add('err');
    return;
  }
  const est = estimate();
  const normalPaid = passengerFare(weights(), f.km, est(f.km)).fare;
  changed();
  lab.trips.push({
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, quick: true,
    ts: lab.pending ? lab.pending.ts : Date.now(), km: f.km, min: null, erp: 0, actual: null, earned: f.earned, surge: f.surge,
    ...((lab.pending && lab.pending.loc) || rounded(here()) || {}),
    predicted: null, predictedEarned: driverEarns(commission(), normalPaid), timeSplit: true,
    ...(f.drop ? { dropLabel: f.drop, kmSource: 'map' } : {}), // drop-off name stays on this phone
  });
  await db.setKV(KEY, lab.trips);
  const saved = lab.pending ? new Date(lab.pending.ts) : new Date();
  lab.pending = null;
  msg.classList.remove('err');
  for (const id of ['#qj-km', '#qj-earned']) document.querySelector(id).value = '';
  quick.surge = 'normal';
  quick.route = null;
  closeJob();
  const note = document.querySelector('#got-job-msg');
  if (note) note.textContent = `Saved the ${pad(saved.getHours())}:${pad(saved.getMinutes())} job: ${f.km} km${f.drop ? ` to ${f.drop}` : ''}, ${money(f.earned)}.`;
  renderAll();
  syncLab();
}

export function openJob() {
  const sheet = document.querySelector('#job-sheet');
  if (!sheet) return;
  // In the airport queue: the job ends the wait, so record it now.
  if (!lab.pending) closeOpenReading().catch(() => {});
  buildQuick();
  // precise stays on the phone (for working out the distance); only loc (about 1 km) is uploaded.
  if (!lab.pending) lab.pending = { ts: Date.now(), loc: rounded(here()), precise: here() };
  const d = new Date(lab.pending.ts);
  const where = lab.pending.loc ? areaName(lab.pending.loc) : null;
  document.querySelector('#job-when').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}${where ? ` · ${where}` : ''}`;
  sheet.hidden = false;
  document.body.classList.add('sheet-open');
  const note = document.querySelector('#got-job-msg');
  if (note) note.textContent = '';
  // At the airport every job is an airport job: start on Airport (it can still be changed).
  if (atAirport(here()) && quick.surge === 'normal') quick.surge = 'airport';
  quickUpdate();
  setTimeout(() => document.querySelector('#qj-km')?.focus(), 50);
}

export function closeJob() {
  const sheet = document.querySelector('#job-sheet');
  if (!sheet) return;
  sheet.hidden = true;
  document.body.classList.remove('sheet-open');
  const note = document.querySelector('#got-job-msg');
  if (note && lab.pending) {
    const d = new Date(lab.pending.ts);
    note.textContent = `Job at ${pad(d.getHours())}:${pad(d.getMinutes())} not saved yet. Tap Got a job to carry on.`;
  }
}

function clearForm(keepMsg) {
  for (const id of ['lab-km', 'lab-min', 'lab-cardmin', 'lab-pickupkm', 'lab-actual', 'lab-earned']) $(`#${id}`, lab.root).value = '';
  lab.surge = 'normal';
  if (keepMsg !== true) $('#lab-msg', lab.root).textContent = '';
  update();
}

const avg = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;

function renderStats() {
  const box = $('#lab-stats', lab.root);
  const normal = dataset().filter((t) => t.surge === 'normal' && t.actual > 0 && t.predicted > 0).sort((a, b) => a.ts - b.ts);
  if (!normal.length) { box.innerHTML = '<p class="note">Save a few normal trips. Each one is estimated before it is learned from, so this shows how close the estimates are getting.</p>'; return; }
  const offs = normal.map((t) => Math.abs(t.predicted - t.actual));
  const last5 = offs.slice(-5);
  const earnOffs = normal.filter((t) => t.earned > 0 && t.predictedEarned > 0).map((t) => Math.abs(t.predictedEarned - t.earned));
  const earnLast5 = earnOffs.slice(-5);
  const loo = looError(dataset());
  const surgeTrips = dataset().filter((t) => t.surge === 'surge' && t.actual > 0 && t.predicted > 0).sort((a, b) => a.ts - b.ts);
  const surgeOffs = surgeTrips.slice(-5).map((t) => Math.abs(t.predicted - t.actual));
  const surgeNow = surgeLift(dataset(), Date.now());
  const airportTrips = dataset().filter((t) => t.surge === 'airport' && t.actual > 0 && t.predicted > 0).sort((a, b) => a.ts - b.ts);
  const airportOffs = airportTrips.slice(-5).map((t) => Math.abs(t.predicted - t.actual));
  const airportNow = airportLift(dataset(), Date.now());
  box.innerHTML = `
    <div class="tiles">
      <div class="tile"><span class="v">${money(avg(last5))}</span><span class="k">Paid: off on the last ${last5.length} (predicted before saving)</span></div>
      <div class="tile"><span class="v">${earnLast5.length ? money(avg(earnLast5)) : '—'}</span><span class="k">Earned: off on the last ${earnLast5.length || ''} (predicted before saving)</span></div>
      <div class="tile"><span class="v">${loo ? money(loo.avg) : '—'}</span><span class="k">Paid: off with today's estimate${loo ? ` (${pct(loo.pct)})` : ''}</span></div>
      <div class="tile"><span class="v">${normal.filter((t, i) => offs[i] <= 0.1).length} / ${normal.length}</span><span class="k">Paid within 10 cents</span></div>
    </div>
    <p class="note">${(() => { const q = dataset().filter((t) => t.quick).length; const full = dataset().filter((t) => t.actual > 0).length; return `${full} trip${full === 1 ? '' : 's'} with the passenger fare (they sharpen the estimates)${q ? `, ${q} quick Got a job entr${q === 1 ? 'y' : 'ies'} (earnings only: they feed "now" on Radar)` : ''}.`; })()}</p>
    <p class="note">"Off with today's estimate" estimates each trip from all the others: the honest test of the estimates as they stand. Normal trips from every driver.</p>
    <p class="note"><b>Surge:</b> ${surgeTrips.length ? `off by ${money(avg(surgeOffs))} on the last ${surgeOffs.length} surge trip${surgeOffs.length === 1 ? '' : 's'} (normal fare + surge %, predicted before saving). ` : ''}Surge % now ${signed(surgeNow.lift)}${surgeNow.guess ? ' (starting guess; no surge trips yet)' : `, learned from ${surgeNow.n} surge trip${surgeNow.n === 1 ? '' : 's'}`}.</p>
    <p class="note"><b>Airport:</b> ${airportNow.guess ? 'no airport trips yet.' : `airport trips ran ${signed(airportNow.lift)} vs normal, from ${airportNow.n} trip${airportNow.n === 1 ? '' : 's'}${airportOffs.length ? `; off by ${money(avg(airportOffs))} on the last ${airportOffs.length}` : ''}.`}</p>`;
}

// Fares vs the normal-price formula by 3-hour block: where surge-prone hours show up.
function renderTimeTable() {
  const box = $('#lab-tod-table', lab.root);
  const rows = byTimeBlock(dataset()).filter((b) => b.n);
  box.innerHTML = `
    <p class="note">How real fares ran against normal prices, by time of day. Surge trips are included, so busy hours show up here.</p>
    <div class="lab-table">${rows.map((b) => `
      <div class="row"><span>${pad(b.from)}:00–${pad(b.to % 24)}:00</span><span class="${b.lift > 0.05 ? 'up' : b.lift < -0.05 ? 'down' : ''}">${signed(b.lift)}</span><span>${b.n} trip${b.n === 1 ? '' : 's'}${b.surge ? `, ${b.surge} surge` : ''}</span></div>`).join('')}
    </div>`;
}

function renderCut() {
  const box = $('#lab-cut', lab.root);
  box.hidden = !isOwner();
  const head = $('#lab-cut-h', lab.root);
  if (head) head.hidden = box.hidden;
  if (box.hidden) return;
  const c = commission();
  const verdict = c.kind === 'flat'
    ? `Looks like a flat <b>${pct(c.avgRate)}</b> of what the passenger paid.`
    : c.kind === 'percent+fixed'
      ? `Looks like <b>${pct(1 - c.keep)}</b> plus <b>${money(-c.fixed)}</b> per job.`
      : `<b>${pct(c.avgRate)}</b> of what the passenger paid so far${c.n === 1 ? ' (base trip: S$4.70 of S$16.80)' : ''}. 3 trips will show whether it's a flat % or not.`;
  const range = c.n > 1 ? (c.spread < 0.001 ? ` The same on all ${c.n} trips.` : ` Across ${c.n} trips it ranged ${pct(c.lo)}–${pct(c.hi)}.`) : '';
  const hm = (ts) => new Date(ts).toLocaleString('en-SG', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const low = c.low.length
    ? `<p class="note"><b>Low-cut trips: ${c.low.length}</b> (Grab kept under 15%, left out of the usual rule): ${c.low.map((t) => `${hm(t.ts)}, ${t.km} km, kept ${money(cutOf(t).cut)} of ${money(t.actual)}`).join('; ')}.</p>`
    : '';
  box.innerHTML = `<p class="note">${verdict}${range}</p>${low}`;
}

function renderList() {
  renderCut();
  $('#lab-sync', lab.root).textContent = lab.syncNote || 'Your trips upload so every driver\'s estimates learn from them.';
  const box = $('#lab-list', lab.root);
  box.innerHTML = lab.trips.length ? '' : '<p class="empty">No trips of yours yet.</p>';
  for (const t of [...lab.trips].reverse()) {
    const cut = cutOf(t);
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="line1"><span class="when">${new Date(t.ts).toLocaleString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</span><span class="when">${money(t.actual)}</span></div>
      <div class="meta">${t.km} km · ${t.min > 0 ? `${t.min} min trip` : 'trip time not known'}${t.cardMin ? ` · card total ${t.cardMin} min` : ''}${t.pickupKm ? ` · ${t.pickupKm} km to pickup` : ''}${t.erp ? ` · ERP ${money(t.erp)}` : ''}${t.surge === 'surge' ? ' · Surge' : t.surge === 'airport' ? ' · Airport' : ''}</div>
      <div class="meta">${t.quick ? `Quick entry from Got a job: earned ${money(t.earned)}${t.predictedEarned ? ` (normal about ${money(t.predictedEarned)})` : ''}. Add the passenger fare in a full entry to sharpen the estimates.` : ''}${t.quick ? '' : `Paid: estimate said ${money(t.predicted)} (${offText(t.predicted, t.actual)})`}${!t.quick && t.earned > 0 ? ` · Earned ${money(t.earned)}${t.predictedEarned ? `, predicted ${money(t.predictedEarned)} (${offText(t.predictedEarned, t.earned)})` : ''}` : ''}${cut ? ` · Grab kept ${pct(cut.rate)}${cut.rate < 0.15 ? ' (low-cut trip)' : ''}` : ''}</div>`;
    const acts = document.createElement('div');
    acts.className = 'acts';
    let armed = false;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost small danger';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!armed) { armed = true; del.textContent = 'Tap again to delete'; setTimeout(() => { armed = false; del.textContent = 'Delete'; }, 4000); return; }
      lab.trips = lab.trips.filter((x) => x.id !== t.id);
      delete lab.shared[t.id];
      changed();
      await db.setKV(KEY, lab.trips);
      await db.setKV('formulaShared', lab.shared);
      const dels = (await db.getKV('formulaDeletes')) || [];
      if (!dels.includes(t.id)) await db.setKV('formulaDeletes', [...dels, t.id]);
      renderAll();
      syncLab();
    });
    acts.append(del);
    card.append(acts);
    box.append(card);
  }
  if (isOwner()) box.append(baseCard());
  const exp = $('#lab-export', lab.root);
  if (exp) exp.hidden = !isOwner();
}

// The built-in base trip, listed last so it's clear where the starting weights came from.
function baseCard() {
  const t = BASE_TRIPS[0];
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="line1"><span class="when">Base trip (built in), ~01:30</span><span class="when">${money(t.actual)}</span></div>
    <div class="meta">${t.km} km · ${t.min} min (OneMap) · earned ${money(t.earned)}, Grab kept ${money(cutOf(t).cut)}</div>
    <div class="meta">${t.note}</div>`;
  return card;
}

async function exportCsv() {
  const name = `agaration-trips-${new Date().toISOString().slice(0, 10)}.csv`;
  const file = new File([toCsv(dataset())], name, { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch { /* fall back to download */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
