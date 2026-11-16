// Formula tab (beta): type a trip's distance and Grab's time, see the passenger fare the current
// formula predicts, then type the real fare and take-home. Saving re-fits the weights, so the
// next trip is predicted with everything learned so far. Trips stay on this phone (beta only):
// they are never sent to the shared pool.
import * as db from './db.js';
import {
  passengerFare, fitWeights, looError, fitCommission, driverEarns, cutOf, toCsv, MIN_PASSENGER, BASE_TRIPS,
} from './formula.js';

const KEY = 'formulaLab';
const $ = (s, root = document) => root.querySelector(s);
const money = (n) => `S$${Number(n).toFixed(2)}`;
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const num = (el) => {
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : null;
};

const lab = { trips: [], surge: 'normal', root: null };

const weights = () => fitWeights(lab.trips);
const commission = () => fitCommission(lab.trips);

export async function buildLab(root) {
  lab.root = root;
  lab.trips = (await db.getKV(KEY)) || [];
  root.innerHTML = `
    <div class="card lab-formula" id="lab-formula"></div>

    <div class="row2">
      <div class="field"><label for="lab-km">Distance A → B (km)</label>
        <input id="lab-km" type="number" inputmode="decimal" step="0.1" min="0" placeholder="12.4"></div>
      <div class="field"><label for="lab-min">Time from Grab (min)</label>
        <input id="lab-min" type="number" inputmode="decimal" step="1" min="0" placeholder="22"></div>
    </div>
    <div class="row2">
      <div class="field"><label for="lab-erp">ERP / tolls (S$, if any)</label>
        <input id="lab-erp" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0"></div>
      <div class="field"><span class="flabel">Pricing</span>
        <div id="lab-surge" class="seg g2">
          <button type="button" data-v="normal">Normal</button>
          <button type="button" data-v="surge">Surge</button>
        </div></div>
    </div>

    <div class="lab-predict" aria-live="polite">
      <div class="k">Paid by passenger, by the formula</div>
      <div class="v" id="lab-pred">—</div>
      <div class="s" id="lab-pred-sub">Type the distance and time.</div>
    </div>

    <div class="row2">
      <div class="field"><label for="lab-actual">Paid by passenger, actual (S$)</label>
        <input id="lab-actual" type="number" inputmode="decimal" step="0.01" min="0" placeholder="14.00"></div>
      <div class="field"><label for="lab-earned">You earned (S$)</label>
        <input id="lab-earned" type="number" inputmode="decimal" step="0.01" min="0" placeholder="11.20"></div>
    </div>
    <div class="lab-check" id="lab-check"></div>
    <p class="msg" id="lab-msg" role="status"></p>
    <div class="row2">
      <button type="button" class="primary" id="lab-save">Save trip</button>
      <button type="button" class="ghost" id="lab-clear">Clear</button>
    </div>

    <h2>How close it's getting</h2>
    <div id="lab-stats"></div>
    <h2>Grab's cut</h2>
    <div id="lab-cut"></div>
    <h2>Trips</h2>
    <p class="note">Kept on this phone in the beta only, never in the shared pool.</p>
    <div id="lab-list" class="stack"></div>
    <button type="button" class="ghost wide" id="lab-export">Export CSV</button>`;

  for (const id of ['lab-km', 'lab-min', 'lab-erp', 'lab-actual', 'lab-earned']) $(`#${id}`, root).addEventListener('input', update);
  for (const b of root.querySelectorAll('#lab-surge button')) {
    b.addEventListener('click', () => { lab.surge = b.dataset.v; update(); });
  }
  $('#lab-save', root).addEventListener('click', save);
  $('#lab-clear', root).addEventListener('click', clearForm);
  $('#lab-export', root).addEventListener('click', exportCsv);
  renderAll();
}

function renderAll() {
  renderFormula();
  update();
  renderStats();
  renderList();
}

function renderFormula() {
  const w = weights();
  const mine = w.n - BASE_TRIPS.length;
  const basis = mine > 0 ? `Fitted from the base trip and ${mine} of yours.` : 'From the base trip only (11.58 km, paid S$16.80): it sets the level, more trips sort out the split.';
  $('#lab-formula', lab.root).innerHTML = `
    <div class="k">Grab's published formula (Standard, normal pricing)</div>
    <div class="f">Paid by passenger = max(<b>${money(MIN_PASSENGER)}</b>, <b>${money(w.base)}</b> + <b>${money(w.perKm)}</b> × km + <b>${money(w.perMin)}</b> × min) + ERP</div>
    <div class="s">${basis} Weights update every time you save a trip.</div>`;
}

