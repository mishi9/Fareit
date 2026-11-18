import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { resetSchemaFlag, FLIGHT_SOURCES, summarizeArrivals, terminalOf } from '../worker/index.js';

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    exec: () => db.prepare(sql).run(...args),
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) s.exec(); return []; } };
}

function setup(extra = {}) {
  const env = { DB: fakeD1(), INVITE_ONLY: '1', ...extra };
  const req = async (path, { body, key, ip = '1.2.3.4' } = {}) => {
    const headers = { 'cf-connecting-ip': ip };
    if (key) headers['x-agaration-key'] = key;
    if (body) headers['content-type'] = 'application/json';
    const r = await worker.fetch(new Request(`https://agaration.test${path}`, {
      method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
    }), env);
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() : await r.text() };
  };
  const owner = async () => (await req('/api/owner/claim', { body: { code: '804613', device: 'owner-phone-1' } })).body.key;
  return { env, req, owner };
}

test.beforeEach(() => resetSchemaFlag());

test('invite-only: data needs a let-in phone', async () => {
  const { req } = setup();
  const r = await req('/api/formula?since=0');
  assert.equal(r.status, 401);
  assert.equal(r.body.locked, true);
  assert.equal((await req('/api/status')).body.inviteOnly, true);
});

test('the owner code gives an owner key; a wrong one does not', async () => {
  const { req, owner } = setup();
  assert.equal((await req('/api/owner/claim', { body: { code: '111111', device: 'owner-phone-1' } })).status, 403);
  const key = await owner();
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.deepEqual((await req('/api/access', { key })).body, { ok: true, kind: 'owner' });
  assert.equal((await req('/api/formula?since=0', { key })).status, 200);
});

test('the owner code can be changed with OWNER_CODE', async () => {
  const { req } = setup({ OWNER_CODE: '999000' });
  assert.equal((await req('/api/owner/claim', { body: { code: '804613', device: 'owner-phone-1' } })).status, 403);
  assert.equal((await req('/api/owner/claim', { body: { code: '999000', device: 'owner-phone-1' } })).status, 200);
});

test('owner code guesses are limited to 10 an hour', async () => {
  const { req } = setup();
  for (let i = 0; i < 10; i++) await req('/api/owner/claim', { body: { code: String(100000 + i), device: 'owner-phone-1' } });
  const r = await req('/api/owner/claim', { body: { code: '804613', device: 'owner-phone-1' } });
  assert.equal(r.status, 429);
  // another connection is unaffected
  assert.equal((await req('/api/owner/claim', { body: { code: '804613', device: 'owner-phone-1' }, ip: '5.6.7.8' })).status, 200);
});

test('an invite works for 60 minutes after it is first opened, one phone at a time', async (t) => {
  const { req, owner } = setup();
  const okey = await owner();
  const { token } = (await req('/api/invites/create', { body: { label: 'brother' }, key: okey })).body;
  assert.match(token, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  let now = Date.now() + 3 * 86400 * 1000; // links don't age before they're opened
  t.mock.method(Date, 'now', () => now);

  const opened = await req('/api/access/open', { body: { token } });
  assert.equal(opened.body.expires_at, now + 60 * 60 * 1000);

  now += 10 * 60 * 1000;
  const first = await req('/api/access/redeem', { body: { token, device: 'brother-safari' } });
  assert.equal(first.status, 200);
  assert.equal(first.body.kind, 'driver');
  assert.equal((await req('/api/formula?since=0', { key: first.body.key })).status, 200);

  // within the hour, another use (e.g. the Home Screen app) takes over; the older phone stops
  now += 20 * 60 * 1000;
  const second = await req('/api/access/redeem', { body: { token: token.toLowerCase(), device: 'brother-homescreen' } });
  assert.equal(second.status, 200);
  assert.equal((await req('/api/access', { key: first.body.key })).status, 401);
  assert.equal((await req('/api/access', { key: second.body.key })).status, 200);

  // after 60 minutes from first opening, the link is dead; the phone that's in stays in
  now += 31 * 60 * 1000;
  const late = await req('/api/access/redeem', { body: { token, device: 'stranger-phone' } });
  assert.equal(late.status, 410);
  assert.equal(late.body.expired, true);
  assert.equal((await req('/api/access/open', { body: { token } })).status, 410);
  assert.equal((await req('/api/access', { key: second.body.key })).status, 200);
});

test('redeeming starts the hour too, when the link was never opened first', async (t) => {
  const { req, owner } = setup();
  const okey = await owner();
  const { token } = (await req('/api/invites/create', { body: {}, key: okey })).body;
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  assert.equal((await req('/api/access/redeem', { body: { token, device: 'android-phone' } })).status, 200);
  const row = (await req('/api/invites', { key: okey })).body.invites[0];
  assert.equal(row.expires_at, now + 60 * 60 * 1000);
  now += 61 * 60 * 1000;
  assert.equal((await req('/api/access/redeem', { body: { token, device: 'other-phone' } })).status, 410);
});

test('a made-up invite is refused', async () => {
  const { req } = setup();
  assert.equal((await req('/api/access/redeem', { body: { token: 'ABCD-EFGH-JKMN', device: 'some-phone-1' } })).status, 404);
  assert.equal((await req('/api/access/redeem', { body: { token: 'nope', device: 'some-phone-1' } })).status, 400);
});

test('drivers cannot make invites; the owner lists and revokes them', async () => {
  const { req, owner } = setup();
  const okey = await owner();
  const { token } = (await req('/api/invites/create', { body: { label: 'brother' }, key: okey })).body;
  const dkey = (await req('/api/access/redeem', { body: { token, device: 'brother-phone' } })).body.key;
  assert.equal((await req('/api/invites/create', { body: {}, key: dkey })).status, 403);
  assert.equal((await req('/api/invites', { key: dkey })).status, 403);

  const list = (await req('/api/invites', { key: okey })).body.invites;
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'brother');
  assert.ok(list[0].used_at > 0);

  assert.equal((await req('/api/invites/revoke', { body: { token }, key: okey })).status, 200);
  assert.equal((await req('/api/formula?since=0', { key: dkey })).status, 401);
  assert.equal((await req('/api/access/redeem', { body: { token, device: 'brother-phone' } })).status, 404);
});

