// Events (concerts, shows, big official events): added by the owner, shared with every phone.
// They're shown on the Info tab, and trips taken around a venue as an event lets out are kept
// apart from normal estimates (see markEvents in formula.js).
import * as db from './db.js';

const ev = { events: [], venues: [], loaded: false, at: 0, listeners: [] };
const REFRESH = 10 * 60 * 1000;

export const eventsList = () => ev.events;
export const venuesList = () => ev.venues;
export const onEventsChange = (fn) => { ev.listeners.push(fn); };
const emit = () => { for (const fn of ev.listeners) { try { fn(); } catch { /* keep going */ } } };

function take(body) {
  const before = JSON.stringify(ev.events);
  ev.events = (body.events || []).filter((e) => Number.isFinite(e.ends_at));
  ev.venues = body.venues || ev.venues;
  db.setKV('events', { events: ev.events, venues: ev.venues }).catch(() => {});
  if (JSON.stringify(ev.events) !== before) emit();
}

export async function loadEvents(force = false) {
  if (!ev.loaded) {
    ev.loaded = true;
    const saved = await db.getKV('events').catch(() => null);
    if (saved) { ev.events = saved.events || []; ev.venues = saved.venues || []; if (ev.events.length) emit(); }
  }
  if (!force && Date.now() - ev.at < REFRESH) return;
  ev.at = Date.now();
  try {
    const res = await fetch('/api/events');
    if (res.ok) take(await res.json());
  } catch { /* offline: keep the saved list */ }
}

async function send(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Couldn’t reach the server.');
  take(data);
}
export const addEvent = (e) => send('/api/events', e);
export const deleteEvent = (id) => send('/api/events/delete', { id });
