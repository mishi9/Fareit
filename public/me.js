// You, as an animal and a number (e.g. 🐷 Pig#1726), your points this month and the leaderboard.
// The number is fixed by the server; the animal is picked once (changeable once a month). It's
// the only thing that tells drivers apart: no name, phone number or email.
import { ANIMAL_LIST, animalEmoji, tagOf } from './animals.js';

const me = { data: null, board: null, map: false, loading: null };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function loadMe() {
  if (me.loading) return me.loading;
  me.loading = (async () => {
    try {
      const [a, b] = await Promise.all([fetch('/api/me'), fetch('/api/leaderboard')]);
      if (a.ok) me.data = await a.json();
      if (b.ok) me.board = await b.json();
    } catch { /* offline: keep the last */ }
    me.loading = null;
    renderChip();
    renderBoard();
    if (me.data && !me.data.animal) openPicker();
  })();
  return me.loading;
}
export const myTag = () => (me.data ? tagOf(me.data.animal, me.data.num) : null);

// The header chip: your animal and points when everything works; the map status only when it doesn't.
export function chipOk(ok) { me.map = ok; renderChip(); }
function renderChip() {
  const chip = document.querySelector('#status');
  if (!chip || !me.map) return;
  if (me.data) {
    chip.innerHTML = `<span aria-hidden="true">${animalEmoji(me.data.animal)}</span> <b>${me.data.points ? me.data.points.total : 0}</b>`;
    chip.setAttribute('aria-label', `${myTag()}: ${me.data.points ? me.data.points.total : 0} points this month`);
    chip.className = 'chip ok me-chip';
    chip.onclick = () => { document.querySelector('.tabs [data-view="settings"]')?.click(); setTimeout(() => document.querySelector('#st-board')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80); };
  } else {
    chip.innerHTML = '<span class="live-dot" aria-hidden="true"></span>OneMap';
    chip.className = 'chip ok';
  }
}

const options = (sel) => ANIMAL_LIST.map(([n, e]) => `<option value="${esc(n)}"${n === sel ? ' selected' : ''}>${e} ${esc(n)}</option>`).join('');
async function saveAnimal(animal) {
  const res = await fetch('/api/me/animal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ animal }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Couldn’t save it. Try again.');
  await loadMe();
}

// First time: pick your spirit animal.
function openPicker() {
  if (document.querySelector('#me-picker') || !me.data) return;
  const box = document.createElement('div');
  box.id = 'me-picker';
  box.className = 'me-picker';
  box.setAttribute('role', 'dialog');
  const first = ANIMAL_LIST[Math.floor(Math.random() * ANIMAL_LIST.length)][0];
  box.innerHTML = `<div class="me-card stack">
    <h2>Pick your spirit animal 🐾</h2>
    <p>The owner likes animals, so instead of names, every driver here is an animal and a number.</p>
    <div class="me-pick"><select id="me-animal" aria-label="Animal">${options(first)}</select><b class="me-num">#${String(me.data.num).padStart(4, '0')}</b></div>
    <p class="me-preview">You'll be <b id="me-tag">${esc(tagOf(first, me.data.num))}</b></p>
    <p class="note">It's the only way you're told apart from other drivers: on the leaderboard and nowhere else. No name, phone number or email is ever collected. You can change the animal once a month; the number stays yours.</p>
    <p class="msg" id="me-msg" role="status"></p>
    <button type="button" class="primary wide" id="me-save">That's me</button>
  </div>`;
  document.body.append(box);
  const sel = box.querySelector('#me-animal');
  sel.addEventListener('change', () => { box.querySelector('#me-tag').textContent = tagOf(sel.value, me.data.num); });
  box.querySelector('#me-save').addEventListener('click', async () => {
    try { await saveAnimal(sel.value); box.remove(); } catch (e) { box.querySelector('#me-msg').textContent = e.message; box.querySelector('#me-msg').classList.add('err'); }
  });
}

