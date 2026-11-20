// Radar's notices at the top (MRT, floods, surge, Changi, events, rain, JB / ferries): each can be
// dismissed with ✕ (hidden for DISMISS_H hours, or until it changes into a different one), and
// each kind can be turned off in Settings. Kept on this phone.
export const NOTICE_KINDS = [
  { id: 'mrt', name: 'MRT disruptions' },
  { id: 'flood', name: 'Flash floods near you' },
  { id: 'surge', name: 'Surging near you' },
  { id: 'airport', name: 'Changi Airport surging' },
  { id: 'event', name: 'Events letting out' },
  { id: 'rain', name: 'Rain' },
  { id: 'place', name: 'Next JB bus / ferry (when you’re there)' },
];
export const DISMISS_H = 3;
const OFF_KEY = 'agaration-notices-off';
const GONE_KEY = 'agaration-notices-dismissed';
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

export const noticeOff = (kind) => read(OFF_KEY, []).includes(kind);
export function setNoticeOff(kind, off) {
  const cur = new Set(read(OFF_KEY, []));
  if (off) cur.add(kind); else cur.delete(kind);
  write(OFF_KEY, [...cur]);
}
const goneKey = (kind, key) => `${kind}|${key}`;
export function dismissed(kind, key, now = Date.now()) {
  const g = read(GONE_KEY, {});
  return Boolean(g[goneKey(kind, key)] && g[goneKey(kind, key)] > now);
}
export function dismiss(kind, key, now = Date.now()) {
  const g = read(GONE_KEY, {});
  for (const k of Object.keys(g)) if (g[k] <= now) delete g[k]; // tidy expired ones
  g[goneKey(kind, key)] = now + DISMISS_H * 3600000;
  write(GONE_KEY, g);
}
const attr = (s) => String(s).replace(/[&<>"']/g, '');
// A notice ready for the page, or '' when its kind is off or it was dismissed.
export function notice(kind, key, html) {
  if (!html || noticeOff(kind) || dismissed(kind, key)) return '';
  return `<div class="notice" data-nkind="${attr(kind)}" data-nkey="${attr(key)}">${html}<button type="button" class="notice-x" aria-label="Dismiss">✕</button></div>`;
}
// One click handler for all of Radar's notices.
export function wireNotices(root, onChange) {
  if (!root || root.dataset.noticesWired) return;
  root.dataset.noticesWired = '1';
  window.addEventListener('agaration-notices', onChange);
  root.addEventListener('click', (ev) => {
    const x = ev.target.closest('.notice-x');
    if (!x) return;
    const n = x.closest('.notice');
    dismiss(n.dataset.nkind, n.dataset.nkey);
    onChange();
  });
}
// Settings: tick the kinds to show.
export function renderNoticeSettings(el) {
  if (!el) return;
  el.innerHTML = NOTICE_KINDS.map((k) => `<button type="button" class="${noticeOff(k.id) ? '' : 'on'}" data-notice="${k.id}"><span class="box"></span>${k.name}</button>`).join('');
  for (const b of el.querySelectorAll('[data-notice]')) b.addEventListener('click', () => { setNoticeOff(b.dataset.notice, !noticeOff(b.dataset.notice)); renderNoticeSettings(el); window.dispatchEvent(new Event('agaration-notices')); });
}
