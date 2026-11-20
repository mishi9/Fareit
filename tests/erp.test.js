import test from 'node:test';
import assert from 'node:assert/strict';
import { ERP_GROUPS, erpNow, hhmm, incidentsOn, routeChoices } from '../public/erp.js';

const at = (s) => Date.parse(`${s}+08:00`);
const pieChangi = ERP_GROUPS.find((g) => g.road === 'PIE|2');

test('ERP: from LTA\'s table, weekdays only; now, next and when it stops', () => {
  assert.ok(ERP_GROUPS.length >= 15 && ERP_GROUPS.every((g) => g.wkd.length && g.gantries.length));
  const before = erpNow(pieChangi, at('2026-11-23T07:20:00')); // Monday
  assert.equal(before.now, 0);
  assert.deepEqual([hhmm(before.next.at), before.next.amount], ['07:30', 1]);
  const peak = erpNow(pieChangi, at('2026-11-23T08:10:00'));
  assert.equal(peak.now, 2);
  assert.deepEqual([hhmm(peak.next.at), peak.next.amount, hhmm(peak.next.ends)], ['08:25', 1.5, '09:30']);
  assert.equal(erpNow(pieChangi, at('2026-11-23T10:00:00')).next, null, 'done for the day');
  assert.ok(erpNow(pieChangi, at('2026-11-22T08:10:00')).free, 'Sunday: no ERP');
  assert.ok(erpNow(pieChangi, at('2026-11-21T08:10:00')).free, 'Saturday: none in this table');
  assert.ok(erpNow(pieChangi, at('2026-11-23T08:10:00'), true).free, 'public holiday');
});

test('routes: picked from LTA travel times; incidents kept by road and direction', () => {
  const routes = routeChoices([{ name: 'PIE', dir: 1, to: 'TUAS' }, { name: 'PIE', dir: 2, to: 'CHANGI AIRPORT' }]);
  assert.deepEqual(routes.map((r) => r.key), ['PIE|1', 'PIE|2', 'CITY']);
  const inc = [
    { type: 'Accident', msg: '(20/11)17:05 Accident on PIE (towards Tuas) after Clementi Ave 6 Exit.' },
    { type: 'Vehicle breakdown', msg: '(20/11)17:10 Vehicle breakdown on PIE (towards Changi Airport) at Adam Rd.' },
    { type: 'Accident', msg: '(20/11)17:12 Accident on CTE (towards AYE) after Braddell Rd.' },
    { type: 'Heavy Traffic', msg: '(20/11)17:15 Heavy traffic on PIE near Toa Payoh.' },
  ];
  assert.deepEqual(incidentsOn(routes[0], inc).map((x) => x.type), ['Accident', 'Heavy Traffic']);
  assert.deepEqual(incidentsOn(routes[1], inc).map((x) => x.type), ['Vehicle breakdown', 'Heavy Traffic']);
});