function readForm() {
  const r = lab.root;
  return {
    km: num($('#lab-km', r)), min: num($('#lab-min', r)), erp: num($('#lab-erp', r)) || 0,
    actual: num($('#lab-actual', r)), earned: num($('#lab-earned', r)), surge: lab.surge,
  };
}

// Live: the predicted fare appears as soon as distance and time are in.
function update() {
  const r = lab.root;
  for (const b of r.querySelectorAll('#lab-surge button')) b.classList.toggle('sel', b.dataset.v === lab.surge);
  const f = readForm();
  const pred = $('#lab-pred', r);
  const sub = $('#lab-pred-sub', r);
  const check = $('#lab-check', r);
  if (!(f.km > 0) || !(f.min > 0)) {
    pred.textContent = '—';
    sub.textContent = 'Type the distance and time.';
    check.innerHTML = '';
    return;
  }
  const p = passengerFare(weights(), f.km, f.min, f.erp);
  const c = commission();
  pred.textContent = money(p.fare);
  const cutLabel = c.kind === 'percent+fixed' ? `Grab keeps ${pct(1 - c.keep)} + ${money(-c.fixed)}` : `Grab keeps ${pct(1 - c.keep)} of what the passenger pays${c.n < 3 ? `, from ${c.n} trip${c.n === 1 ? '' : 's'}` : ''}`;
  sub.textContent = `${p.atMinimum ? 'Minimum fare applies. ' : ''}You'd earn about ${money(driverEarns(c, p.fare, f.erp))} (${cutLabel}).${f.surge === 'surge' ? ' Surge: the formula is for normal pricing, so expect the real fare to be higher.' : ''}`;
  const lines = [];
  if (f.actual > 0) {
    const off = p.fare - f.actual;
    const close = Math.abs(off) < 0.005 ? 'Exact.' : `Formula is ${money(Math.abs(off))} ${off > 0 ? 'high' : 'low'} (${pct(Math.abs(off) / f.actual)}).`;
    lines.push(`<span class="${Math.abs(off) <= 0.5 ? 'good' : 'bad'}">${close}</span>`);
  }
  if (f.actual > 0 && f.earned > 0) {
    const cut = cutOf(f);
    lines.push(`Grab kept ${money(cut.cut)} on this trip (${pct(cut.rate)} of what the passenger paid).`);
  }
  check.innerHTML = lines.join(' ');
}

async function save() {
  const f = readForm();
  const msg = $('#lab-msg', lab.root);
  if (!(f.km > 0) || !(f.min > 0)) { msg.textContent = 'Add the distance and the time.'; msg.classList.add('err'); return; }
  if (!(f.actual > 0)) { msg.textContent = 'Add what the passenger actually paid.'; msg.classList.add('err'); return; }
  // The prediction is recorded before this trip changes the weights: an honest test each time.
  const w = weights();
  const predicted = passengerFare(w, f.km, f.min, f.erp).fare;
  const c = commission();
  lab.trips.push({
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ts: Date.now(), ...f,
    predicted, predictedEarned: driverEarns(c, predicted, f.erp),
    weightsBefore: { base: w.base, perKm: w.perKm, perMin: w.perMin },
  });
  await db.setKV(KEY, lab.trips);
  const off = predicted - f.actual;
  msg.classList.remove('err');
  msg.textContent = `Saved. The formula said ${money(predicted)}, real ${money(f.actual)} (${off === 0 ? 'exact' : `${money(Math.abs(off))} ${off > 0 ? 'high' : 'low'}`}). Weights updated.`;
  clearForm(true);
  renderAll();
}

function clearForm(keepMsg) {
  for (const id of ['lab-km', 'lab-min', 'lab-erp', 'lab-actual', 'lab-earned']) $(`#${id}`, lab.root).value = '';
  lab.surge = 'normal';
  if (keepMsg !== true) $('#lab-msg', lab.root).textContent = '';
  update();
}

