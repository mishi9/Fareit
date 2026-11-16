// Local storage for trips and settings: IndexedDB, with an in-memory fallback so the app still
// works (without keeping data) if storage is blocked.

const NAME = 'fareit';
const VERSION = 2; // v2 adds "shared": the local copy of the shared training pool
let dbPromise = null;
let memoryOnly = false;
const memory = { trips: new Map(), kv: new Map(), shared: new Map() };

const clone = (v) => JSON.parse(JSON.stringify(v));

function openDb() {
  if (!('indexedDB' in globalThis)) return Promise.reject(new Error('IndexedDB unavailable'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(NAME, VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('trips')) d.createObjectStore('trips', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('shared')) d.createObjectStore('shared', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Storage is blocked by another open copy of Fareit'));
    }).catch((e) => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

async function withStore(name, mode, fn) {
  const d = await openDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(name, mode);
    let out;
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    const r = fn(tx.objectStore(name));
    if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
  });
}

export const isMemoryOnly = () => memoryOnly;

export async function allTrips() {
  try {
    return await withStore('trips', 'readonly', (s) => s.getAll());
  } catch {
    memoryOnly = true;
    return [...memory.trips.values()].map(clone);
  }
}

export async function putTrip(trip) {
  const copy = clone(trip);
  try {
    await withStore('trips', 'readwrite', (s) => s.put(copy));
  } catch {
    memoryOnly = true;
    memory.trips.set(copy.id, copy);
  }
}

export async function putTrips(trips) {
  const copies = trips.map(clone);
  try {
    await withStore('trips', 'readwrite', (s) => { for (const t of copies) s.put(t); });
  } catch {
    memoryOnly = true;
    for (const t of copies) memory.trips.set(t.id, t);
  }
}

export async function deleteTrips(ids) {
  try {
    await withStore('trips', 'readwrite', (s) => { for (const id of ids) s.delete(id); });
  } catch {
    memoryOnly = true;
  }
  for (const id of ids) memory.trips.delete(id);
}

export async function clearTrips() {
  try {
    await withStore('trips', 'readwrite', (s) => s.clear());
  } catch {
    memoryOnly = true;
  }
  memory.trips.clear();
}

export async function allShared() {
  try {
    return await withStore('shared', 'readonly', (s) => s.getAll());
  } catch {
    memoryOnly = true;
    return [...memory.shared.values()].map(clone);
  }
}

export async function deleteShared(ids) {
  try {
    await withStore('shared', 'readwrite', (s) => { for (const id of ids) s.delete(id); });
  } catch {
    memoryOnly = true;
  }
  for (const id of ids) memory.shared.delete(id);
}

export async function putShared(rows) {
  const copies = rows.map(clone);
  try {
    await withStore('shared', 'readwrite', (s) => { for (const r of copies) s.put(r); });
  } catch {
    memoryOnly = true;
    for (const r of copies) memory.shared.set(r.id, r);
  }
}

export async function getKV(key) {
  try {
    return await withStore('kv', 'readonly', (s) => s.get(key));
  } catch {
    memoryOnly = true;
    return memory.kv.has(key) ? clone(memory.kv.get(key)) : undefined;
  }
}

export async function setKV(key, value) {
  const copy = value === undefined ? undefined : clone(value);
  try {
    await withStore('kv', 'readwrite', (s) => s.put(copy, key));
  } catch {
    memoryOnly = true;
    memory.kv.set(key, copy);
  }
}
