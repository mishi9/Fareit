import test from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
const { notice, dismiss, dismissed, setNoticeOff, noticeOff, DISMISS_H } = await import('../public/notices.js');

test('notices: ✕ hides one for 3 hours or until it changes; a kind can be turned off', () => {
  assert.ok(notice('rain', 'rain', '<b>Raining</b>').includes('notice-x'));
  const now = Date.now();
  dismiss('rain', 'rain', now);
  assert.equal(notice('rain', 'rain', '<b>Raining</b>'), '', 'dismissed');
  assert.ok(dismissed('rain', 'rain', now + (DISMISS_H - 0.1) * 3600000));
  assert.ok(!dismissed('rain', 'rain', now + (DISMISS_H + 0.1) * 3600000), 'back after 3 hours');
  assert.ok(notice('surge', 'a', 'x') && notice('event', '7', 'x'), 'others still show');
  dismiss('event', '7');
  assert.ok(notice('event', '8', 'x'), 'a different event shows');
  setNoticeOff('surge', true);
  assert.ok(noticeOff('surge') && notice('surge', 'b', 'x') === '');
  setNoticeOff('surge', false);
  assert.ok(notice('surge', 'b', 'x'));
});