test('the invite manifest opens the Home Screen app with the invite', async () => {
  const { req } = setup();
  const m = (await req('/api/manifest?invite=abcd-efgh-jkmn')).body;
  assert.equal(m.name, 'Agaration');
  assert.equal(m.start_url, '/?invite=ABCD-EFGH-JKMN#window');
  const plain = (await req('/api/manifest?invite=<script>')).body;
  assert.equal(plain.start_url, '/#window');
});

test('without INVITE_ONLY the app stays open', async () => {
  const { req } = setup({ INVITE_ONLY: undefined });
  assert.equal((await req('/api/formula?since=0')).status, 200);
});

test('each invite gets its own animal code name, never shown to the tester', async () => {
  const { req, owner } = setup();
  const okey = await owner();
  const a = (await req('/api/invites/create', { body: {}, key: okey })).body;
  const b = (await req('/api/invites/create', { body: {}, key: okey })).body;
  assert.ok(a.animal && b.animal && a.animal !== b.animal);
  const redeemed = await req('/api/access/redeem', { body: { token: a.token, device: 'tester-phone' } });
  assert.equal(JSON.stringify(redeemed.body).includes(a.animal), false);
  assert.equal((await req('/api/access', { key: redeemed.body.key })).body.animal, undefined);
});

test('what a tester sends is traced to their code name', async () => {
  const { req, owner } = setup();
  const okey = await owner();
  const { token, animal } = (await req('/api/invites/create', { body: {}, key: okey })).body;
  const key = (await req('/api/access/redeem', { body: { token, device: 'tester-phone' } })).body.key;
  const trip = { id: 'trip-trace-0001', ts: Date.now() - 60000, km: 12.3, min: 20, erp: 0, paid: 22.5, earned: 16.4, surge: 'normal' };
  const r = await req('/api/formula', { body: { device: 'app-device-0001', trips: [trip] }, key });
  assert.equal(r.status, 200);
  const list = (await req('/api/invites', { key: okey })).body.invites;
  const row = list.find((i) => i.token === token);
  assert.equal(row.animal, animal);
  assert.equal(row.trips, 1);
  assert.equal(row.jobs, 0);
  assert.ok(row.last_at > 0);
});

test('arrivals are counted per terminal: landed, next hour, the hour after', () => {
  const now = Date.UTC(2026, 10, 18, 12, 0);
  const m = 60000;
  const s = summarizeArrivals([
    { t: now - 10 * m, terminal: 'T1' }, { t: now + 5 * m, terminal: '1' }, { t: now + 59 * m, terminal: 'Terminal 1' },
    { t: now + 61 * m, terminal: 'T3' }, { t: now + 30 * m, terminal: 'T3', cancelled: true },
    { t: now - 45 * m, terminal: 'T2' }, { t: now + 3 * 60 * m, terminal: 'T4' }, { t: now + 10 * m, terminal: null },
  ], now);
  assert.deepEqual(s.terminals.T1, { landed: 1, next: 2, later: 0 });
  assert.deepEqual(s.terminals.T3, { landed: 0, next: 0, later: 1 });
  assert.deepEqual(s.terminals.T2, { landed: 0, next: 0, later: 0 });
  assert.equal(s.unknown, 1);
  assert.equal(terminalOf('Terminal 4'), 'T4');
});