function renderStats() {
  const box = $('#lab-stats', lab.root);
  const normal = lab.trips.filter((t) => t.surge === 'normal' && t.actual > 0);
  if (!normal.length) { box.innerHTML = '<p class="note">Save a few normal trips. Each one is predicted before it teaches the formula, so this shows how close the guesses are getting.</p>'; return; }
  const offs = normal.map((t) => Math.abs(t.predicted - t.actual));
  const avg = offs.reduce((s, v) => s + v, 0) / offs.length;
  const last5 = offs.slice(-5);
  const avg5 = last5.reduce((s, v) => s + v, 0) / last5.length;
  const loo = looError(lab.trips);
  box.innerHTML = `
    <div class="tiles">
      <div class="tile"><span class="v">${money(avg5)}</span><span class="k">Off on the last ${last5.length} (predicted before saving)</span></div>
      <div class="tile"><span class="v">${money(avg)}</span><span class="k">Off on all ${offs.length}</span></div>
      <div class="tile"><span class="v">${loo ? money(loo.avg) : '—'}</span><span class="k">Off with today's weights${loo ? ` (${pct(loo.pct)})` : ''}</span></div>
      <div class="tile"><span class="v">${normal.filter((t, i) => offs[i] <= 0.1).length}</span><span class="k">Within 10 cents</span></div>
    </div>
    <p class="note">"Off with today's weights" predicts each trip from all the others, the honest test of the current formula.</p>`;
}

function renderCut() {
  const box = $('#lab-cut', lab.root);
  const c = commission();
  const verdict = c.kind === 'flat'
    ? `Looks like a flat <b>${pct(c.avgRate)}</b>.`
    : c.kind === 'percent+fixed'
      ? `Looks like <b>${pct(1 - c.keep)}</b> plus <b>${money(-c.fixed)}</b> per job.`
      : `<b>${pct(c.avgRate)}</b> of what the passenger paid so far${c.n === 1 ? ' (base trip: S$4.70 of S$16.80)' : ''}. 3 trips will show whether it's a flat % or not.`;
  const range = c.n > 1 ? (c.spread < 0.001 ? ` The same on all ${c.n} trips.` : ` Across ${c.n} trips it ranged ${pct(c.lo)}–${pct(c.hi)}.`) : '';
  box.innerHTML = `<p class="note">${verdict}${range}</p>`;
}

function renderList() {
  renderCut();
  const box = $('#lab-list', lab.root);
  box.innerHTML = lab.trips.length ? '' : '<p class="empty">No trips of yours yet.</p>';
  for (const t of [...lab.trips].reverse()) {
    const off = t.predicted - t.actual;
    const cut = cutOf(t);
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="line1"><span class="when">${new Date(t.ts).toLocaleString('en-SG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</span><span class="when">${money(t.actual)}</span></div>
      <div class="meta">${t.km} km · ${t.min} min${t.erp ? ` · ERP ${money(t.erp)}` : ''}${t.surge === 'surge' ? ' · Surge' : ''}</div>
      <div class="meta">Formula said ${money(t.predicted)} (${Math.abs(off) < 0.005 ? 'exact' : `${money(Math.abs(off))} ${off > 0 ? 'high' : 'low'}`})${cut ? ` · earned ${money(t.earned)}, Grab kept ${pct(cut.rate)}` : ''}</div>`;
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
      await db.setKV(KEY, lab.trips);
      renderAll();
    });
    acts.append(del);
    card.append(acts);
    box.append(card);
  }  box.append(baseCard());
}

// The built-in base trip, listed last so it's clear where the starting weights came from.
function baseCard() {
  const t = BASE_TRIPS[0];
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="line1"><span class="when">Base trip (built in)</span><span class="when">${money(t.actual)}</span></div>
    <div class="meta">${t.km} km · ${t.min} min (OneMap) · earned ${money(t.earned)}, Grab kept ${money(cutOf(t).cut)}</div>
    <div class="meta">${t.note}</div>`;
  return card;
}

async function exportCsv() {
  const name = `fareit-formula-${new Date().toISOString().slice(0, 10)}.csv`;
  const file = new File([toCsv(lab.trips)], name, { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch { /* fall back to download */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
