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
import { plausible, isOutlier } from './sanity.js';
import { ferryTerminalAt, ferryRowsHtml } from './ferries.js';
import { loadSurge, surgeNow, surgeBanner } from './surge.js';
import { loadRain, rainNow, rainBanner, rainTagNow, isThunder } from './rain.js';
import { loadAlerts, alertsHtml } from './alerts.js';
import { watchLocation, here, rounded, onMove, atAirport } from './where.js';
import { findArea, isPostal } from './places.js';
import {
  passengerFare, fitWeights, looError, fitCommission, driverEarns, cutOf, toCsv, timeOfDay, byTimeBlock, timeEstimator, withBase, surgeLift, airportLift, SURGE_HINT, bandOutlook, latestJob, isSurgeTrip, SURGE_BY_PRICE, SURGE_PRICE_MIN, arrowCompare,
  markEvents, eventLift, eventFor, eventNear, rainLift, usePlatform, platformOf, PLATFORMS, tadaFee, tadaFuel,
  MIN_PASSENGER, MIN_DRIVER, BASE_TRIPS,
} from './formula.js';

const KEY = 'formulaLab';
// A job was saved (Log or Got a job): the Earnings tab starts a shift if none is running.
const jobLogged = (ts) => window.dispatchEvent(new CustomEvent('agaration:job', { detail: { ts } }));

// The owner sees how the estimate is worked out (the formula, Grab's cut rule, the base trip,
// the raw surge %); testers see the estimates. A code in Settings, not real security.
import { isOwner, isOwnerPhone } from './access.js';
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

const lab = { trips: [], shared: {}, surge: 'normal', arrow: false, level: 0, root: null, device: null, syncNote: '', version: 0, cache: null, platform: 'grab' };
// Which app the estimates and forms are for (Grab or TADA), remembered on this phone.
const PLAT_KEY = 'agaration-platform';
try { if (localStorage.getItem(PLAT_KEY) === 'tada') lab.platform = 'tada'; } catch { /* private mode */ }
usePlatform(lab.platform);
export const currentPlatform = () => lab.platform;
const isTada = () => lab.platform === 'tada';
const TADA_LEARN = 15; // TADA cards show "learning" until this many TADA trips

