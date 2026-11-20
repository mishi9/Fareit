// Airport queue (beta): when you join the airport queue, note the cars ahead and Grab's estimated
// wait; tap "Got a job" when one comes to record the actual wait. Readings upload to their own
// table on the server (separate from fares and the shared jobs pool) so every driver's readings
// build the picture of how long the queue takes at each hour.
import * as db from './db.js';
import { here, atAirport, onMove } from './where.js';

import { platformNow } from './formula.js';
const KEY = 'queueLog';
const OPEN_FOR = 4 * 3600 * 1000; // a reading can be closed with "Got a job" for 4 hours
const $ = (s, root) => root.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const hm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const hourOf = (ts) => { const d = new Date(ts); return d.getHours() + d.getMinutes() / 60; };
const hourGap = (a, b) => { const g = Math.abs(a - b) % 24; return Math.min(g, 24 - g); };
const avg = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;

// What readings around this hour (any day) usually showed. Pure, for the page and the tests.
export function queueSummary(readings, ts, windowH = 1.5) {
  const h = hourOf(ts);
  const near = readings.filter((r) => hourGap(hourOf(r.ts), h) <= windowH);
  if (!near.length) return null;
  const cars = near.filter((r) => r.cars > 0 || r.cars === 0).map((r) => r.cars);
  const est = near.filter((r) => r.est > 0).map((r) => r.est);
  const actual = near.filter((r) => r.actual > 0).map((r) => r.actual);
  return {
    n: near.length,
    cars: cars.length ? avg(cars) : null,
    est: est.length ? avg(est) : null,
    actual: actual.length ? avg(actual) : null,
    nActual: actual.length,
  };
}

