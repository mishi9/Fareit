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

test('an invite works once, for one phone', async () => {
  const { req, owner } = setup();
  const okey = await owner();
  const { token } = (await req('/api/invites/create', { body: { label: 'brother' }, key: okey })).body;
  assert.match(token, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const first = await req('/api/access/redeem', { body: { token, device: 'brother-phone' } });
  assert.equal(first.status, 200);
  assert.equal(first.body.kind, 'driver');
  assert.equal((await req('/api/formula?since=0', { key: first.body.key })).status, 200);

  // shared with someone else: refused
  const second = await req('/api/access/redeem', { body: { token, device: 'stranger-phone' } });
  assert.equal(second.status, 410);

  // same phone again (e.g. its Home Screen app): works, and the old key stops
  const again = await req('/api/access/redeem', { body: { token: token.toLowerCase(), device: 'brother-phone' } });
  assert.equal(again.status, 200);
  assert.equal((await req('/api/access', { key: first.body.key })).status, 401);
  assert.equal((await req('/api/access', { key: again.body.key })).status, 200);
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