// Everyone's trips: yours (on this phone) plus other testers' (from the server). The same array is
// handed out until the trips change (changed()), so the formula, cut and time estimate built from
// it are worked out once per change. Nothing is dropped: it's always every trip.
const changed = () => { lab.version++; };
const dataset = () => {
  if (!lab.cache || lab.cache.version !== lab.version || lab.cache.platform !== lab.platform) {
    const mine = new Set(lab.trips.map((t) => t.id));
    // Trips around a listed event are marked, so they're kept apart from normal (formula.js).
    // Only this app's trips: Grab and TADA each learn their own formula.
    const all = [...lab.trips, ...Object.values(lab.shared).filter((t) => !mine.has(t.id))].filter((t) => platformOf(t) === lab.platform);
    lab.cache = { version: lab.version, platform: lab.platform, trips: markEvents(all, eventsList()) };
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
  ...(t.rain === 0 || t.rain === 1 ? { rain: t.rain } : {}),
  ...(t.arrow === 0 || t.arrow === 1 ? { arrow: t.arrow } : {}),
  ...(t.platform === 'tada' ? { platform: 'tada', offer: t.offer ? 1 : 0, level: [0, 1, 2].includes(t.level) ? t.level : null, fuel: t.fuel ?? null } : {}),
});
const fromRow = (r) => ({
  id: r.id, ts: r.ts, km: r.km, min: r.min ?? null, erp: r.erp || 0, actual: r.paid, earned: r.earned, surge: r.surge,
  predicted: r.predicted, predictedEarned: r.predicted_earned, cardMin: r.card_min ?? null, pickupKm: r.pickup_km ?? null, lat: r.lat ?? null, lng: r.lng ?? null, rain: r.rain === 1 ? 1 : r.rain === 0 ? 0 : null, arrow: r.arrow === 1 ? 1 : r.arrow === 0 ? 0 : null, ...(r.platform === 'tada' ? { platform: 'tada', offer: r.offer === 1, level: r.level ?? null, fuel: r.fuel ?? null } : {}), shared: true, d: r.d || null, trusted: r.tr === 1,
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
      let ownTagged = false;
      for (let page = 0; page < 20; page++) {
        const res = await fetch(`/api/formula?since=${cursor}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        for (const r of data.trips || []) {
          if (r.deleted) delete lab.shared[r.id];
          else {
            lab.shared[r.id] = fromRow(r);
            // The server tagged one of your trips with rain from NEA's past readings: keep it.
            const own = (r.rain === 0 || r.rain === 1) && lab.trips.find((t) => t.id === r.id && t.rain == null);
            if (own) { own.rain = r.rain; ownTagged = true; }
          }
          changed();
        }
        cursor = data.next ?? cursor;
        if (!data.more) break;
      }
      await db.setKV('formulaShared', lab.shared);
      await db.setKV('formulaCursor', cursor);
      if (ownTagged) await db.setKV(KEY, lab.trips);
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

// The folded guide: one screenshot per place the numbers come from. Each mark is a circle on the
// photo (x, y in % of the photo): 1 and 2 for the form's steps, A B C for Advanced.
// Grab screenshots with personal details blacked out and the maps blurred.
const GUIDE = [
  { src: 'guide/log-1.jpg', title: 'Job card', note: '1 trip km · B total min · C km to pickup', marks: [{ k: 'B', x: 62, y: 73.9 }, { k: 'C', x: 77.5, y: 77.9 }, { k: '1', x: 76, y: 82 }] },
  { src: 'guide/log-2.jpg', title: 'On the way to pickup', note: 'A = B − this time (32 − 3 = 29 min)', marks: [{ k: 'A', x: 32.5, y: 84.4 }] },
  { src: 'guide/log-3.jpg', title: 'Route details', note: '2 you earn · passenger paid', marks: [{ k: '2', x: 50, y: 9.8 }, { k: '2', x: 76.5, y: 70.3 }] },
];

let readyNow;
// Resolves once this phone's saved jobs are loaded (Earnings waits for it before ending an idle shift).
export const labReady = new Promise((r) => { readyNow = r; });
export async function buildLab(root) {
  lab.root = root;
  lab.trips = (await db.getKV(KEY)) || [];
  readyNow();
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

    <div id="lab-form-home"><div id="lab-form" class="stack log-form">
    <div class="log-head"><div><h2>Log a job</h2><p class="note" id="lab-mode-note">Three numbers from Grab's trip summary.</p></div>
      <div id="lab-mode" class="seg g2 log-mode" role="group" aria-label="Form">
        <button type="button" data-v="simple">Simple</button>
        <button type="button" data-v="advanced">Advanced</button>
      </div></div>

    <details class="log-guide" id="lab-guide"><summary>Where do I find these numbers?</summary>
      <p class="log-km-note">Distances in <b>km</b>: if Grab shows metres, divide by 1000. <b>800 m = 0.8</b> · 1,250 m = 1.25</p>
      <div class="log-guide-key tada-only" hidden>
        <span><span class="log-n">1</span> Trip km (TADA's Job Details, under the date)</span>
        <span><span class="log-n">2</span> Ride fare · Fuel support (under Net Earnings)</span>
        <span class="adv">The driver platform fee (S$0.60, or S$0.82 over a S$25 fare) is filled in for you.</span>
      </div>
      <div class="log-guide-key grab-only">
        <span><span class="log-n">1</span> Trip km</span>
        <span><span class="log-n">2</span> Passenger paid · You earned</span>
        <span class="adv-h">Advanced only (optional):</span>
        <span class="adv"><span class="log-n sm">A</span> Trip Mins (from pickup: B minus the time to pickup)</span>
        <span class="adv"><span class="log-n sm">B</span> Est. Total Mins (job card, includes your drive there)</span>
        <span class="adv"><span class="log-n sm">C</span> Dist. to Pick Up (km)</span>
      </div>
      <div class="log-guide-shots grab-only">${GUIDE.map((g) => `
        <figure class="log-shot"><div class="log-shot-img"><img src="${g.src}" alt="${g.title}" loading="lazy">${g.marks.map((m) => `<span class="log-n${/[ABC]/.test(m.k) ? ' sm' : ''}" style="left:${m.x}%;top:${m.y}%">${m.k}</span>`).join('')}</div>
          <figcaption><b>${g.title}</b>${g.note ? ` · ${g.note}` : ''}</figcaption></figure>`).join('')}
      </div>
    </details>

    <div class="log-step"><span class="log-n">1</span>
      <div class="field"><label for="lab-km" class="log-label"><b>Trip km</b> <span class="log-from">from PICK UP only</span></label>
        <input id="lab-km" class="log-big" type="number" inputmode="decimal" step="0.1" min="0" placeholder="e.g. 8.4"></div></div>
    <fieldset id="lab-adv" class="log-adv" hidden><legend>Optional</legend>
      <div class="row3">
        <div class="field"><label for="lab-min"><span class="log-n sm">A</span> Trip Mins</label>
          <input id="lab-min" type="number" inputmode="decimal" step="1" min="0"></div>
        <div class="field"><label for="lab-cardmin"><span class="log-n sm">B</span> Est. Mins</label>
          <input id="lab-cardmin" type="number" inputmode="decimal" step="1" min="0"></div>
        <div class="field"><label for="lab-pickupkm"><span class="log-n sm">C</span> Dist. to PU</label>
          <input id="lab-pickupkm" type="number" inputmode="decimal" step="0.01" min="0"></div>
      </div>
      <p class="hint">Fill in what you have. Trip Mins is from pickup; Est. Mins (job card total) includes your drive there.</p>
    </fieldset>
    <div id="lab-surge" class="seg g2">
      <button type="button" data-v="normal">Normal</button>
      <button type="button" data-v="airport">Airport</button>
    </div>
    <button type="button" class="arrow-tog" id="lab-arrow" aria-pressed="false" hidden><span class="arrow-box"></span> Green <b>↑</b> on the job</button>
    <div class="field tada-only" hidden><span class="flabel">TADA colour on the job</span>
      <div class="lv" id="lab-level"><button type="button" class="g" data-l="0">Grey · normal</button><button type="button" class="y" data-l="1">Yellow · surge</button><button type="button" class="o" data-l="2">Orange · super</button></div></div>

    <div class="lab-predict" id="lab-predict" aria-live="polite">
      <div class="lab-two">
        <div><div class="k">Estimate</div><div class="v" id="lab-pred">—</div></div>
        <div><div class="k">You get</div><div class="v sm" id="lab-pred-earn">—</div></div>
      </div>
      <div class="s" id="lab-pred-sub">Type the trip km.</div>
      <div class="s" id="lab-tod"></div>
      <div class="s surge-est" id="lab-surge-est"></div>
    </div>

    <div class="log-step"><span class="log-n">2</span>
      <div class="row2">
        <div class="field"><label for="lab-actual">Passenger paid (S$)</label>
          <input id="lab-actual" class="log-big" type="number" inputmode="decimal" step="0.01" min="0"></div>
        <div class="field"><label for="lab-earned">You earned (S$)</label>
          <input id="lab-earned" class="log-big" type="number" inputmode="decimal" step="0.01" min="0"></div>
      </div></div>
    <div class="lab-check" id="lab-check"></div>
    <p class="note rain-note" id="lab-rain" hidden></p>
    <p class="msg" id="lab-msg" role="status"></p>
    <button type="button" class="primary wide log-save" id="lab-save">Save job</button>

    <button type="button" class="ghost small log-clear" id="lab-clear">Clear the form</button>
    <div class="offer tada-only" id="lab-offer" hidden>
      <b>⚡ Log an offer</b>
      <span class="note">A TADA offer you saw but didn't take still teaches TADA's prices: the <b>Net Fare</b> and <b>Trip Distance</b> at the top of the offer, and its colour (grey, or yellow / orange when surging).</span>
      <div class="row2"><div class="field"><label for="of-km">Trip distance (km)</label><input id="of-km" type="number" inputmode="decimal" step="0.1" min="0"></div>
        <div class="field"><label for="of-fare">Net Fare (S$)</label><input id="of-fare" type="number" inputmode="decimal" step="0.01" min="0"></div></div>
      <div class="lv" id="of-level"><button type="button" class="g" data-l="0">Grey</button><button type="button" class="y" data-l="1">Yellow</button><button type="button" class="o" data-l="2">Orange</button></div>
      <p class="msg" id="of-msg" role="status"></p>
      <button type="button" class="ghost wide" id="of-save">Save offer</button>
    </div>
    <div class="card arrow-test" id="lab-arrow-test" hidden></div>
    <p class="note log-tip">On the road? Tap <b>Got a job</b> on Radar at pickup: it keeps the time and place for you.</p>
    </div></div>

    <h2>Your jobs</h2>
    <p class="note" id="lab-sync"></p>
    <div id="lab-list" class="stack"></div>

    <details class="log-more" id="lab-how"><summary>How the estimates are doing</summary>
      <div class="stack">
        <h2>How close it's getting</h2>
        <div id="lab-stats"></div>
        <h2>By time of day</h2>
        <div id="lab-tod-table"></div>
        <h2 id="lab-cut-h">Grab's cut</h2>
        <div id="lab-cut"></div>
      </div>
    </details>
    <button type="button" class="ghost wide" id="lab-export">Export CSV</button>`;

  for (const id of ['lab-km', 'lab-min', 'lab-cardmin', 'lab-pickupkm', 'lab-actual', 'lab-earned']) $(`#${id}`, root).addEventListener('input', update);
  for (const b of root.querySelectorAll('#lab-surge button')) {
    b.addEventListener('click', () => { lab.surge = b.dataset.v; update(); });
  }
  $('#lab-save', root).addEventListener('click', save);
  for (const b of root.querySelectorAll('#lab-level button')) b.addEventListener('click', () => { lab.level = Number(b.dataset.l); update(); });
  let offerLevel = 0;
  const showOfferLevel = () => { for (const b of root.querySelectorAll('#of-level button')) b.classList.toggle('on', Number(b.dataset.l) === offerLevel); };
  for (const b of root.querySelectorAll('#of-level button')) b.addEventListener('click', () => { offerLevel = Number(b.dataset.l); showOfferLevel(); });
  showOfferLevel();
  $('#of-save', root).addEventListener('click', async () => {
    const km = num($('#of-km', root)); const fare = num($('#of-fare', root)); const m = $('#of-msg', root);
    if (!(km > 0) || !(fare > 0)) { m.textContent = 'Add the trip distance and the Net Fare.'; m.classList.add('err'); return; }
    const sane = plausible({ km, paid: fare });
    if (!sane.ok) { m.textContent = sane.reason; m.classList.add('err'); return; }
    const w = weights();
    const predicted = passengerFare(w, km, estimate()(km)).fare;
    changed();
    lab.trips.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, platform: 'tada', offer: true, level: offerLevel,
      ts: Date.now(), km, min: null, erp: 0, actual: fare, earned: null, surge: 'normal', timeSplit: true, ...(rounded(here()) || {}),
      predicted, predictedNormal: predicted, rain: rainTagNow(here(), Date.now()) });
    await db.setKV(KEY, lab.trips);
    m.classList.remove('err');
    m.textContent = `Offer saved \u2713 ${km} km · S$${fare.toFixed(2)} (${['grey', 'yellow', 'orange'][offerLevel]}). Thanks: TADA learns from it.`;
    $('#of-km', root).value = ''; $('#of-fare', root).value = ''; offerLevel = 0; showOfferLevel();
    renderAll(); syncLab();
  });
  applyPlatform();
  // Guide photos: tap one to see it full screen (with its marks); tap again to close.
  for (const shot of root.querySelectorAll('.log-shot-img')) shot.addEventListener('click', () => {
    const big = document.createElement('div');
    big.className = 'shot-big';
    big.setAttribute('role', 'dialog');
    big.innerHTML = `<div class="shot-big-in">${shot.innerHTML}</div><p class="note">${shot.nextElementSibling ? shot.nextElementSibling.innerHTML : ''} · tap to close</p>`;
    big.addEventListener('click', () => big.remove());
    document.body.append(big);
  });
  $('#lab-arrow', root).addEventListener('click', () => { lab.arrow = !lab.arrow; update(); });
  // Simple or Advanced: remembered on this phone. Advanced shows the extra (optional) boxes inline.
  const MODE = 'agaration-log-mode';
  const setMode = (m) => {
    try { localStorage.setItem(MODE, m); } catch { /* private mode */ }
    for (const b of root.querySelectorAll('#lab-mode button')) b.classList.toggle('sel', b.dataset.v === m);
    $('#lab-adv', root).hidden = m !== 'advanced';
    $('#lab-mode-note', root).textContent = m === 'advanced' ? 'Grab\u2019s trip summary, plus any extras you have.' : 'Three numbers from Grab\u2019s trip summary.';
  };
  let mode = 'simple';
  try { mode = localStorage.getItem(MODE) === 'advanced' ? 'advanced' : 'simple'; } catch { /* private mode */ }
  setMode(mode);
  for (const b of root.querySelectorAll('#lab-mode button')) b.addEventListener('click', () => setMode(b.dataset.v));
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
  return `<div class="band-latest ${cls}">Latest <b>${money(j.earned)}</b> · ${t.km} km (${signed(j.vs)})${where ? ` · <b>${where}</b>` : ''}${t.event ? ` · ${t.eventName || 'event'}` : ''} · ${mins < 1 ? 'now' : `${mins} min ago`}</div>`;
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
  // Urgent from LTA: a major MRT disruption, or a flood alert within 3 km.
  loadAlerts(renderBands);
  const alertBox = document.querySelector('#radar-alerts');
  if (alertBox) { const h = alertsHtml(); alertBox.hidden = !h; alertBox.innerHTML = h; }
  // Likely surging within 3 km (2+ drivers' Surge trips in the last 30 min): first thing on Radar.
  loadSurge(renderBands);
  const surgeBox = document.querySelector('#radar-surge');
  if (surgeBox) {
    const s = surgeNow();
    surgeBox.hidden = !s;
    if (s) surgeBox.innerHTML = surgeBanner(s, areaName({ lat: Math.round(s.lat * 100) / 100, lng: Math.round(s.lng * 100) / 100 }), now);
  }
  // Raining near you (a rain gauge within 3 km), or rain forecast for your town: like surge.
  loadRain(renderBands);
  const wet = rainNow(loc);
  const rainBox = document.querySelector('#radar-rain');
  if (rainBox) { rainBox.hidden = !wet; rainBox.innerHTML = rainBanner(wet); }
  // An event letting out within 3 km (from an hour before it ends to 90 min after): like surge.
  const evBox = document.querySelector('#radar-event');
  const near = eventNear(eventsList(), loc, now);
  if (evBox) {
    evBox.hidden = !near;
    if (near) {
      const e = near.event;
      const t = new Date(e.ends_at);
      const when = now < e.ends_at ? `ends ~${pad(t.getHours())}:${pad(t.getMinutes())}` : `ended ${pad(t.getHours())}:${pad(t.getMinutes())} · crowd out`;
      const esc = (x) => String(x).replace(/[&<>"']/g, '');
      evBox.innerHTML = `<div class="glance-line event"><span class="surge-up" aria-hidden="true">★</span> <b>${esc(e.name)}</b> · <b>${esc(e.venue_name || '')}</b><span class="glance-sub">${when} · ${near.km < 1 ? '<1' : near.km.toFixed(1)} km</span></div>`;
    }
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
      ? `<div class="band-head">Next from JB · <b>${pl.at === 'woodlands' ? 'Woodlands' : pl.name}</b></div>${rows}`
      : `<div class="band-head">Next ferry · <b>${ferry.short}</b></div>${rows}`;
  }
  const airport = atAirport(loc);
  const ap = document.querySelector('#ap-flights');
  if (ap) {
    ap.hidden = !airport;
    if (airport) renderFlights(ap, renderBands);
  }
  box.hidden = airport;
  if (airport) return;
  // At a venue as it lets out: the cards show event prices (learned only from event trips).
  const atEvent = loc ? eventFor({ lat: loc.lat, lng: loc.lng, ts: now }, eventsList()) : null;
  const bands = bandOutlook(dataset(), now, loc, { event: atEvent, raining: Boolean(wet) });
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
  const word = { good: 'Surge', normal: 'Normal', bad: 'Bad', event: 'Event', tgrey: 'Normal', tyellow: 'Surge', torange: 'Super surge' };
  // TADA in TADA's own colours: grey normal, yellow surge (10%+), orange super surge (40%+); red below.
  const tada = isTada();
  const tadaN = tada ? dataset().filter((t) => !t.base).length : 0;
  const learning = tada && tadaN < TADA_LEARN;
  for (const b of bands) if (tada && b.state !== 'event') b.state = b.vs >= 0.4 ? 'torange' : b.vs >= 0.1 ? 'tyellow' : b.vs <= -0.1 ? 'bad' : 'tgrey';
  // Rain is its own small pill beside the price state (the card keeps Normal / Surge / Bad colours).
  const rainPill = wet ? `<span class="band-rain">${isThunder(wet.forecast) ? '⛈' : '☔'} Rain</span>` : '';
  // At a glance: where, the three prices, and the latest job. How it's worked out is on Log.
  void basis;
  box.innerHTML = `
    <div class="band-head">Earn now · ${place ? `<b>${place}</b>` : 'all areas'} · ${at}${tada ? ' · TADA' : ''}</div>
    ${tada ? '' : latestLine(now)}
    ${bands.map((b) => `
      <div class="band-card ${b.state}${learning ? ' learning' : ''}">
        <div class="band-top"><span class="band-name">${b.label}</span><span class="band-pills">${rainPill}${learning ? `<span class="learn">learning · ${tadaN} of ${TADA_LEARN}</span>` : `<span class="band-tag">${word[b.state]}${b.state === 'event' ? (b.eventTrips ? ` ${signed(b.vs)}` : '') : !['normal', 'tgrey'].includes(b.state) ? ` ${signed(b.vs)}` : ''}</span>`}</span></div>
        <div class="band-now">${learning ? '~' : ''}${money(b.now)}</div>
        <div class="band-sub">${tada ? `Normal ${money(b.normal)} · you keep ride fare + fuel − ${money(tadaFee(b.normal))}` : `Normal ${money(b.normal)} · Surge ${money(b.surgeLo)}–${money(b.surgeHi).replace('S$', '')}`}</div>
      </div>`).join('')}`;
}
setInterval(() => { if (lab.root) renderBands(); }, 60 * 1000);

// Green-arrow test (owner's phone): do jobs with the arrow pay more than jobs without?
function renderArrowTest() {
  const box = lab.root && $('#lab-arrow-test', lab.root);
  if (!box) return;
  box.hidden = !isOwnerPhone() || isTada();
  if (box.hidden) return;
  const a = arrowCompare(dataset());
  const line = (label, b) => (b.n ? `<div class="r"><span>${label}</span><b>${signed(b.lift)}</b><span class="note">${b.n} job${b.n === 1 ? '' : 's'} · ${signed(b.lo)} to ${signed(b.hi)} · ${b.over15} paid 15%+ more</span></div>` : `<div class="r"><span>${label}</span><b>—</b><span class="note">none yet</span></div>`);
  const L = a.logged;
  const verdict = L.arrow.n >= 5 && L.none.n >= 5
    ? (Math.abs(L.arrow.lift - L.none.lift) < 0.05 ? 'So far the arrow makes <b>no real difference</b> to the pay.' : L.arrow.lift > L.none.lift ? `So far jobs with the arrow pay <b>${signed(L.arrow.lift - L.none.lift)}</b> more.` : 'So far jobs with the arrow pay <b>less</b>.')
    : 'Log 5+ jobs with the arrow and 5+ without to compare.';
  box.innerHTML = `<div class="k">Green arrow test · vs the normal price</div>
    ${line('With ↑', L.arrow)}${line('No ↑', L.none)}
    <p class="note">${verdict}</p>
    ${a.older.arrow.n || a.older.none.n ? `<p class="note">Before this (old Surge / Normal tags): Surge-tagged ${a.older.arrow.n ? signed(a.older.arrow.lift) : '—'} (${a.older.arrow.n}), Normal-tagged ${a.older.none.n ? signed(a.older.none.lift) : '—'} (${a.older.none.n}).</p>` : ''}`;
}

function renderAll() {
  renderArrowTest();
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
  const learned = w.n - PLATFORMS[lab.platform].base.filter((t) => t.surge === 'normal').length;
  const others = Object.keys(lab.shared).filter((id) => !lab.trips.some((t) => t.id === id)).length;
  const basis = learned > 0
    ? `Fitted from the base trip and ${learned} normal trip${learned === 1 ? '' : 's'}${others ? ` (${others} trip${others === 1 ? '' : 's'} from other drivers in the dataset)` : ''}.`
    : 'From the base trip only (11.58 km, paid S$16.80): it sets the level, more trips sort out the split.';
  $('#lab-formula', lab.root).innerHTML = `
    <div class="k">${isTada() ? 'TADA: ride fare (normal pricing)' : 'Grab\'s published formula (Standard, normal pricing)'}</div>
    <div class="f">Paid by passenger = max(<b>${money(MIN_PASSENGER)}</b>, <b>${money(w.base)}</b> + <b>${money(w.perKm)}</b> × km + <b>${money(w.perMin)}</b> × min)</div>
    <div class="f">${isTada() ? `You earn = ride fare + fuel support (<b>${money(tadaFuel(10))}</b> / <b>${money(tadaFuel(30))}</b>) − fee (<b>S$0.60</b>, <b>S$0.82</b> over S$25)</div><div class="f" hidden>` : ''}You earn = max(<b>${money(MIN_DRIVER)}</b>, ${(() => { const c = commission(); return c.kind === 'percent+fixed' ? `<b>${(c.keep * 100).toFixed(1)}%</b> × paid ${c.fixed < 0 ? '−' : '+'} <b>${money(Math.abs(c.fixed))}</b>` : `<b>${(c.keep * 100).toFixed(1)}%</b> × paid`; })()})</div>
    <div class="s">${basis} Weights update every time you save a trip.</div>`;
}

function readForm() {
  const r = lab.root;
  return {
    km: num($('#lab-km', r)), min: num($('#lab-min', r)), erp: 0, // ERP is added after the trip starts, not on the job card
    cardMin: num($('#lab-cardmin', r)), pickupKm: num($('#lab-pickupkm', r)), timeSplit: true,
    ts: lab.pending ? lab.pending.ts : Date.now(), // when you tapped Got a job, else when you save
    actual: num($('#lab-actual', r)), earned: num($('#lab-earned', r)), surge: lab.surge,
    ...(isTada() ? tadaParts(num($('#lab-actual', r)), num($('#lab-earned', r))) : {}),
  };
}
// TADA: the second box is fuel support; you earned = ride fare + fuel support − the flat fee.
function tadaParts(fare, fuelTyped) {
  const fuel = fuelTyped != null ? fuelTyped : fare > 0 ? tadaFuel(fare) : null;
  return { platform: 'tada', fuel, earned: fare > 0 ? Math.round((fare + (fuel || 0) - tadaFee(fare)) * 100) / 100 : null, level: lab.level };
}

// Grab or TADA: labels, colours and boxes that differ by app.
function applyPlatform() {
  const r = lab.root;
  if (!r) return;
  const t = isTada();
  for (const el of r.querySelectorAll('.tada-only')) el.hidden = !t;
  for (const el of r.querySelectorAll('.grab-only')) el.hidden = t;
  r.querySelector('label[for="lab-actual"]').textContent = t ? 'Ride fare (S$)' : 'Passenger paid (S$)';
  r.querySelector('label[for="lab-earned"]').textContent = t ? 'Fuel support (S$)' : 'You earned (S$)';
  $('#lab-earned', r).placeholder = t ? 'e.g. 0.90' : '';
  r.querySelector('.log-head h2').textContent = t ? 'Log a TADA job' : 'Log a job';
  const note = $('#lab-mode-note', r);
  if (note) note.textContent = t ? 'From TADA\u2019s Job Details.' : 'Three numbers from Grab\u2019s trip summary.';
  const gj = document.querySelector('#got-job');
  if (gj) gj.textContent = t ? 'Got a TADA job' : 'Got a job';
  for (const b of document.querySelectorAll('#plat-bar button')) b.classList.toggle('sel', b.dataset.p === lab.platform);
  document.body.dataset.platform = lab.platform;
}
export function setPlatform(p) {
  lab.platform = p === 'tada' ? 'tada' : 'grab';
  try { localStorage.setItem(PLAT_KEY, lab.platform); } catch { /* private mode */ }
  usePlatform(lab.platform);
  lab.surge = 'normal'; lab.level = 0;
  applyPlatform();
  const qb = document.querySelector('#job-body');
  if (qb && qb.dataset.built) applyQuickPlatform();
  renderAll();
}

// Live: the predicted fare and earnings appear as soon as distance and time are in.
const rainNoteText = () => { const w = rainNow((lab.pending && lab.pending.precise) || here()); return w ? `${isThunder(w.forecast) ? '⛈' : '☔'} ${w.kind === 'now' ? 'Raining' : 'Rain forecast'} near you: saved as a rain job.` : ''; };
const showArrow = (btn, on) => { if (!btn) return; btn.hidden = !isOwnerPhone(); btn.setAttribute('aria-pressed', on ? 'true' : 'false'); btn.classList.toggle('on', on); };
function update(ev) {
  const r = lab.root;
  showArrow($('#lab-arrow', r), lab.arrow && !isTada());
  if (isTada()) $('#lab-arrow', r).hidden = true;
  for (const b of r.querySelectorAll('#lab-level button')) b.classList.toggle('on', Number(b.dataset.l) === lab.level);
  const rn = $('#lab-rain', r);
  if (rn) { const t = rainNoteText(); rn.hidden = !t; rn.textContent = t; }
  if (ev && ev.type === 'input') { const m = $('#lab-msg', r); if (m.classList.contains('err')) { m.textContent = ''; m.classList.remove('err'); } }
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
    sub.textContent = 'Type the trip km.';
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
  sub.textContent = isOwner()
    ? `${p.atMinimum ? 'Minimum fare applies. ' : ''}${f.min > 0 ? '' : `Trip time estimated: ${Math.round(mins)} min. `}Normal-price formula. ${cutLabel}.`
    : `${p.atMinimum ? 'Minimum fare. ' : ''}Now type what ${isTada() ? 'TADA' : 'Grab'} shows.`;
  const surgeEl = $('#lab-surge-est', r);
  const kindName = f.surge === 'airport' ? 'airport' : 'surge';
  const startText = f.surge === 'airport' ? 'No airport trips yet, so no difference is assumed: each airport trip you save shows whether they\'re priced differently.' : 'The +20% is a starting guess: each surge trip you save adjusts it.';
  surgeEl.innerHTML = sl && !isOwner()
    ? `Includes ${f.surge === 'airport' ? 'airport' : 'surge'} ${signed(sl.lift)} (normal ${money(p.fare)}).`
    : sl
    ? `${f.surge === 'airport' ? 'Airport' : 'Surge'}: normal fare <b>${money(p.fare)}</b> ${signed(sl.lift)} = <b>${money(shown)}</b>. ${sl.guess ? startText : `Learned from ${sl.n} ${kindName} trip${sl.n === 1 ? '' : 's'}${sl.near ? `, ${sl.near} around this hour` : ''}; adjusts with every ${kindName} trip.`}`
    : '';

  // Time of day: how fares near this hour have run against the formula (surge-prone hours).
  const t = timeOfDay(dataset(), f.ts);
  const h = new Date(f.ts);
  const at = `${pad(h.getHours())}:${pad(h.getMinutes())}`;
  if (!isOwner()) {
    tod.textContent = '';
  } else if (t.near === 0) {
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
  if (f.actual > 0) row(isTada() ? 'Ride fare' : 'Passenger paid', shown, f.actual);
  if (f.earned > 0) row('You earned', earn, f.earned);
  if (!rows.length) { check.innerHTML = ''; return; }
  if (!isOwner()) {
    const plain = (label, est, actual) => {
      if (!(actual > 0)) return '';
      const vs = actual / est - 1;
      const cls = Math.abs(vs) <= 0.05 ? 'close' : Math.abs(vs) <= 0.15 ? 'off' : 'far';
      return `<div class="kept">${label}: <b class="${cls}">${Math.abs(vs) < 0.005 ? 'spot on' : `${signed(vs)} vs estimate`}</b></div>`;
    };
    check.innerHTML = plain(isTada() ? 'Ride fare' : 'Passenger paid', shown, f.actual) + plain('You earned', earn, f.earned);
    if (isTada() && f.actual > 0) check.innerHTML += `<div class="kept">You earned <b>${money(f.earned)}</b> = ride fare ${money(f.actual)} + fuel ${money(f.fuel || 0)} − fee ${money(tadaFee(f.actual))}</div>`;
    if (f.actual > 0 && f.surge === 'normal' && (f.actual - p.fare) / p.fare >= SURGE_PRICE_MIN) {
      check.innerHTML += `<div class="kept">\u2191 Paid <b>${Math.round(((f.actual - p.fare) / p.fare) * 100)}% above</b> normal: counts as a <b>surge</b> job.</div>`;
    }
    return;
  }
  // Marked normal but well above the normal formula: maybe untagged surge.
  let hint = '';
  if (f.actual > 0 && f.surge === 'normal') {
    const above = (f.actual - p.fare) / p.fare;
    if (above >= SURGE_PRICE_MIN) hint = `<div class="kept">\u2191 Paid <b>${(above * 100).toFixed(0)}% above</b> the normal estimate: counts as a <b>surge</b> job (${SURGE_PRICE_MIN * 100}%+ above; the green arrow isn't used).</div>`;
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
  if (!(f.km > 0)) { msg.textContent = 'Step 1: add the trip km.'; msg.classList.add('err'); $('#lab-km', lab.root).focus(); return; }
  if (!(f.actual > 0)) { msg.textContent = 'Step 2: add what the passenger paid.'; msg.classList.add('err'); $('#lab-actual', lab.root).focus(); return; }
  const sane = plausible({ km: f.km, min: f.min, paid: f.actual, earned: f.earned, erp: f.erp });
  if (!sane.ok) { msg.textContent = sane.reason; msg.classList.add('err'); return; }
  // Predictions are recorded before this trip changes anything: an honest test each time.
  const w = weights();
  const normalFare = passengerFare(w, f.km, f.min > 0 ? f.min : estimate()(f.km), f.erp).fare;
  // A surge trip's prediction is the normal fare plus the surge % it was shown: the honest test
  // of the surge estimate. The normal-price figure is kept too.
  const sl = liftFor(f.surge, f.ts);
  const predicted = sl ? Math.round(normalFare * (1 + sl.lift) * 100) / 100 : normalFare;
  const c = commission();
  const predictedEarned = driverEarns(c, predicted, f.erp);
  if (!confirmOutlier(msg, $('#lab-save', lab.root), f.actual, predicted)) return;
  const t = timeOfDay(dataset(), f.ts);
  changed();
  lab.trips.push({
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...f,
    // Where the phone was (about 1 km): on Got a job, near the pickup; otherwise on Save.
    ...((lab.pending && lab.pending.loc) || rounded(here()) || {}),
    predicted, predictedEarned, predictedNormal: normalFare, surgeLiftUsed: sl ? sl.lift : null, todLift: t.near ? t.lift : null,
    weightsBefore: { base: w.base, perKm: w.perKm, perMin: w.perMin },
    rain: rainTagNow((lab.pending && lab.pending.precise) || here(), f.ts),
    ...(isOwnerPhone() && !isTada() ? { arrow: lab.arrow ? 1 : 0 } : {}),
  });
  lab.arrow = false;
  lab.level = 0;
  await db.setKV(KEY, lab.trips);
  jobLogged(f.ts);
  syncLab();
  msg.classList.remove('err');
  msg.textContent = isOwner()
    ? `Saved. Paid: estimate ${money(predicted)} vs ${money(f.actual)} (${offText(predicted, f.actual)}).${f.earned > 0 ? ` Earned: ${money(predictedEarned)} vs ${money(f.earned)} (${offText(predictedEarned, f.earned)}).` : ''} Estimates updated.`
    : `Saved \u2713 ${f.km} km · ${isTada() ? 'ride fare' : 'paid'} ${money(f.actual)}${f.earned > 0 ? ` · earned ${money(f.earned)}` : ''}. Thanks: estimates updated.`;
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
const quick = { surge: 'normal', arrow: false, route: null, seq: 0, timer: null };

function buildQuick() {
  const body = document.querySelector('#job-body');
  if (!body || body.dataset.built) return;
  body.dataset.built = '1';
  // A full trip: drop-off (for the distance), what the passenger paid and what you earned, so each
  // job teaches the fare, Grab's cut and "now" for everyone.
  body.innerHTML = `
    <div class="field"><label for="qj-km">Drop-off</label>
      <input id="qj-km" type="text" autocomplete="off" autocapitalize="words" placeholder="Area, postal code or address (or km)"></div>
    <div class="row2">
      <div class="field"><label for="qj-paid">Paid by passenger (S$)</label>
        <input id="qj-paid" type="number" inputmode="decimal" step="0.01" min="0"></div>
      <div class="field"><label for="qj-earned">You earned (S$)</label>
        <input id="qj-earned" type="number" inputmode="decimal" step="0.01" min="0"></div>
    </div>
    <div id="qj-surge" class="seg g2">
      <button type="button" data-v="normal">Normal</button>
      <button type="button" data-v="airport">Airport</button>
    </div>
    <button type="button" class="arrow-tog" id="qj-arrow" aria-pressed="false" hidden><span class="arrow-box"></span> Green <b>↑</b> on the job</button>
    <div class="lab-check" id="qj-check"></div>
    <p class="note rain-note" id="qj-rain" hidden></p>
    <p class="msg" id="qj-msg" role="status"></p>
    <button type="button" class="primary wide" id="qj-save">Save job</button>
    <p class="note">Saved as a full trip: sharpens the estimates and Radar for every driver.</p>`;
  body.querySelector('#qj-km').addEventListener('input', onTripInput);
  body.querySelector('#qj-earned').addEventListener('input', quickUpdate);
  body.querySelector('#qj-paid').addEventListener('input', quickUpdate);
  for (const b of body.querySelectorAll('#qj-surge button')) b.addEventListener('click', () => { quick.surge = b.dataset.v; quickUpdate(); });
  body.querySelector('#qj-save').addEventListener('click', quickSave);
  applyQuickPlatform();
  body.querySelector('#qj-arrow').addEventListener('click', () => { quick.arrow = !quick.arrow; quickUpdate(); });
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

function applyQuickPlatform() {
  const t = isTada();
  const lp = document.querySelector('label[for="qj-paid"]'); if (lp) lp.textContent = t ? 'Ride fare (S$)' : 'Paid by passenger (S$)';
  const le = document.querySelector('label[for="qj-earned"]'); if (le) le.textContent = t ? 'Fuel support (S$)' : 'You earned (S$)';
  const ar = document.querySelector('#qj-arrow'); if (ar && t) ar.hidden = true;
  const title = document.querySelector('#job-sheet .sheet-title'); if (title) title.textContent = t ? 'Got a TADA job' : 'Got a job';
}
function quickRead() {
  const n = (id) => { const v = parseFloat(document.querySelector(id).value); return Number.isFinite(v) ? v : null; };
  const text = document.querySelector('#qj-km').value.trim();
  const typed = kmTyped(text);
  const r = quick.route;
  const km = typed ?? (r && r.km > 0 ? r.km : null);
  const base = { km, drop: typed === null && r && r.km > 0 ? r.label : null, paid: n('#qj-paid'), earned: n('#qj-earned'), surge: quick.surge };
  if (!isTada()) return base;
  const tp = tadaParts(base.paid, base.earned);
  return { ...base, fuel: tp.fuel, earned: tp.earned };
}

// Safeguard: a fare far from the estimate (60%+ above, 40%+ below) needs a second tap on Save,
// so a typo (S$150 for S$15.00) is caught; once confirmed it's saved (and still can't swing "now").
function confirmOutlier(msg, btn, actual, estimate) {
  if (!isOutlier(actual, estimate)) { if (btn) btn.removeAttribute('data-confirm'); return true; }
  const key = `${actual}|${Math.round(estimate * 100)}`;
  if (btn && btn.getAttribute('data-confirm') === key) { btn.removeAttribute('data-confirm'); return true; }
  if (btn) btn.setAttribute('data-confirm', key);
  const vs = actual / estimate - 1;
  msg.classList.add('err');
  msg.innerHTML = `S$${actual.toFixed(2)} is <b>${Math.abs(Math.round(vs * 100))}% ${vs > 0 ? 'above' : 'below'}</b> the estimate (S$${estimate.toFixed(2)}). Typo? If it's right, tap <b>Save</b> again.`;
  return false;
}

// What the estimate says for this job (normal, plus the surge / airport % when tagged), before it's saved.
function quickEstimate(f) {
  const w = weights();
  const normalFare = passengerFare(w, f.km, estimate()(f.km)).fare;
  const ts = lab.pending ? lab.pending.ts : Date.now();
  const sl = liftFor(f.surge, ts);
  const predicted = sl ? Math.round(normalFare * (1 + sl.lift) * 100) / 100 : normalFare;
  return { w, ts, sl, normalFare, predicted, predictedEarned: driverEarns(commission(), predicted) };
}
function quickUpdate() {
  showArrow(document.querySelector('#qj-arrow'), quick.arrow);
  if (isTada()) { const ar = document.querySelector('#qj-arrow'); if (ar) ar.hidden = true; }
  const rn = document.querySelector('#qj-rain');
  if (rn) { const t = rainNoteText(); rn.hidden = !t; rn.textContent = t; }
  for (const b of document.querySelectorAll('#qj-surge button')) b.classList.toggle('sel', b.dataset.v === quick.surge);
  const f = quickRead();
  const box = document.querySelector('#qj-check');
  const r = quick.route;
  const routeLine = r
    ? `<div class="kept">${r.pending ? `Finding “${r.text}” on the map…` : r.error ? r.error : `→ <b>${r.label}</b> · <b>${r.km} km</b> by road from where you got the job.`}</div>`
    : '';
  if (!(f.km > 0)) { box.innerHTML = routeLine; return; }
  const e = quickEstimate(f);
  const line = (label, est, actual) => {
    if (!(actual > 0)) return `<div class="kept">${label}: estimate <b>${money(est)}</b></div>`;
    const vs = actual / est - 1;
    const cls = Math.abs(vs) <= 0.05 ? 'close' : Math.abs(vs) <= 0.15 ? 'off' : 'far';
    return `<div class="kept">${label}: estimate ${money(est)} · actual <b class="${cls}">${money(actual)} (${signed(vs)})</b></div>`;
  };
  box.innerHTML = `${routeLine}${line('Passenger', e.predicted, f.paid)}${line('You', e.predictedEarned, f.earned)}`;
}
async function quickSave() {
  const f = quickRead();
  const msg = document.querySelector('#qj-msg');
  const missing = !(f.km > 0) ? (quick.route && quick.route.pending ? 'Still finding the drop-off…' : 'Add the drop-off.')
    : !(f.paid > 0) ? (isTada() ? 'Add the ride fare.' : 'Add what the passenger paid.') : !(f.earned > 0) ? 'Add what you earned.' : '';
  if (missing) { msg.textContent = missing; msg.classList.add('err'); return; }
  const sane = plausible({ km: f.km, paid: f.paid, earned: f.earned });
  if (!sane.ok) { msg.textContent = sane.reason; msg.classList.add('err'); return; }
  // Recorded before the trip changes anything (an honest test), at the job's own time and place.
  const e = quickEstimate(f);
  if (!confirmOutlier(msg, document.querySelector('#qj-save'), f.paid, e.predicted)) return;
  const t = timeOfDay(dataset(), e.ts);
  changed();
  lab.trips.push({
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, from: 'radar',
    ts: e.ts, km: f.km, min: null, erp: 0, actual: f.paid, earned: f.earned, surge: f.surge,
    ...((lab.pending && lab.pending.loc) || rounded(here()) || {}),
    predicted: e.predicted, predictedEarned: e.predictedEarned, predictedNormal: e.normalFare, surgeLiftUsed: e.sl ? e.sl.lift : null,
    todLift: t.near ? t.lift : null, weightsBefore: { base: e.w.base, perKm: e.w.perKm, perMin: e.w.perMin }, timeSplit: true,
    ...(f.drop ? { dropLabel: f.drop, kmSource: 'map' } : {}), // drop-off name stays on this phone
    rain: rainTagNow((lab.pending && lab.pending.precise) || here(), e.ts),
    ...(isOwnerPhone() && !isTada() ? { arrow: quick.arrow ? 1 : 0 } : {}),
    ...(isTada() ? { platform: 'tada', fuel: f.fuel, level: 0 } : {}),
  });
  quick.arrow = false;
  await db.setKV(KEY, lab.trips);
  jobLogged(e.ts);
  const saved = new Date(e.ts);
  lab.pending = null;
  msg.classList.remove('err');
  for (const id of ['#qj-km', '#qj-paid', '#qj-earned']) document.querySelector(id).value = '';
  quick.surge = 'normal';
  quick.route = null;
  closeJob();
  const note = document.querySelector('#got-job-msg');
  if (note) note.innerHTML = `Saved ${pad(saved.getHours())}:${pad(saved.getMinutes())} · ${f.km} km${f.drop ? ` to <b>${f.drop.replace(/[<>&"]/g, '')}</b>` : ''} · ${isTada() ? 'ride fare' : 'paid'} ${money(f.paid)}, earned ${money(f.earned)}`;
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
  const sw = weights(); const sEst = estimate(); const sC = commission();
  const surgeTrips = dataset().filter((t) => t.actual > 0 && t.predicted > 0 && isSurgeTrip(t, sw, sEst, sC)).sort((a, b) => a.ts - b.ts);
  const surgeOffs = [];
  const surgeNow = surgeLift(dataset(), Date.now());
  const arrowNormal = dataset().filter((t) => t.surge === 'surge' && t.actual > 0 && !isSurgeTrip(t, sw, sEst, sC)).length;
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
    <p class="note"><b>Surge (test: by price, ${SURGE_PRICE_MIN * 100}%+ above normal):</b> ${surgeTrips.length} surge job${surgeTrips.length === 1 ? '' : 's'}${surgeNow.range && !surgeNow.range.guess ? `, paying ${signed(surgeNow.range.lo)} to ${signed(surgeNow.range.hi)} above normal` : ' (range is a starting guess)'}; average ${signed(surgeNow.lift)}.${arrowNormal ? ` ${arrowNormal} trip${arrowNormal === 1 ? '' : 's'} tagged Surge (green arrow) paid normal, so they teach the normal price.` : ''}</p>
    <p class="note"><b>Rain:</b> ${(() => { const r = rainLift(dataset()); return r.guess ? 'no trips saved in the rain yet.' : `trips saved in the rain ran ${signed(r.lift)} vs normal, from ${r.n} trip${r.n === 1 ? '' : 's'} (observed, not a rule).`; })()}</p>
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
  box.hidden = !isOwner() || isTada();
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

const surgeLabel = (t) => (t.offer ? ' · offer (not taken)' : '') + (t.surge === 'airport' ? ' · Airport' : isSurgeTrip(t, weights(), estimate(), commission()) ? ' · Surge (paid 15%+ more)' : '') + (t.arrow === 1 ? ' · green ↑ seen' : t.arrow === 0 ? ' · no ↑' : '') + (t.level === 2 ? ' · orange' : t.level === 1 ? ' · yellow' : '');
function renderList() {
  renderCut();
  $('#lab-sync', lab.root).textContent = lab.syncNote || 'Your trips upload so every driver\'s estimates learn from them.';
  const box = $('#lab-list', lab.root);
  box.innerHTML = lab.trips.some((x) => platformOf(x) === lab.platform) ? '' : '<p class="empty">No jobs logged yet. Your first one takes 10 seconds.</p>';
  for (const t of [...lab.trips].filter((x) => platformOf(x) === lab.platform).reverse()) {
    const cut = cutOf(t);
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="line1"><span class="when">${new Date(t.ts).toLocaleString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</span><span class="when">${money(t.actual)}</span></div>
      ${isOwner() ? '' : `<div class="meta">${t.km} km${t.dropLabel ? ` to ${t.dropLabel.replace(/[<>&"]/g, '')}` : ''}${surgeLabel(t)}${t.rain === 1 ? ' · ☔ Rain' : ''}${t.earned > 0 ? ` · earned ${money(t.earned)}` : ''}</div>`}
      <div class="meta" ${isOwner() ? '' : 'hidden'}>${t.km} km · ${t.min > 0 ? `${t.min} min trip` : 'trip time not known'}${t.cardMin ? ` · card total ${t.cardMin} min` : ''}${t.pickupKm ? ` · ${t.pickupKm} km to pickup` : ''}${t.erp ? ` · ERP ${money(t.erp)}` : ''}${surgeLabel(t)}${t.rain === 1 ? ' · ☔ Rain' : ''}</div>
      <div class="meta" ${isOwner() ? '' : 'hidden'}>${t.quick ? `Quick entry from Got a job: earned ${money(t.earned)}${t.predictedEarned ? ` (normal about ${money(t.predictedEarned)})` : ''}. Add the passenger fare in a full entry to sharpen the estimates.` : ''}${t.quick ? '' : `Paid: estimate said ${money(t.predicted)} (${offText(t.predicted, t.actual)})`}${!t.quick && t.earned > 0 ? ` · Earned ${money(t.earned)}${t.predictedEarned ? `, predicted ${money(t.predictedEarned)} (${offText(t.predictedEarned, t.earned)})` : ''}` : ''}${cut ? ` · Grab kept ${pct(cut.rate)}${cut.rate < 0.15 ? ' (low-cut trip)' : ''}` : ''}</div>`;
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
    // Green arrow test (owner's phone): fix the arrow on a saved job with one tap. It re-uploads,
    // so the server copy changes too.
    if (isOwnerPhone()) {
      const ar = document.createElement('button');
      ar.type = 'button';
      ar.className = `ghost small arrow-fix${t.arrow === 1 ? ' on' : ''}`;
      ar.textContent = t.arrow === 1 ? 'Green ↑ seen ✓' : 'Mark green ↑';
      ar.addEventListener('click', async () => {
        t.arrow = t.arrow === 1 ? 0 : 1;
        changed();
        await db.setKV(KEY, lab.trips);
        renderAll();
        syncLab();
      });
      acts.prepend(ar);
    }
    card.append(acts);
    box.append(card);
  }
  if (isOwner()) box.append(baseCard());
  const exp = $('#lab-export', lab.root);
  if (exp) exp.hidden = !isOwner();
}

// The built-in base trip, listed last so it's clear where the starting weights came from.
function baseCard() {
  const t = PLATFORMS[lab.platform].base[0];
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="line1"><span class="when">Base trip (built in), ~01:30</span><span class="when">${money(t.actual)}</span></div>
    <div class="meta">${t.km} km · ${t.min} min (OneMap) · earned ${money(t.earned)}, Grab kept ${money(cutOf(t).cut)}</div>
    <div class="meta">${t.note}</div>`;
  return card;
}

// For Settings: this phone's own trips, removing them, and the owner's full export.
export const myLabTrips = () => lab.trips;
export async function clearMyLabTrips() {
  lab.trips = [];
  changed();
  await db.setKV(KEY, []);
  if (lab.root) renderAll();
}
export const exportAllCsv = () => exportCsv();

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
