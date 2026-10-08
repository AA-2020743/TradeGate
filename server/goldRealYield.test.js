import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateGoldRealYield, monthEnds, ols } from './goldRealYield.js';

function monthList(from, count) {
  const out = [];
  let [year, month] = from.split('-').map(Number);
  for (let index = 0; index < count; index += 1) {
    out.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return out;
}

function noise(seed) {
  let state = seed;
  return () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648 - 0.5; };
}

// Month-end gold and real yields; gold = exp(7 - 0.2 * yield + shock + drift).
function series({ months = 240, driftFrom = Infinity, driftPerMonth = 0, seed = 3 }) {
  const random = noise(seed);
  const axis = monthList('2003-01', months);
  let level = 1.5;
  const realYield = [];
  const gold = [];
  axis.forEach((month, index) => {
    level += 0.25 * random();
    const drift = index >= driftFrom ? (index - driftFrom) * driftPerMonth : 0;
    realYield.push({ date: `${month}-28`, value: level });
    gold.push({ timestamp: `${month}-28T21:00:00.000Z`, value: Math.exp(7 - 0.2 * level + 0.03 * random() + drift) });
  });
  return { gold, realYield };
}

test('least squares recovers a line and month ends keep the last value of each month', () => {
  const fit = ols([0, 1, 2, 3], [1, 3, 5, 7]);
  assert.ok(Math.abs(fit.slope - 2) < 1e-12 && Math.abs(fit.intercept - 1) < 1e-12);
  assert.equal(fit.r2, 1);
  const ends = monthEnds([{ date: '2026-01-30', value: 2 }, { date: '2026-01-05', value: 1 }, { timestamp: '2026-02-27T21:00:00Z', value: 3 }]);
  assert.deepEqual([...ends.entries()], [['2026-01', { date: '2026-01-30', value: 2 }], ['2026-02', { date: '2026-02-27', value: 3 }]]);
});

test('a relationship that holds keeps gold inside the band and the change correlation strongly negative', () => {
  const result = calculateGoldRealYield(series({}));
  assert.equal(result.status, 'calculated', result.reason);
  // -0.2 log points per point of real yield is about -18% per point.
  assert.ok(Math.abs(result.fit.percentPerPoint + 18.1) < 1.5, `${result.fit.percentPerPoint}`);
  assert.equal(result.outsideBandSince, null);
  assert.ok(Math.abs(result.gapPercent) < result.fit.breakBandPercent);
  assert.ok(result.changes.latest.correlation < -0.4, `${result.changes.latest.correlation}`);
  assert.equal(result.heldOutFrom, '2017-01');
  assert.match(result.read, /within the fit’s usual error band/);
  assert.match(result.read, /gold moved clearly against real yields/);
});

test('a level that drifts away in the held-out months is named as a break, dated from when it left the band', () => {
  const result = calculateGoldRealYield(series({ driftFrom: 200, driftPerMonth: 0.012 }));
  assert.ok(result.gapPercent > 30, `${result.gapPercent}`);
  assert.ok(result.outsideBandSince > '2019-08' && result.outsideBandSince < '2021-01', result.outsideBandSince);
  assert.ok(result.heldOut.meanAbsoluteGapPercent > result.fit.meanAbsoluteGapPercent * 2);
  assert.match(result.read, /above the \$[\d,.]+ its 2003-2016 relationship/);
  assert.match(result.read, new RegExp(`outside that fit’s usual error band \\(±[\\d.]+%\\) since ${result.outsideBandSince}, so the level link has broken`));
});

test('too short a shared history refuses with a reason', () => {
  const result = calculateGoldRealYield(series({ months: 100 }));
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /share 100 months/);
});
