import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateFactorMomentum, monthlyFactorReturns } from './factorMomentum.js';

const FACTORS = [
  { key: 'Mkt-RF', name: 'Market' }, { key: 'SMB', name: 'Size' }, { key: 'HML', name: 'Value' },
  { key: 'RMW', name: 'Profitability' }, { key: 'CMA', name: 'Investment' }, { key: 'Mom', name: 'Momentum' },
];

function noise(seed) {
  let state = seed;
  return () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648 - 0.5; };
}

// Twenty trading days a month from 1990. With `persistent`, each factor's
// drift flips sign every few years, so its past year carries over into the
// next months; without it every month is fresh noise.
function factorRows({ years = 30, persistent = true, seed = 7 } = {}) {
  const random = noise(seed);
  const rows = [];
  for (let month = 0; month < years * 12; month += 1) {
    const year = 1990 + Math.floor(month / 12);
    const monthNumber = String((month % 12) + 1).padStart(2, '0');
    const drifts = FACTORS.map((_factor, index) => (persistent ? (Math.floor((month + index * 7) / 40) % 2 ? 0.0012 : -0.0012) : 0));
    for (let day = 1; day <= 20; day += 1) {
      const row = { date: `${year}-${monthNumber}-${String(day).padStart(2, '0')}` };
      FACTORS.forEach((factor, index) => { row[factor.key] = drifts[index] + 0.012 * random(); });
      rows.push(row);
    }
  }
  return rows;
}

test('daily rows compound into calendar months', () => {
  const months = monthlyFactorReturns([{ date: '2026-01-02', A: 0.1 }, { date: '2026-01-05', A: 0.1 }, { date: '2026-02-02', A: -0.5 }], ['A']);
  assert.equal(months.length, 2);
  assert.ok(Math.abs(months[0].A - 0.21) < 1e-12);
  assert.equal(months[1].A, -0.5);
});

test('when drifts persist, factors off a positive year lead the next month, in and out of sample', () => {
  const result = calculateFactorMomentum(factorRows({ persistent: true }), FACTORS);
  assert.equal(result.status, 'calculated', result.reason);
  const horizon = result.record.horizons.find((entry) => entry.days === 30);
  assert.equal(horizon.development.ordering, 1);
  assert.equal(horizon.heldOut.ordering, 1);
  assert.ok(result.winnersMinusLosers.heldOut.meanMonthly > 0);
  assert.equal(result.current.length, 6);
  assert.match(result.read, /a factor coming off a positive year earned a median \+[\d.]+% the next month against -[\d.]+% after a negative one/);
  assert.match(result.read, /Holding the past year’s winners against its losers returned a mean \+[\d.]+% a month in the held-out block/);
});

test('with no persistence the winners-minus-losers spread is near zero', () => {
  const result = calculateFactorMomentum(factorRows({ persistent: false, seed: 11 }), FACTORS);
  assert.ok(Math.abs(result.winnersMinusLosers.all.meanMonthly) < 0.3, `${result.winnersMinusLosers.all.meanMonthly}`);
});

test('too short a history refuses with a reason', () => {
  const result = calculateFactorMomentum(factorRows({ years: 8 }), FACTORS);
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /Needs 132 months of factor returns; 96 available/);
});
