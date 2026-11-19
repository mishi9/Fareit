// Earnings: a private notebook of what a driver makes across platforms (Grab, TADA, Gojek, Zig…).
// Today at a glance (total after costs, jobs, hours on shift, S$/hour, by platform), a one-tap
// shift timer, a daily goal, and suggestions from the driver's own history. Everything typed here
// stays on this phone (days run 00:00-23:59). Grab jobs saved with Got a job or Log show up here automatically.
import * as db from './db.js';
import { myLabTrips, labReady } from './lab.js';
import { cpfRate, cpfOf, CPF_NET_SHARE, CPF_MONTH_MIN } from './cpf.js';

export const PLATFORMS = [
  { id: 'grab', name: 'Grab', color: '#2fbf6a' },
  { id: 'tada', name: 'TADA', color: '#e0a84a' },
  { id: 'gojek', name: 'Gojek', color: '#5fb3d3' },
  { id: 'zig', name: 'Zig', color: '#b48ce0' },
  { id: 'ryde', name: 'Ryde', color: '#ef5b4f' },
  { id: 'other', name: 'Other', color: '#9aa39e' },
];
export const COSTS = [
  { id: 'fuel', name: 'Fuel / charging' }, { id: 'rental', name: 'Car rental' }, { id: 'parking', name: 'Parking' }, { id: 'other', name: 'Other' },
];
// Fees: money from a platform that isn't a fare (a cancellation fee, a late / waiting fee, a tip).
// They count in your totals and S$/hour, but not as a job, not in per-job or per-km figures, and
// never in the fare estimates (Earnings stays on this phone and doesn't feed the formula).
export const FEES = [
  { id: 'cancel', name: 'Cancellation fee' }, { id: 'late', name: 'Late / waiting fee' }, { id: 'tip', name: 'Tip' }, { id: 'other', name: 'Other' },
];

