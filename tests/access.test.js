import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { resetSchemaFlag } from '../worker/index.js';

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
