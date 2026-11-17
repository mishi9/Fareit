// Airport queue (beta): when you join the airport queue, note the cars ahead and Grab's estimated
// wait; tap "Got a job" when one comes to record the actual wait. Readings upload to their own
// table on the server (separate from fares and the shared jobs pool) so every driver's readings
// build the picture of how long the queue takes at each hour.
import * as db from './db.js';
import { here, atAirport, onMove } from './where.js';

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

const q = { root: null, device: null, mine: [], shared: {}, note: '' };
const all = () => {
  const mine = new Set(q.mine.map((r) => r.id));
  return [...q.mine, ...Object.values(q.shared).filter((r) => !mine.has(r.id))];
};
const toRow = (r) => ({ id: r.id, ts: r.ts, cars_ahead: r.cars ?? null, est_wait_min: r.est ?? null, actual_wait_min: r.actual ?? null });
const fromRow = (r) => ({ id: r.id, ts: r.ts, cars: r.cars_ahead, est: r.est_wait_min, actual: r.actual_wait_min, shared: true });
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
    <div class="band-head">Airport queue</div>
    <p class="note" id="q-where"></p>
    <p class="note">Joined the queue? Note what Grab shows. When a job comes, tap <b>Got a job</b>: it records how long you really waited, then takes the fare.</p>
    <div class="row2">
      <div class="field"><label for="q-cars">Cars ahead</label>
        <input id="q-cars" type="number" inputmode="numeric" step="1" min="0"></div>
      <div class="field"><label for="q-est">Estimated wait (min)</label>
        <input id="q-est" type="number" inputmode="numeric" step="1" min="0"></div>
    </div>
    <p class="msg" id="q-msg" role="status"></p>
    <button type="button" class="primary wide" id="q-save">Save queue reading</button>
    <div id="q-open"></div>
    <div id="q-summary"></div>
    <div id="q-list" class="stack"></div>`;
  $('#q-save', root).addEventListener('click', save);
  render();
  syncQueue();
}

async function save() {
  const r = q.root;
  const cars = parseFloat($('#q-cars', r).value);
  const est = parseFloat($('#q-est', r).value);
  const msg = $('#q-msg', r);
  if (!Number.isFinite(cars) && !Number.isFinite(est)) { msg.textContent = 'Add the cars ahead or the estimated wait.'; msg.classList.add('err'); return; }
  q.mine.push({
    id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ts: Date.now(),
    cars: Number.isFinite(cars) ? Math.round(cars) : null, est: Number.isFinite(est) ? est : null, actual: null,
  });
  await db.setKV(KEY, q.mine);
  $('#q-cars', r).value = '';
  $('#q-est', r).value = '';
  msg.classList.remove('err');
  msg.textContent = `Saved at ${hm(Date.now())}.`;
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
  $('#q-msg', q.root).textContent = `Waited ${reading.actual} min${reading.est ? ` (Grab estimated ${reading.est})` : ''}. Saved.`;
  render();
  syncQueue();
}

function render() {
  const r = q.root;
  if (!r) return;
  // On Radar: shown in the airport zone, or anywhere while a reading is still open (to record the wait).
  const openNow = q.mine.some((x) => !(x.actual > 0) && Date.now() - x.ts < OPEN_FOR);
  const inZone = atAirport(here());
  r.hidden = !(inZone || openNow);
  $('#q-where', r).textContent = inZone ? `Changi · ${hm(Date.now())}` : 'Shown because a queue reading is still open.';
  // The latest open reading of yours: Got a job closes it with the actual wait.
  const open = [...q.mine].reverse().find((x) => !(x.actual > 0) && Date.now() - x.ts < OPEN_FOR);
  const openBox = $('#q-open', r);
  openBox.innerHTML = '';
  if (open) {
    const mins = Math.round((Date.now() - open.ts) / 60000);
    const card = document.createElement('div');
    card.className = 'card q-open';
    card.innerHTML = `<div class="meta">In the queue since ${hm(open.ts)} (${mins} min)${open.cars != null ? ` · ${open.cars} cars ahead` : ''}${open.est ? ` · Grab estimated ${open.est} min` : ''}. Tap <b>Got a job</b> when one comes.</div>`;
    openBox.append(card);
  }
  const s = queueSummary(all(), Date.now());
  const fmt = (n) => (n == null ? '—' : Math.round(n));
  $('#q-summary', r).innerHTML = s
    ? `<p class="note">Around ${hm(Date.now())} (${s.n} reading${s.n === 1 ? '' : 's'} from all drivers): about <b>${fmt(s.cars)}</b> cars ahead, Grab estimates <b>${fmt(s.est)} min</b>${s.actual != null ? `, actual waits averaged <b>${fmt(s.actual)} min</b> (${s.nActual})` : ''}.</p>`
    : `<p class="note">No queue readings around this hour yet.${q.note ? ` ${q.note}` : ''}</p>`;
  const list = $('#q-list', r);
  list.innerHTML = '';
  for (const x of [...q.mine].reverse().slice(0, 3)) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="meta">${new Date(x.ts).toLocaleString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} · ${x.cars != null ? `${x.cars} cars ahead` : 'cars not noted'} · est ${x.est ? `${x.est} min` : '—'} · ${x.actual > 0 ? `waited ${x.actual} min` : 'wait not recorded'}</div>`;
    const acts = document.createElement('div');
    acts.className = 'acts';
    let armed = false;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost small danger';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!armed) { armed = true; del.textContent = 'Tap again to delete'; setTimeout(() => { armed = false; del.textContent = 'Delete'; }, 4000); return; }
      q.mine = q.mine.filter((y) => y.id !== x.id);
      delete q.shared[x.id];
      await db.setKV(KEY, q.mine);
      const dels = (await db.getKV('queueDeletes')) || [];
      await db.setKV('queueDeletes', [...dels, x.id]);
      render();
      syncQueue();
    });
    acts.append(del);
    card.append(acts);
    list.append(card);
  }
}