const KEY = 'earnings';
const e = { root: null, data: { entries: [], shifts: [], goal: null, last: 'grab', cancelled: [] }, mode: 'job', timer: null };
const pad = (n) => String(n).padStart(2, '0');
const hm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const money = (n) => `S$${(Math.round(n * 100) / 100).toFixed(2)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const platform = (id) => PLATFORMS.find((p) => p.id === id) || PLATFORMS[PLATFORMS.length - 1];
const save = () => db.setKV(KEY, e.data);

// The day: the calendar day, 00:00 to 23:59.
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// Everything earned: what was typed here, plus Grab jobs logged with Got a job / Log
export function allJobs() {
  const typed = e.data.entries.filter((x) => x.kind === 'job');
  // A job logged in Log or Got a job that was then cancelled: still real price data (it stays in
  // the estimates), but it's not money you made, so Earnings leaves it out (undo any time).
  const gone = new Set(e.data.cancelled || []);
  const grab = myLabTrips().filter((t) => t.earned > 0 && Number.isFinite(t.ts) && !gone.has(`lab-${t.id}`))
    .map((t) => ({ id: `lab-${t.id}`, ts: t.ts, platform: t.platform === 'tada' ? 'tada' : 'grab', amount: t.earned, cpfBase: t.platform === 'tada' && t.actual > 0 ? t.actual : t.earned, km: t.km || null, auto: true, note: t.dropLabel || '' }));
  return [...typed, ...grab].sort((a, b) => b.ts - a.ts);
}
const costs = () => e.data.entries.filter((x) => x.kind === 'cost');
const fees = () => e.data.entries.filter((x) => x.kind === 'fee');
const feeName = (id) => (FEES.find((f) => f.id === id) || FEES[FEES.length - 1]).name;

// Hours on shift between two moments (a running shift counts up to now).
function shiftHours(from, to, now = Date.now()) {
  let ms = 0;
  for (const s of e.data.shifts) {
    const a = Math.max(s.start, from);
    const b = Math.min(s.end || now, to);
    if (b > a) ms += b - a;
  }
  return ms / 3600000;
}
const running = () => e.data.shifts.find((s) => !s.end) || null;

// A summary for a span of driving days. S$/hour only after an hour on shift (less would mislead).
export function summary(fromTs, toTs, now = Date.now()) {
  const jobs = allJobs().filter((j) => j.ts >= fromTs && j.ts < toTs);
  const spent = costs().filter((c) => c.ts >= fromTs && c.ts < toTs).reduce((s, c) => s + c.amount, 0);
  const feeList = fees().filter((f) => f.ts >= fromTs && f.ts < toTs);
  const feeSum = feeList.reduce((s, f) => s + f.amount, 0);
  const gross = jobs.reduce((s, j) => s + j.amount, 0) + feeSum;
  const hours = shiftHours(fromTs, toTs, now);
  const by = PLATFORMS.map((p) => {
    const js = jobs.filter((j) => j.platform === p.id);
    const fare = js.reduce((s, j) => s + j.amount, 0);
    const fee = feeList.filter((f) => f.platform === p.id).reduce((s, f) => s + f.amount, 0);
    const sum = fare + fee;
    const withKm = js.filter((j) => j.km > 0);
    return { ...p, jobs: js.length, fee, sum, perJob: js.length ? fare / js.length : null, perKm: withKm.length ? withKm.reduce((s, j) => s + j.amount, 0) / withKm.reduce((s, j) => s + j.km, 0) : null };
  }).filter((p) => p.jobs || p.fee);
  const r = cpfRate(e.data.cpf);
  const cpf = r ? jobs.reduce((s, j) => s + cpfOf(j.cpfBase ?? j.amount, r), 0) + feeList.reduce((s, f) => s + cpfOf(f.amount, r), 0) : 0;
  return { jobs, fees: feeList, feeSum, gross, spent, net: gross - spent, hours, perHour: hours >= 1 ? (gross - spent) / hours : null, by, cpf: Math.round(cpf * 100) / 100 };
}

// The day's span: the calendar day, 00:00 to 23:59 (a shift past midnight is split across the two days).
function daySpan(ts = Date.now(), offsetDays = 0) {
  const d = new Date(ts);
  d.setDate(d.getDate() + offsetDays);
  d.setHours(0, 0, 0, 0);
  const end = new Date(d); end.setDate(end.getDate() + 1);
  return [d.getTime(), end.getTime()];
}

// Suggestions from the driver's own last 4 weeks.
export function suggestions(now = Date.now()) {
  const out = [];
  const from = now - 28 * 86400000;
  const s = summary(from, now + 1, now);
  // Platforms: per job and per km
  const plat = s.by.filter((p) => p.jobs >= 3);
  if (plat.length >= 2) {
    const best = [...plat].sort((a, b) => b.perJob - a.perJob)[0];
    const second = [...plat].sort((a, b) => b.perJob - a.perJob)[1];
    if (best.perJob > second.perJob * 1.08) out.push(`<b>${best.name}</b> has paid the most per job lately: <b>${money(best.perJob)}</b> vs ${second.name} ${money(second.perJob)}.`);
    const km = plat.filter((p) => p.perKm);
    if (km.length >= 2) {
      const k = [...km].sort((a, b) => b.perKm - a.perKm);
      out.push(`Per km: <b>${k[0].name} ${money(k[0].perKm)}/km</b>, ${k.slice(1).map((p) => `${p.name} ${money(p.perKm)}`).join(', ')}.`);
    }
  }
  // Best hours: earnings per hour on shift, in 3-hour blocks
  const blocks = Array.from({ length: 8 }, (_, i) => ({ from: i * 3, earn: 0, ms: 0 }));
  for (const sh of e.data.shifts) {
    const end = sh.end || now;
    if (end < from) continue;
    for (let t = Math.max(sh.start, from); t < end; t += 15 * 60000) blocks[Math.floor(new Date(t).getHours() / 3)].ms += Math.min(15 * 60000, end - t);
  }
  for (const j of s.jobs) blocks[Math.floor(new Date(j.ts).getHours() / 3)].earn += j.amount;
  const rated = blocks.filter((b) => b.ms >= 2 * 3600000).map((b) => ({ ...b, rate: b.earn / (b.ms / 3600000) })).sort((a, b) => b.rate - a.rate);
  if (rated.length >= 2) {
    const [b, w] = [rated[0], rated[rated.length - 1]];
    out.push(`Your best hours: <b>${pad(b.from)}:00–${pad((b.from + 3) % 24)}:00</b> at about <b>${money(b.rate)}/h</b>${w.rate < b.rate * 0.8 ? `; slowest ${pad(w.from)}:00–${pad((w.from + 3) % 24)}:00 (${money(w.rate)}/h)` : ''}.`);
  }
  // This week vs last week (same days so far)
  const [d0] = daySpan(now);
  const wd = (new Date(d0).getDay() + 6) % 7; // Monday = 0
  const weekStart = d0 - wd * 86400000;
  const thisWeek = summary(weekStart, now + 1, now);
  const lastWeek = summary(weekStart - 7 * 86400000, now - 7 * 86400000 + 1, now);
  if (thisWeek.net > 0 && lastWeek.net > 0) {
    const ch = thisWeek.net / lastWeek.net - 1;
    out.push(`This week so far: <b>${money(thisWeek.net)}</b>, ${ch >= 0 ? `<b>${Math.round(ch * 100)}% more</b>` : `${Math.round(-ch * 100)}% less`} than by this point last week.`);
  }
  return out;
}

// ---------- the page ----------
export async function buildEarnings(root) {
  e.root = root;
  window.addEventListener('agaration:edited', () => renderEarnings()); // a logged job's fares were fixed
  const saved = await db.getKV(KEY);
  if (saved) e.data = { ...e.data, ...saved };
  root.addEventListener('click', onClick);
  // A job saved in Log or Got a job starts a shift too; and a shift with no jobs for 2 hours ends
  // by itself (checked every minute and whenever the app is opened).
  window.addEventListener('agaration:job', async (ev) => { if (autoStart(ev.detail.ts)) { await save(); renderEarnings(); } });
  const check = async () => { await labReady; if (autoEnd()) { await save(); renderEarnings(); } };
  setInterval(check, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  renderEarnings();
  check();
}

// ---------- shifts that run themselves ----------
// The first job (or fee) with no shift running starts one, AUTO_START_BEFORE_MIN before the job
// (you were driving to it). Not within an hour of a shift you ended yourself.
export const AUTO_START_BEFORE_MIN = 15;
// No job or fee for IDLE_END_H hours: the shift ends by itself, AFTER_LAST_MIN after the last job
// (jobs are logged at pickup, so this covers the trip), and the idle time isn't counted.
export const IDLE_END_H = 2;
export const AFTER_LAST_MIN = 30;
function autoStart(ts) {
  if (running()) return false;
  if (e.data.shifts.some((s) => s.end && !s.auto && ts - s.end < 3600000 && ts >= s.end)) return false;
  e.data.shifts.push({ start: ts - AUTO_START_BEFORE_MIN * 60000, end: null, autoStarted: true });
  e.data.shifts = e.data.shifts.slice(-400);
  return true;
}
const lastActivity = (sh) => Math.max(sh.start, ...allJobs().map((j) => j.ts).filter((t) => t >= sh.start), ...fees().map((f) => f.ts).filter((t) => t >= sh.start));
function autoEnd(now = Date.now()) {
  const sh = running();
  if (!sh) return false;
  const last = lastActivity(sh);
  if (now - last < IDLE_END_H * 3600000) return false;
  sh.end = Math.min(now, last + AFTER_LAST_MIN * 60000);
  sh.auto = 'idle';
  return true;
}

export function renderEarnings() {
  const r = e.root;
  if (!r) return;
  // Keep whatever is being typed across a redraw (the shift clock redraws every minute).
  const keep = Object.fromEntries(['ea-amt', 'ea-km', 'ea-goal'].map((id) => [id, r.querySelector(`#${id}`)?.value]));
  const focused = document.activeElement && r.contains(document.activeElement) ? document.activeElement.id : null;
  const now = Date.now();
  const [d0, d1] = daySpan(now);
  const t = summary(d0, d1, now);
  const sh = running();
  const goal = e.data.goal;
  const toGo = goal ? Math.max(0, goal - t.net) : 0;
  const day = new Date(d0).toLocaleDateString('en-SG', { weekday: 'long', day: 'numeric', month: 'short' });
  const [w0] = daySpan(now, -((new Date(d0).getDay() + 6) % 7));
  const week = summary(w0, now + 1, now);
  const m0 = (() => { const d = new Date(d0); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const month = summary(m0, now + 1, now);
  const todayList = [...t.jobs.map((j) => ({ ...j, kind: 'job' })), ...t.fees, ...costs().filter((c) => c.ts >= d0 && c.ts < d1)].sort((a, b) => b.ts - a.ts);
  const tips = suggestions(now);
  r.innerHTML = `
    <div class="ea-head">
      <div class="band-head">Today · <b>${day}</b></div>
      <div class="ea-total">${money(t.net)}</div>
      <div class="ea-sub">${t.jobs.length} job${t.jobs.length === 1 ? '' : 's'} · ${t.hours ? `${t.hours.toFixed(1)} h on shift` : 'no shift timed'} · <b>${t.perHour != null ? `${money(t.perHour)}/h` : t.hours ? 'S$/h after 1 h' : '—/h'}</b>${t.feeSum ? ` · fees ${money(t.feeSum)}` : ''}${t.spent ? ` · costs ${money(t.spent)}` : ''}</div>
      ${t.cpf ? `<div class="ea-cpf">CPF held <b>${money(t.cpf)}</b> · cash out <b>${money(t.net - t.cpf)}</b></div>` : ''}
      ${goal ? `<div class="ea-goal"><div class="ea-bar"><span style="width:${Math.min(100, (t.net / goal) * 100).toFixed(1)}%"></span></div>
        <div class="note">${t.net >= goal ? `<b>Goal reached</b> (${money(goal)})` : `<b>${money(toGo)}</b> to your ${money(goal)} goal${t.perHour ? ` · about <b>${(toGo / t.perHour).toFixed(1)} h</b> at today's pace` : ''}`}</div></div>` : ''}
      ${sh ? (() => {
        // A running shift is one block, however long and across midnight: its own total and S$/hour.
        const b = summary(sh.start, now + 1, now);
        const h = (now - sh.start) / 3600000;
        return `<div class="ea-shift"><span>This shift · since <b>${hm(sh.start)}</b>${new Date(sh.start).toDateString() !== new Date(now).toDateString() ? ' (yesterday)' : ''} · <b>${h.toFixed(1)} h</b></span><span><b>${money(b.net)}</b> · ${b.jobs.length} job${b.jobs.length === 1 ? '' : 's'}${h >= 1 ? ` · <b>${money(b.net / h)}/h</b>` : ''}</span></div>`;
      })() : ''}
      ${!sh ? (() => { const l = e.data.shifts[e.data.shifts.length - 1]; return l && l.auto === 'idle' && now - l.end < 12 * 3600000 ? `<p class="note">Shift ended by itself at <b>${hm(l.end)}</b>: no jobs for ${IDLE_END_H} h (counted until ${AFTER_LAST_MIN} min after the last one). A new job starts a new shift.</p>` : ''; })() : ''}
      <button type="button" class="${sh ? 'ghost' : 'primary'} wide" data-act="shift">${sh ? 'End shift' : 'Start shift'}</button>
    </div>
    ${t.by.length ? `<div class="ea-plats">${t.by.map((p) => `<div class="ea-plat"><span class="ea-dot" style="background:${p.color}"></span><b>${p.name}</b><span class="note">${p.jobs} job${p.jobs === 1 ? '' : 's'}${p.fee ? ` · fees ${money(p.fee)}` : ''}</span><span class="ea-amt">${money(p.sum)}</span></div>`).join('')}</div>` : ''}

    <div class="ea-add stack">
      <div class="seg g3" data-group="mode"><button type="button" data-mode="job" class="${e.mode === 'job' ? 'sel' : ''}">+ Earning</button><button type="button" data-mode="fee" class="${e.mode === 'fee' ? 'sel' : ''}">+ Fee</button><button type="button" data-mode="cost" class="${e.mode === 'cost' ? 'sel' : ''}">+ Cost</button></div>
      ${e.mode === 'fee'
        ? `<div class="ea-chips">${PLATFORMS.map((p) => `<button type="button" data-plat="${p.id}" class="${e.data.last === p.id ? 'sel' : ''}"><span class="ea-dot" style="background:${p.color}"></span>${p.name}</button>`).join('')}</div>
           <div class="ea-chips">${FEES.map((f) => `<button type="button" data-fee="${f.id}" class="${(e.feeCat || 'cancel') === f.id ? 'sel' : ''}">${f.name}</button>`).join('')}</div>
           <div class="field"><label for="ea-amt">Fee (S$)</label><input id="ea-amt" type="number" inputmode="decimal" step="0.01" min="0"></div>
           <p class="note">Counts in your totals only: not a job, and never in the fare estimates.</p>`
        : e.mode === 'job'
        ? `<div class="ea-chips">${PLATFORMS.map((p) => `<button type="button" data-plat="${p.id}" class="${e.data.last === p.id ? 'sel' : ''}"><span class="ea-dot" style="background:${p.color}"></span>${p.name}</button>`).join('')}</div>
           <div class="row2"><div class="field"><label for="ea-amt">Earned (S$)</label><input id="ea-amt" type="number" inputmode="decimal" step="0.01" min="0"></div>
           <div class="field"><label for="ea-km">Km (optional)</label><input id="ea-km" type="number" inputmode="decimal" step="0.1" min="0"></div></div>`
        : `<div class="ea-chips">${COSTS.map((c) => `<button type="button" data-cost="${c.id}" class="${(e.costCat || 'fuel') === c.id ? 'sel' : ''}">${c.name}</button>`).join('')}</div>
           <div class="field"><label for="ea-amt">Cost (S$)</label><input id="ea-amt" type="number" inputmode="decimal" step="0.01" min="0"></div>`}
      <button type="button" class="primary wide" data-act="add">${addLabel()}</button>
      <p class="msg" id="ea-msg" role="status"></p>
    </div>

    ${tips.length ? `<h2>Suggestions</h2><ul class="ea-tips">${tips.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}

    <h2>Today</h2>
    ${todayList.length ? todayList.map((x) => x.kind === 'cost'
      ? `<div class="ea-row"><span class="ea-time">${hm(x.ts)}</span><span class="ea-what">${esc((COSTS.find((c) => c.id === x.cat) || COSTS[3]).name)}</span><span class="ea-amt cost">−${money(x.amount)}</span>${del(x)}</div>`
      : x.kind === 'fee'
      ? `<div class="ea-row"><span class="ea-time">${hm(x.ts)}</span><span class="ea-what"><span class="ea-dot" style="background:${platform(x.platform).color}"></span>${platform(x.platform).name} · ${esc(feeName(x.cat))}</span><span class="ea-amt">${money(x.amount)}</span>${del(x)}</div>`
      : `<div class="ea-row"><span class="ea-time">${hm(x.ts)}</span><span class="ea-what"><span class="ea-dot" style="background:${platform(x.platform).color}"></span>${platform(x.platform).name}${x.km ? ` · ${x.km} km` : ''}${x.auto ? ' <span class="note">· logged job</span>' : ''}</span><span class="ea-amt">${money(x.amount)}</span>${x.auto ? `<button type="button" class="ghost small" data-cancel="${esc(x.id)}" aria-label="Job was cancelled">✕</button>` : del(x)}</div>`).join('')
      : '<p class="note">Nothing yet today. Add earnings as you go; Grab jobs from Got a job appear here on their own.</p>'}

    ${(() => {
      // Cancelled today (taken out of Earnings): shown so it can be undone.
      const today = myLabTrips().filter((t) => (e.data.cancelled || []).includes(`lab-${t.id}`) && t.ts >= d0 && t.ts < d1);
      return today.length ? `<p class="note ea-cancelled">${today.map((t) => `${hm(t.ts)} · ${t.km} km · ${money(t.earned || 0)} cancelled, not counted <button type="button" class="ghost small" data-undo="lab-${esc(t.id)}">Undo</button>`).join('<br>')}</p>` : '';
    })()}

    <h2>This week and month</h2>
    <div class="tiles">
      <div class="tile"><span class="v">${money(week.net)}</span><span class="k">this week · ${week.hours.toFixed(1)} h · ${week.perHour != null ? `${money(week.perHour)}/h` : '—/h'}</span></div>
      <div class="tile"><span class="v">${money(month.net)}</span><span class="k">this month · ${month.jobs.length} jobs${month.spent ? ` · costs ${money(month.spent)}` : ''}</span></div>
    </div>
    ${month.by.length ? `<div class="ea-plats">${month.by.map((p) => `<div class="ea-plat"><span class="ea-dot" style="background:${p.color}"></span><b>${p.name}</b><span class="note">${p.perJob != null ? `${money(p.perJob)}/job` : 'fees only'}${p.perKm ? ` · ${money(p.perKm)}/km` : ''}${p.fee ? ` · fees ${money(p.fee)}` : ''}</span><span class="ea-amt">${money(p.sum)}</span></div>`).join('')}</div>` : ''}

    <h2>CPF</h2>
    ${cpfHtml(m0, now)}

    <div class="row2">
      <div class="field"><label for="ea-goal">Daily goal (S$)</label><input id="ea-goal" type="number" inputmode="decimal" step="1" min="0" value="${goal || ''}" placeholder="e.g. 200"></div>
      <button type="button" class="ghost" data-act="csv">Download (CSV)</button>
    </div>
    <p class="note">Private: what you type here stays on this phone. Grab jobs from Got a job are already shared anonymously for the estimates.</p>`;
  for (const [id, v] of Object.entries(keep)) { const el = r.querySelector(`#${id}`); if (el && v != null && v !== '' && id !== 'ea-goal') el.value = v; }
  if (focused) r.querySelector(`#${focused}`)?.focus();
  const goalIn = r.querySelector('#ea-goal');
  goalIn.addEventListener('change', async () => { const v = parseFloat(goalIn.value); e.data.goal = v > 0 ? v : null; await save(); renderEarnings(); });
  const born = r.querySelector('#ea-born');
  born.addEventListener('change', async () => { const v = parseInt(born.value, 10); e.data.cpf = { ...(e.data.cpf || {}), birthYear: v > 1900 ? v : null, on: true }; await save(); renderEarnings(); });
  const own = r.querySelector('#ea-cpfrate');
  own.addEventListener('change', async () => { const v = parseFloat(own.value); e.data.cpf = { ...(e.data.cpf || {}), custom: v > 0 ? v : null, on: true }; await save(); renderEarnings(); });
  clearInterval(e.timer);
  if (sh) e.timer = setInterval(() => { if (!r.closest('[hidden]') && r.querySelector('[data-act="shift"]')?.dataset.armed !== '1') renderEarnings(); }, 60000);
}
const addLabel = () => (e.mode === 'job' ? `Add ${platform(e.data.last).name} earning` : e.mode === 'fee' ? `Add ${platform(e.data.last).name} ${feeName(e.feeCat || 'cancel').toLowerCase()}` : 'Add cost');
// The CPF section: this month per platform (into CPF, or given back under S$500 net), and settings.
function cpfHtml(m0, now) {
  const c = e.data.cpf || {};
  const r = cpfRate(c);
  const year = new Date(now).getFullYear();
  const pre = c.birthYear && c.birthYear < 1995;
  const kindText = r ? ({
    full: `Born 1995 or later: <b>full CPF</b>. Your share is <b>${r.rate}%</b> of net (age ${r.age}); the platform adds ${r.operator}%.`,
    optin: `Born before 1995, <b>opted in</b>: full CPF. Your share is <b>${r.rate}%</b> of net (age ${r.age}); the platform adds ${r.operator}%.`,
    medisave: `Born before 1995, <b>not opted in</b>: <b>MediSave only</b>, <b>${r.rate}%</b> of net (age ${r.age}); no platform share.`,
    custom: `Your own rate: <b>${r.rate}%</b> of net.`,
  })[r.kind] : '';
  let month = '';
  if (r) {
    const span = summary(m0, now + 1, now);
    const per = PLATFORMS.map((p) => {
      const base = span.jobs.filter((j) => j.platform === p.id).reduce((s, j) => s + (j.cpfBase ?? j.amount), 0) + span.fees.filter((f) => f.platform === p.id).reduce((s, f) => s + f.amount, 0);
      return { ...p, base, net: base * CPF_NET_SHARE, held: cpfOf(base, r) };
    }).filter((p) => p.base > 0);
    month = per.length ? `<div class="ea-plats">${per.map((p) => `<div class="ea-plat"><span class="ea-dot" style="background:${p.color}"></span><b>${p.name}</b><span class="note">net ${money(p.net)} · ${p.net >= CPF_MONTH_MIN ? 'over S$500: <b>goes into CPF</b>' : `under S$500 so far: <b>given back</b> at month end if it stays under`}</span><span class="ea-amt">${money(p.held)}</span></div>`).join('')}</div>` : '<p class="note">No earnings this month yet.</p>';
  }
  return `<div class="ea-cpf-box stack">
    ${r ? `<p class="note">${kindText} Net = 40% of what you earn on each app (the 60% expense deduction for cars).</p>${month}
      <p class="note">Each app holds it back on every job and settles it per app each month: under S$500 net it's given back, otherwise it goes into CPF. Estimates from CPF's 2026 rates; your statements have the exact amounts.</p>` : '<p class="note">Set up CPF to see what each job leaves you after CPF (cash out). It\u2019s worked out on this phone only.</p>'}
    <div class="row2">
      <div class="field"><label for="ea-born">Year you were born</label><input id="ea-born" type="number" inputmode="numeric" min="1940" max="${year - 16}" value="${c.birthYear || ''}" placeholder="e.g. 1992"></div>
      <div class="field"><label for="ea-cpfrate">Or your own % (optional)</label><input id="ea-cpfrate" type="number" inputmode="decimal" step="0.5" min="0" max="25" value="${c.custom || ''}" placeholder="e.g. 8"></div>
    </div>
    ${pre ? `<div class="field"><span class="flabel">Born before 1995: did you opt in to full CPF?</span><div class="seg g2" id="ea-optin"><button type="button" data-optin="no" class="${c.optIn ? '' : 'sel'}">No (MediSave only)</button><button type="button" data-optin="yes" class="${c.optIn ? 'sel' : ''}">Yes, opted in</button></div></div>` : ''}
    ${r ? '<button type="button" class="ghost small" data-act="cpf-off">Turn CPF off</button>' : ''}
  </div>`;
}
const del = (x) => `<button type="button" class="ghost small" data-del="${esc(x.id)}">✕</button>`;

async function onClick(ev) {
  const b = ev.target.closest('button');
  if (!b || !e.root.contains(b)) return;
  if (b.dataset.mode) { e.mode = b.dataset.mode; renderEarnings(); return; }
  // Picking a platform or cost type: just switch the highlight (no redraw, so nothing typed is lost).
  if (b.dataset.plat || b.dataset.cost || b.dataset.fee) {
    const attr = b.dataset.plat ? 'plat' : b.dataset.cost ? 'cost' : 'fee';
    if (b.dataset.plat) e.data.last = b.dataset.plat; else if (b.dataset.cost) e.costCat = b.dataset.cost; else e.feeCat = b.dataset.fee;
    for (const x of e.root.querySelectorAll(`[data-${attr}]`)) x.classList.toggle('sel', x === b);
    e.root.querySelector('[data-act="add"]').textContent = addLabel();
    e.root.querySelector('#ea-amt')?.focus();
    if (b.dataset.plat) save();
    return;
  }
  if (b.dataset.cancel) {
    // Two taps: the first asks, the second takes it out of Earnings (not out of the estimates).
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Cancelled?'; b.classList.add('danger'); setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = '✕'; b.classList.remove('danger'); } }, 3000); return; }
    e.data.cancelled = [...new Set([...(e.data.cancelled || []), b.dataset.cancel])].slice(-500);
    await save(); renderEarnings(); return;
  }
  if (b.dataset.optin) { e.data.cpf = { ...(e.data.cpf || {}), optIn: b.dataset.optin === 'yes', on: true }; await save(); renderEarnings(); return; }
  if (b.dataset.act === 'cpf-off') { e.data.cpf = { ...(e.data.cpf || {}), on: false }; await save(); renderEarnings(); return; }
  if (b.dataset.undo) {
    e.data.cancelled = (e.data.cancelled || []).filter((id) => id !== b.dataset.undo);
    await save(); renderEarnings(); return;
  }
  if (b.dataset.del) {
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Delete?'; setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = '✕'; } }, 3000); return; }
    e.data.entries = e.data.entries.filter((x) => x.id !== b.dataset.del);
    await save(); renderEarnings(); return;
  }
  const act = b.dataset.act;
  if (act === 'shift') {
    const sh = running();
    // Ending takes a second tap, so a stray tap can't split a shift in two.
    if (sh && b.dataset.armed !== '1') {
      b.dataset.armed = '1'; b.textContent = 'Tap again to end the shift'; b.classList.add('danger');
      setTimeout(() => { if (b.isConnected && b.dataset.armed === '1') { b.dataset.armed = ''; b.textContent = 'End shift'; b.classList.remove('danger'); } }, 4000);
      return;
    }
    if (sh) sh.end = Date.now(); else e.data.shifts.push({ start: Date.now(), end: null });
    e.data.shifts = e.data.shifts.slice(-400);
    await save(); renderEarnings(); return;
  }
  if (act === 'add') {
    const amt = parseFloat(e.root.querySelector('#ea-amt').value);
    const msg = e.root.querySelector('#ea-msg');
    if (!(amt > 0) || amt > 1000) { msg.textContent = 'Type the amount.'; msg.classList.add('err'); return; }
    const id = `ea${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    if (e.mode === 'job') {
      const km = parseFloat(e.root.querySelector('#ea-km').value);
      e.data.entries.push({ id, kind: 'job', ts: Date.now(), platform: e.data.last, amount: Math.round(amt * 100) / 100, km: km > 0 ? km : null });
    } else if (e.mode === 'fee') {
      e.data.entries.push({ id, kind: 'fee', ts: Date.now(), platform: e.data.last, cat: e.feeCat || 'cancel', amount: Math.round(amt * 100) / 100 });
    } else {
      e.data.entries.push({ id, kind: 'cost', ts: Date.now(), cat: e.costCat || 'fuel', amount: Math.round(amt * 100) / 100 });
    }
    // Clear the boxes for the next one (the redraw keeps whatever is still in them).
    for (const id of ['#ea-amt', '#ea-km']) { const el = e.root.querySelector(id); if (el) el.value = ''; }
    if (e.mode !== 'cost') autoStart(Date.now());
    await save(); renderEarnings(); return;
  }
  if (act === 'csv') downloadCsv();
}

function downloadCsv() {
  const rows = [['date', 'time', 'type', 'platform_or_cost', 'amount', 'km', 'note']];
  const all = [...allJobs().map((j) => ({ ...j, kind: 'job' })), ...fees(), ...costs()].sort((a, b) => a.ts - b.ts);
  for (const x of all) {
    const d = new Date(x.ts);
    rows.push([d.toLocaleDateString('en-CA'), d.toTimeString().slice(0, 5), x.kind === 'cost' ? 'cost' : x.kind === 'fee' ? 'fee' : 'earning',
      x.kind === 'cost' ? (COSTS.find((c) => c.id === x.cat) || COSTS[3]).name : platform(x.platform).name, x.amount.toFixed(2), x.km ?? '', x.kind === 'fee' ? feeName(x.cat) : x.note || '']);
  }
  const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const name = `agaration-earnings-${new Date().toISOString().slice(0, 10)}.csv`;
  const file = new File([rows.map((r) => r.map(q).join(',')).join('\n')], name, { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: name }).catch(() => {}); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
