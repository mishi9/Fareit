import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { resetTokenCache } from '../worker/index.js';

const ENV = { ONEMAP_EMAIL: 'driver@example.com', ONEMAP_PASSWORD: 'secret' };
const realFetch = globalThis.fetch;

function mockOneMap(handlers) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    calls.push({ url, init });
    for (const [match, fn] of handlers) if (url.pathname.includes(match)) return fn(url, init);
    return new Response('not mocked', { status: 500 });
  };
  return calls;
}

const call = (path, env = ENV, headers = {}) => worker.fetch(new Request(`https://fareit.test${path}`, { headers }), env);
const okJson = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
const tokenHandler = ['getToken', () => okJson({ access_token: 'tok-1', expiry_timestamp: String(Math.floor(Date.now() / 1000) + 3 * 86400) })];

test.afterEach(() => {
  globalThis.fetch = realFetch;
  resetTokenCache();
});

test('status reports whether OneMap and a key are configured', async () => {
  const res = await call('/api/status', { ...ENV, APP_KEY: 'k' });
  const body = await res.json();
  assert.deepEqual([body.map, body.keyRequired, body.authorized], [true, true, false]);
});

test('search maps OneMap results to places', async () => {
  mockOneMap([tokenHandler, ['elastic/search', () => okJson({ results: [
    { SEARCHVAL: '111 TAMPINES STREET 11 SINGAPORE 521111', BUILDING: 'NIL', ADDRESS: '111 TAMPINES STREET 11 SINGAPORE 521111', POSTAL: '521111', LATITUDE: '1.3469', LONGITUDE: '103.9474' },
  ] })]]);
  const res = await call('/api/search?q=521111');
  assert.equal(res.status, 200);
  const { results } = await res.json();
  assert.equal(results[0].postal, '521111');
  assert.equal(results[0].lat, 1.3469);
  assert.equal(results[0].label, '111 TAMPINES STREET 11 SINGAPORE 521111');
});

test('route returns road km and minutes and reuses the token', async () => {
  const calls = mockOneMap([tokenHandler, ['routingsvc/route', (url, init) => {
    assert.equal(init.headers.Authorization, 'tok-1');
    assert.equal(url.searchParams.get('routeType'), 'drive');
    return okJson({ route_summary: { total_distance: 45812, total_time: 3120 } });
  }]]);
  const res = await call('/api/route?from=1.3469,103.9474&to=1.3290,103.6420');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { km: 45.81, min: 52, source: 'onemap' });
  await call('/api/route?from=1.3469,103.9474&to=1.3290,103.6420');
  assert.equal(calls.filter((c) => c.url.pathname.includes('getToken')).length, 1);
});

test('route without OneMap credentials explains what to set up', async () => {
  const res = await call('/api/route?from=1.3469,103.9474&to=1.3290,103.6420', {});
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /ONEMAP_EMAIL/);
});

test('route rejects points outside Singapore', async () => {
  const res = await call('/api/route?from=3.1390,101.6869&to=1.3290,103.6420');
  assert.equal(res.status, 400);
});

test('an access key, when set, is required', async () => {
  const env = { ...ENV, APP_KEY: 'letmein' };
  assert.equal((await call('/api/search?q=tampines', env)).status, 401);
  mockOneMap([tokenHandler, ['elastic/search', () => okJson({ results: [] })]]);
  assert.equal((await call('/api/search?q=tampines', env, { 'x-fareit-key': 'letmein' })).status, 200);
});

test('non-api paths go to the static assets', async () => {
  const env = { ASSETS: { fetch: async () => new Response('app shell') } };
  assert.equal(await (await call('/', env)).text(), 'app shell');
});