test('flights: not set up until a provider and key are given; one fetch is shared', async (t) => {
  const { req, owner } = setup();
  const key = await owner();
  assert.deepEqual((await req('/api/flights', { key })).body, { ready: false });
  assert.equal((await req('/api/flights')).status, 401); // invite-only like everything else

  let calls = 0;
  const now = Date.now();
  FLIGHT_SOURCES.fake = async () => { calls++; return [{ t: now + 10 * 60000, terminal: 'T2' }, { t: now + 20 * 60000, terminal: '2' }]; };
  t.after(() => { delete FLIGHT_SOURCES.fake; });
  const env = { FLIGHTS_PROVIDER: 'fake', FLIGHTS_KEY: 'k' };
  resetSchemaFlag(); // a second database in the same test
  const s2 = setup(env);
  const k2 = await s2.owner();
  const a = (await s2.req('/api/flights', { key: k2 })).body;
  assert.equal(a.ready, true);
  assert.equal(a.terminals.T2.next, 2);
  await s2.req('/api/flights', { key: k2 });
  assert.equal(calls, 1);

  // the service fails later: the last list is still shown, marked stale
  FLIGHT_SOURCES.fake = async () => { throw new Error('down'); };
  t.mock.method(Date, 'now', () => now + 31 * 60000);
  const b = (await s2.req('/api/flights', { key: k2 })).body;
  assert.equal(b.stale, true);
  assert.equal(b.terminals.T2.landed, 2);
});

test('events: anyone let in can read them; only the owner adds or deletes', async () => {
  const { req, owner } = setup();
  const okey = await owner();
  const { token } = (await req('/api/invites/create', { body: {}, key: okey })).body;
  const dkey = (await req('/api/access/redeem', { body: { token, device: 'driver-phone' } })).body.key;
  const ends = Date.now() + 3 * 3600000;
  assert.equal((await req('/api/events', { body: { name: 'Concert', venue: 'indoor-stadium', ends_at: ends }, key: dkey })).status, 403);
  assert.equal((await req('/api/events', { body: { name: 'Concert', venue: 'nowhere', ends_at: ends }, key: okey })).status, 400);
  const added = await req('/api/events', { body: { name: 'Concert', venue: 'indoor-stadium', starts_at: ends - 3 * 3600000, ends_at: ends }, key: okey });
  assert.equal(added.status, 200);
  const list = (await req('/api/events', { key: dkey })).body;
  assert.equal(list.events.length, 1);
  assert.equal(list.events[0].venue_name, 'Singapore Indoor Stadium');
  assert.ok(list.events[0].lat > 1.29 && list.venues.length > 10);
  assert.equal((await req('/api/events', {})).status, 401);
  assert.equal((await req('/api/events/delete', { body: { id: list.events[0].id }, key: dkey })).status, 403);
  assert.equal((await req('/api/events/delete', { body: { id: list.events[0].id }, key: okey })).body.events.length, 0);
});

test('info: taxis at Changi, fetched once and shared', async (t) => {
  const { req, owner } = setup();
  const key = await owner();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    if (String(url).includes('traffic-images')) {
      return new Response(JSON.stringify({ items: [{ cameras: [
        { camera_id: '2701', image: 'https://images.data.gov.sg/a.jpg', timestamp: '2026-11-18T07:21:22+08:00' },
        { camera_id: '1001', image: 'https://images.data.gov.sg/b.jpg', timestamp: '2026-11-18T07:21:22+08:00' },
        { camera_id: '4713', image: 'https://images.data.gov.sg/c.jpg', timestamp: '2026-11-18T07:21:22+08:00' },
      ] }] }));
    }
    return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [[103.9890, 1.3600], [103.9860, 1.3560], [103.85, 1.30]] }, properties: { timestamp: '2026-11-18T07:23:34+08:00' } }] }));
  });
  const a = (await req('/api/info', { key })).body;
  assert.equal(a.cameras, undefined, 'camera feed removed');
  assert.equal(a.taxis.changi, 2);
  assert.equal(a.taxis.total, 3);
  assert.equal(a.lta.ready, false);
  await req('/api/info', { key });
  assert.equal(calls, 1, 'second request uses the shared copy');
});