const median = (xs) => { const a = [...xs].sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
export const QUEUE_FRESH_MIN = 45;

// The wait for someone joining the queue now. From the latest reading if it's under 45 min old
// (a queue that long then is about as long now), else from what readings around this hour usually
// show. Recorded real waits correct Grab's estimate (e.g. it says 30, people wait 40 -> x1.33), and
// give minutes per car ahead for readings with only a car count. Pure, for the page and the tests.
export function queueWait(readings, ts) {
  const valid = readings.filter((r) => Number.isFinite(r.ts) && r.ts <= ts);
  if (!valid.length) return null;
  const latest = valid.reduce((a, b) => (b.ts > a.ts ? b : a));
  const done = valid.filter((r) => r.actual > 0);
  const bias = done.filter((r) => r.est > 0).map((r) => r.actual / r.est);
  const perCar = done.filter((r) => r.cars > 0).map((r) => r.actual / r.cars);
  const grabPerCar = valid.filter((r) => r.est > 0 && r.cars > 0).map((r) => r.est / r.cars);
  const factor = bias.length ? median(bias) : 1;
  const minPerCar = perCar.length ? median(perCar) : grabPerCar.length ? median(grabPerCar) * factor : null;
  const fromReading = (r) => (r.est > 0 ? r.est * factor : r.cars != null && minPerCar ? r.cars * minPerCar : null);
  const ageMin = (ts - latest.ts) / 60000;
  if (ageMin <= QUEUE_FRESH_MIN) {
    const min = fromReading(latest);
    if (min != null) return { min: Math.round(min), basis: 'latest', at: latest.ts, cars: latest.cars ?? null, corrected: bias.length > 0 };
  }
  const s = queueSummary(valid, ts);
  if (!s) return { min: null, basis: 'none', at: latest.ts, cars: null };
  const min = s.actual != null ? s.actual : s.est != null ? s.est * factor : s.cars != null && minPerCar ? s.cars * minPerCar : null;
  return { min: min == null ? null : Math.round(min), basis: 'usual', at: latest.ts, cars: s.cars, n: s.n, corrected: bias.length > 0 };
}

const q = { root: null, device: null, mine: [], shared: {}, note: '', leftAt: 0, again: false, done: '' };
// After Got a job the form stays away until you've left the airport zone and come back (you're
// driving off with a passenger, not queueing). Pure, for the page and the tests.
export const AFTER_JOB_MAX = 3 * 3600 * 1000;
export function formHidden(mine, { now = Date.now(), leftAt = 0, again = false } = {}) {
  const open = mine.some((x) => !(x.actual > 0) && now - x.ts < OPEN_FOR);
  if (open) return 'open';
  if (again) return null;
  const closed = mine.filter((x) => x.actual > 0).map((x) => x.ts + x.actual * 60000);
  const last = closed.length ? Math.max(...closed) : 0;
  return last && now - last < AFTER_JOB_MAX && last > leftAt ? 'done' : null;
}
const all = () => {
  const mine = new Set(q.mine.map((r) => r.id));
  return [...q.mine, ...Object.values(q.shared).filter((r) => !mine.has(r.id))];
};
const toRow = (r) => ({ id: r.id, ts: r.ts, cars_ahead: r.cars ?? null, est_wait_min: r.est ?? null, actual_wait_min: r.actual ?? null, ...(r.platform === 'tada' ? { platform: 'tada' } : {}) });
const fromRow = (r) => ({ id: r.id, ts: r.ts, cars: r.cars_ahead, est: r.est_wait_min, actual: r.actual_wait_min, platform: r.platform === 'tada' ? 'tada' : 'grab', shared: true });
// Each reading is for one app's queue (Grab or TADA); older ones are Grab's.
const appOf = (r) => (r.platform === 'tada' ? 'tada' : 'grab');
const forApp = (list, app) => list.filter((r) => appOf(r) === app);
const printOf = (r) => JSON.stringify(toRow(r));

async function post(path, body) {
  const key = await db.getKV('apiKey');
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-fareit-key': key } : {}) }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let syncing = null;
// Around this hour, from every driver's readings (Info tab).
export const queueNow = () => queueSummary(all(), Date.now());
// Settings: forget this phone's own readings (the server copies are removed separately).
export async function clearMyQueue() {
  q.mine = [];
  await db.setKV(KEY, []);
  if (q.root) render();
}
export const queueWaitNow = () => queueWait(forApp(all(), platformNow()), Date.now());

// Info's Airport (expanded): for each app, what its queue screen says now (the latest reading under
// QUEUE_FRESH_MIN old: its estimated wait and, for Grab, cars ahead) and the real wait drivers got
// (the latest recorded within 3 hours, else the usual around this hour). Pure, for the page and the tests.
export function queueApps(readings, ts = Date.now()) {
  const out = {};
  for (const app of ['grab', 'tada']) {
    const rs = forApp(readings, app).filter((r) => Number.isFinite(r.ts) && r.ts <= ts + 60000);
    const fresh = rs.filter((r) => ts - r.ts <= QUEUE_FRESH_MIN * 60000 && (r.est > 0 || r.cars != null));
    const latest = fresh.length ? fresh.reduce((a, b) => (b.ts > a.ts ? b : a)) : null;
    const done = rs.filter((r) => r.actual > 0);
    const lastDone = done.filter((r) => ts - (r.ts + r.actual * 60000) <= 3 * 3600000).reduce((a, b) => (!a || b.ts > a.ts ? b : a), null);
    const usual = queueSummary(done, ts);
    out[app] = {
      est: latest && latest.est > 0 ? Math.round(latest.est) : null,
      cars: latest && latest.cars != null ? latest.cars : null,
      at: latest ? latest.ts : null,
      actual: lastDone ? Math.round(lastDone.actual) : usual && usual.actual != null ? Math.round(usual.actual) : null,
      actualAt: lastDone ? lastDone.ts + lastDone.actual * 60000 : null,
      actualN: lastDone ? 1 : usual ? usual.nActual : 0,
    };
  }
  return out;
}
export const queueAppsNow = () => queueApps(all(), Date.now());
// "07:19 (12 min ago)", or a day for older readings.
export function updatedText(at, now = Date.now()) {
  const mins = Math.round((now - at) / 60000);
  if (mins < 60) return mins < 1 ? 'just now' : `${mins} min ago`;
  if (mins < 24 * 60) return hm(at);
  return new Date(at).toLocaleString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
export function waitHtml(w, now = Date.now()) {
  if (!w) return '<p class="note">No queue readings yet.</p>';
  const cars = w.cars != null ? `<b>${Math.round(w.cars)}</b> cars` : '';
  const basis = w.basis === 'usual' ? 'usual for this hour' : '';
  return `<div class="q-wait"><div class="q-wait-min">${w.min != null ? `~${w.min} min` : '—'}</div>
    <div class="note">${[cars, basis, `updated ${updatedText(w.at, now)}`].filter(Boolean).join(' · ')}</div></div>`;
}

export function syncQueue() {
  if (!q.device || !q.root) return Promise.resolve();
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      if (!navigator.onLine) throw new Error('offline');
      const dels = (await db.getKV('queueDeletes')) || [];
      if (dels.length) {
        const r = await post('/api/queue/delete', { device: q.device, ids: dels.slice(0, 50) });
        const done = new Set([...(r.deleted || []), ...(r.missing || [])]);
        await db.setKV('queueDeletes', dels.filter((id) => !done.has(id)));
      }
      const todo = q.mine.filter((r) => r.uploaded !== printOf(r));
      for (let i = 0; i < todo.length; i += 50) {
        const batch = todo.slice(i, i + 50);
        const res = await post('/api/queue', { device: q.device, readings: batch.map(toRow) });
        const seen = new Set([...(res.accepted || []), ...(res.rejected || [])]);
        for (const r of batch) if (seen.has(r.id)) r.uploaded = printOf(r);
      }
      if (todo.length) await db.setKV(KEY, q.mine);
      let cursor = (await db.getKV('queueCursor')) || 0;
      for (let page = 0; page < 20; page++) {
        const res = await fetch(`/api/queue?since=${cursor}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        for (const r of data.readings || []) {
          if (r.deleted) delete q.shared[r.id];
          else q.shared[r.id] = fromRow(r);
        }
        cursor = data.next ?? cursor;
        if (!data.more) break;
      }
      await db.setKV('queueShared', q.shared);
      await db.setKV('queueCursor', cursor);
      q.note = '';
    } catch {
      q.note = 'Couldn’t reach the server. Readings are kept here and will upload later.';
    } finally {
      syncing = null;
      render();
    }
  })();
  return syncing;
}

export async function buildQueue(root) {
  q.root = root;
  q.mine = (await db.getKV(KEY)) || [];
  q.shared = (await db.getKV('queueShared')) || {};
  q.device = await db.getKV('device');
  onMove(() => render());
  root.innerHTML = `
    <div class="band-head">Airport queue · <b id="q-where"></b></div>
    <div id="q-summary"></div>
    <div id="q-form" class="stack">
    <div class="row2">
      <div class="field"><label for="q-cars">Cars ahead</label>
        <input id="q-cars" type="number" inputmode="numeric" step="1" min="0"></div>
      <div class="field"><label for="q-est" id="q-est-label">Grab's wait (min)</label>
        <input id="q-est" type="number" inputmode="numeric" step="1" min="0"></div>
    </div>
    <p class="msg" id="q-msg" role="status"></p>
    <button type="button" class="primary wide" id="q-save">Save</button>
    </div>
    <div id="q-open"></div>
`;
  $('#q-save', root).addEventListener('click', save);
  render();
  syncQueue();
}

async function save() {
  const r = q.root;
  const cars = parseFloat($('#q-cars', r).value);
  const est = parseFloat($('#q-est', r).value);
  const msg = $('#q-msg', r);
  if (!Number.isFinite(cars) && !Number.isFinite(est)) { msg.textContent = 'Add cars ahead or the wait.'; msg.classList.add('err'); return; }
  q.mine.push({
    id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ts: Date.now(),
    cars: Number.isFinite(cars) ? Math.round(cars) : null, est: Number.isFinite(est) ? est : null, actual: null,
    ...(platformNow() === 'tada' ? { platform: 'tada' } : {}),
  });
  await db.setKV(KEY, q.mine);
  $('#q-cars', r).value = '';
  $('#q-est', r).value = '';
  msg.classList.remove('err');
  msg.textContent = '';
  render();
  syncQueue();
}

// Got a job (the main button) closes the open queue reading with the real wait. Returns it, or null.
export async function closeOpenReading() {
  const open = [...q.mine].reverse().find((x) => !(x.actual > 0) && Date.now() - x.ts < OPEN_FOR);
  if (!open) return null;
  await gotJob(open);
  return open;
}

async function gotJob(reading) {
  reading.actual = Math.max(1, Math.round((Date.now() - reading.ts) / 60000));
  await db.setKV(KEY, q.mine);
  q.done = `Waited <b>${reading.actual} min</b>${reading.est ? ` (${appOf(reading) === 'tada' ? 'TADA' : 'Grab'} said ${reading.est})` : ''}. Saved.`;
  q.again = false;
  render();
  syncQueue();
}

// Small Delete (tap twice) for a reading saved by mistake.
function deleteButton(x) {
  let armed = false;
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'ghost small danger';
  del.textContent = 'Delete';
  del.addEventListener('click', async () => {
    if (!armed) { armed = true; del.textContent = 'Tap again'; setTimeout(() => { armed = false; del.textContent = 'Delete'; }, 4000); return; }
    q.mine = q.mine.filter((y) => y.id !== x.id);
    delete q.shared[x.id];
    await db.setKV(KEY, q.mine);
    const dels = (await db.getKV('queueDeletes')) || [];
    await db.setKV('queueDeletes', [...dels, x.id]);
    render();
    syncQueue();
  });
  return del;
}

function render() {
  const r = q.root;
  if (!r) return;
  // On Radar: shown in the airport zone, or anywhere while a reading is still open (to record the wait).
  const openNow = q.mine.some((x) => !(x.actual > 0) && Date.now() - x.ts < OPEN_FOR);
  const inZone = atAirport(here());
  if (!inZone) { q.leftAt = Date.now(); q.again = false; }
  const hideWhy = formHidden(q.mine, { leftAt: q.leftAt, again: q.again });
  r.hidden = !(inZone || openNow);
  $('#q-where', r).textContent = inZone ? `Changi · ${hm(Date.now())}` : 'reading still open';
  const appName = platformNow() === 'tada' ? 'TADA' : 'Grab';
  $('#q-est-label', r).textContent = `${appName}'s wait (min)`;
  // The latest open reading of yours: Got a job closes it with the actual wait.
  const open = [...q.mine].reverse().find((x) => !(x.actual > 0) && Date.now() - x.ts < OPEN_FOR);
  const openBox = $('#q-open', r);
  openBox.innerHTML = '';
  // Already in the queue, or just got a job here: nothing to fill in.
  $('#q-form', r).hidden = Boolean(hideWhy);
  if (hideWhy === 'done') {
    const line = document.createElement('div');
    line.className = 'q-done';
    line.innerHTML = `<span>${q.done || 'Job recorded.'}</span>`;
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'ghost small';
    again.textContent = 'Back in the queue?';
    again.addEventListener('click', () => { q.again = true; q.done = ''; render(); });
    line.append(again);
    openBox.append(line);
  }
  if (open) {
    const mins = Math.round((Date.now() - open.ts) / 60000);
    const card = document.createElement('div');
    card.className = 'card q-open';
    card.innerHTML = `<div class="meta">In queue <b>${mins} min</b>${open.cars != null ? ` · ${open.cars} cars` : ''}${open.est ? ` · ${appOf(open) === 'tada' ? 'TADA' : 'Grab'} said ${open.est}` : ''}</div>`;
    card.append(deleteButton(open));
    openBox.append(card);
  }
  $('#q-summary', r).innerHTML = waitHtml(queueWaitNow()) + (q.note ? `<p class="note">${q.note}</p>` : '');

}