// Settings: you, your points and the top 10 this month.
export function renderBoard() {
  const el = document.querySelector('#st-board');
  if (!el) return;
  if (!me.data) { el.innerHTML = '<p class="note">Connect to see the leaderboard.</p>'; return; }
  const p = (me.data.points) || { total: 0, jobs: 0, activeDays: 0, streaks: 0, run: 0 };
  const b = me.board || { top: [], me: {}, players: 0 };
  const month = new Date(`${(b.month || '') }-01T00:00:00+08:00`);
  const monthName = Number.isFinite(month.getTime()) ? month.toLocaleDateString('en-SG', { month: 'long' }) : 'this month';
  const rank = b.me.rank ? `#${b.me.rank} of ${b.players}` : 'not on the board yet';
  const gap = b.me.ahead != null && b.me.rank > 1 ? `<span class="note"> · ${b.me.ahead - p.total + 1} point${b.me.ahead - p.total + 1 === 1 ? '' : 's'} to #${b.me.rank - 1}</span>` : '';
  const can = me.data.canChangeAt ? `Next change from ${new Date(me.data.canChangeAt).toLocaleDateString('en-SG', { day: 'numeric', month: 'short' })}.` : 'You can change it now.';
  el.innerHTML = `
    <div class="me-head"><span class="me-big">${esc(myTag())}</span><span><b>${p.total}</b> points · ${rank}${gap}</span></div>
    ${p.held ? '<p class="note">Points are on hold while many of your fares are far from the estimate.</p>' : ''}
    <p class="note">${p.jobs} job${p.jobs === 1 ? '' : 's'} · ${p.activeDays} active day${p.activeDays === 1 ? '' : 's'}${p.run ? ` · on a <b>${p.run}-day</b> streak` : ''}${p.streaks ? ` · ${p.streaks} full week${p.streaks === 1 ? '' : 's'}` : ''}</p>
    <h3 class="me-h3">Top 3 · ${esc(monthName)}</h3>
    ${b.top.length ? `<ol class="me-top">${b.top.map((r, i) => `<li class="${me.data && r.num === me.data.num ? 'you' : ''}"><span class="rk">${i + 1}</span><span>${esc(tagOf(r.animal, r.num))}${r.owner ? ' <span class="note">(owner)</span>' : ''}</span><b>${r.points}</b></li>`).join('')}${!b.me.rank || b.me.rank > b.top.length ? `<li class="you gap"><span class="rk">${b.me.rank || "–"}</span><span>${esc(myTag())}</span><b>${p.total}</b></li>` : ''}</ol>` : '<p class="note">Nobody has points yet this month: be the first.</p>'}
    <p class="note">The top driver this month wins a <b>free month</b> (the owner doesn't count).</p>
    <details class="me-how"><summary>How points work</summary><ul class="st-list">
      <li><b>1 point</b> for every 5 jobs logged (TADA offers count).</li>
      <li><b>+1</b> for each day you log 3 or more jobs.</li>
      <li><b>+3</b> for every 7 days in a row.</li>
      <li>Up to 30 jobs a day count. Points are on hold while many of your fares are far from the estimate.</li>
      <li>Resets on the 1st of every month.</li></ul></details>
    <div class="row2 me-change"><select id="me-change" aria-label="Change animal">${options(me.data.animal)}</select><button type="button" class="ghost" id="me-change-save">Change animal</button></div>
    <p class="note">${can}</p>`;
  el.querySelector('#me-change-save').addEventListener('click', async () => {
    const v = el.querySelector('#me-change').value;
    if (v === me.data.animal) return;
    try { await saveAnimal(v); } catch (e) { const m = document.querySelector('#st-msg'); if (m) { m.textContent = e.message; m.classList.add('err'); } }
  });
}
window.addEventListener('agaration:job', () => setTimeout(() => loadMe(), 3000));