test('surge points: Surge-tagged trips from the last 30 min, one tag per phone, ids never sent', async () => {
  const { req, owner } = setup();
  const key = await owner();
  const mk = (id, mins, extra = {}) => ({ id, ts: Date.now() - mins * 60000, km: 8, min: 15, erp: 0, paid: 20, earned: 14, surge: 'surge', lat: 1.30, lng: 103.83, ...extra });
  await req('/api/formula', { body: { device: 'phone-aaaa-1', trips: [mk('trip-s-0001', 5), mk('trip-s-0002', 3), mk('trip-s-0003', 50)] }, key });
  await req('/api/formula', { body: { device: 'phone-bbbb-2', trips: [mk('trip-s-0004', 2), mk('trip-s-0005', 2, { surge: 'normal' })] }, key });
  const pts = (await req('/api/surge', { key })).body.points;
  assert.equal(pts.length, 3, 'normal and older-than-30-min trips left out');
  assert.equal(new Set(pts.map((p) => p.d)).size, 2);
  assert.ok(pts.every((p) => !String(p.d).includes('phone')), 'device ids are never sent out');
  assert.equal((await req('/api/surge')).status, 401);
});

test('LTA DataMall: incidents, travel times, MRT and floods, key sent as AccountKey', async (t) => {
  const { req, owner } = setup({ LTA_KEY: 'test-account-key' });
  const key = await owner();
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const u = String(url);
    if (u.includes('datamall2.mytransport.sg')) {
      seen.push({ u, key: init.headers && init.headers.AccountKey });
      if (u.includes('TrafficIncidents')) return new Response(JSON.stringify({ value: [
        { Type: 'Vehicle breakdown', Latitude: 1.30398068448214, Longitude: 103.919182834377, Message: '(29/3)18:22 Vehicle breakdown on ECP (towards Changi Airport) after Still Rd Sth Exit. Avoid lane 3.' },
        { Type: 'Roadwork', Latitude: 1.35, Longitude: 103.85, Message: 'Roadworks on CTE' },
      ] }));
      if (u.includes('EstTravelTimes')) return new Response(JSON.stringify({ value: [
        { Name: 'AYE', Direction: 1, FarEndPoint: 'TUAS CHECKPOINT', StartPoint: 'AYE/MCE INTERCHANGE', EndPoint: 'TELOK BLANGAH RD', EstTime: 2 },
        { Name: 'AYE', Direction: 1, FarEndPoint: 'TUAS CHECKPOINT', StartPoint: 'TELOK BLANGAH RD', EndPoint: 'CLEMENTI AVE 6', EstTime: 9 },
        { Name: 'AYE', Direction: 2, FarEndPoint: 'MCE', StartPoint: 'TUAS', EndPoint: 'JURONG', EstTime: 5 },
      ] }));
      if (u.includes('TrainServiceAlerts')) return new Response(JSON.stringify({ value: { Status: 2,
        AffectedSegments: [{ Line: 'NEL', Direction: 'Punggol', Stations: 'NE1,NE3,NE4,NE5,NE6', FreePublicBus: 'NE1,NE3,NE4,NE5,NE6' }],
        Message: [{ Content: '1710hrs: NEL – No train service between Harbourfront to Dhoby Ghaut stations towards Punggol station due to a signalling fault.', CreatedDate: '2026-11-18 17:10:00' }] } }));
      if (u.includes('PubFloodAlerts')) return new Response('not here', { status: 500 }); // one feed failing doesn't stop the rest
    }
    return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [] }, properties: {} }] }));
  });
  const b = (await req('/api/info', { key })).body;
  assert.ok(seen.length >= 4 && seen.every((s) => s.key === 'test-account-key'));
  assert.equal(b.lta.ready, true);
  assert.equal(b.lta.incidents.length, 2);
  assert.equal(b.lta.incidents[0].type, 'Vehicle breakdown');
  const aye = b.lta.travel.filter((x) => x.name === 'AYE');
  assert.equal(aye.find((x) => x.dir === 1).min, 11);
  assert.equal(aye.find((x) => x.dir === 1).to, 'TUAS CHECKPOINT');
  assert.equal(b.lta.train.major, true);
  assert.equal(b.lta.train.lines[0].line, 'NEL');
  assert.equal(b.lta.floods, undefined);
  assert.equal(b.lta.errors.length, 1);
});
