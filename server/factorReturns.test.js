import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculateFactorReturns, joinFactorTables, momentumCrashConditions, parseFrenchDaily, summarizeFactor } from './factorReturns.js';
import { readLargestTextEntry } from './zip.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-07T12:00:00Z');

/** Business-day rows ending `endAgoDays` before NOW, with chosen daily returns. */
function rows(count, returnFor, endAgoDays = 40) {
  const out = [];
  let time = NOW - (endAgoDays * DAY);
  while (out.length < count) {
    const day = new Date(time).getUTCDay();
    if (day !== 0 && day !== 6) out.unshift({ date: new Date(time).toISOString().slice(0, 10), ...returnFor(count - out.length - 1) });
    time -= DAY;
  }
  return out;
}

const steady = () => ({ 'Mkt-RF': 0.0003, SMB: 0.0001, HML: 0.0001, RMW: 0.0001, CMA: 0.0001, Mom: 0.0002, RF: 0.0001 });

test('the library CSV parses the daily table and stops at the copyright line', () => {
  const text = readLargestTextEntry(readFileSync(new URL('./fixtures/deflated.zip', import.meta.url)));
  const parsed = parseFrenchDaily(text, 'Mom');
  assert.deepEqual(parsed.map((row) => row.date), ['1926-11-03', '1926-11-04']);
  assert.ok(Math.abs(parsed[0].Mom - 0.0056) < 1e-12);
  assert.ok(Math.abs(parsed[1].Mom + 0.005) < 1e-12);
});

test('the parser stops before a second table instead of reading into it', () => {
  // Monthly files follow the table with an annual section whose YYYY rows
  // would otherwise be read as dates.
  const text = 'preamble\n,Mkt-RF,SMB,HML,RMW,CMA,RF\n20260801,0.10,0.20,0.30,0.40,0.50,0.01\n20260802,-0.10,0,0,0,0,0.01\n\n Annual Factors: January-December\n,Mkt-RF,SMB,HML,RMW,CMA,RF\n2025,10,2,3,4,5,4\n';
  const parsed = parseFrenchDaily(text, 'Mkt-RF');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]['Mkt-RF'], 0.001);
  assert.equal(parsed[1].RF, 0.0001);
});

test('missing-value markers are dropped, not read as -99.99% days', () => {
  const parsed = parseFrenchDaily(',Mom\n20260801,0.5\n20260802,-99.99\n20260803,0.4\n', 'Mom');
  assert.deepEqual(parsed.map((row) => row.date), ['2026-08-01', '2026-08-03']);
});

test('joining keeps only dates present in both tables', () => {
  const joined = joinFactorTables([{ date: 'a', HML: 1 }, { date: 'b', HML: 2 }], [{ date: 'b', Mom: 3 }, { date: 'c', Mom: 4 }]);
  assert.deepEqual(joined, [{ date: 'b', HML: 2, Mom: 3 }]);
});

test('trailing returns compound rather than add', () => {
  const factor = summarizeFactor(rows(1500, () => ({ HML: 0.01 })), { key: 'HML', name: 'Value' });
  assert.equal(factor.returns.month, Math.round(((1.01 ** 21) - 1) * 10000) / 100);
  assert.notEqual(factor.returns.month, 21);
});

test('a drawdown is ranked against the factor’s own history', () => {
  // Steady gains then a fall to the deepest point the series has seen.
  const data = rows(2000, (index) => ({ HML: index < 1900 ? 0.0005 : -0.004 }));
  const value = summarizeFactor(data, { key: 'HML', name: 'Value' });
  assert.ok(value.drawdownPercent < -30);
  assert.equal(value.drawdownPercentile, 100, 'deepest drawdown in its own history');
  assert.ok(value.yearPercentile <= 5);
});

test('fewer than five years is refused rather than ranked', () => {
  const result = calculateFactorReturns(rows(800, steady), { now: NOW });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /five years/);
});

test('a two-month-old final observation is the normal cadence; four months is stale', () => {
  assert.equal(calculateFactorReturns(rows(1500, steady, 60), { now: NOW }).stale, false);
  const old = calculateFactorReturns(rows(1500, steady, 130), { now: NOW });
  assert.equal(old.stale, true);
  assert.equal(old.status, 'provisional');
  assert.match(old.freshness, /past the 100-day allowance/);
});

test('momentum crash conditions need both a two-year decline and a sharp rebound', () => {
  const decline = (index, count) => ({ 'Mkt-RF': index > count - 22 ? 0.006 : -0.0006, RF: 0 });
  const both = momentumCrashConditions(rows(600, (index) => decline(index, 600)));
  assert.equal(both.bearBackdrop, true);
  assert.equal(both.sharpRebound, true);
  assert.equal(both.elevated, true);
  const reboundOnly = momentumCrashConditions(rows(600, (index) => ({ 'Mkt-RF': index > 578 ? 0.006 : 0.0004, RF: 0 })));
  assert.equal(reboundOnly.elevated, false);
});

test('the read names leader and laggard with real ordinals and leaves the market out of the style ranking', () => {
  const data = rows(1600, (index) => ({ 'Mkt-RF': 0.002, SMB: -0.0004, HML: 0.0008 * Math.sin(index / 50), RMW: 0.0003, CMA: 0.0001, Mom: 0.0006, RF: 0.0001 }));
  const result = calculateFactorReturns(data, { now: NOW });
  assert.equal(result.status, 'calculated');
  assert.match(result.read, /led the style factors/);
  assert.doesNotMatch(result.read, /market led/);
  assert.doesNotMatch(result.read, /\d(1th|2th|3th)\b/);
  assert.ok(Number.isFinite(result.correlations.valueMomentum));
});

test('a factor whose source file failed says so instead of claiming a short history', () => {
  const data = rows(1500, (index) => ({ 'Mkt-RF': 0.0003, SMB: 0.0001, HML: 0.0001 * Math.sin(index), RMW: 0.0001, CMA: 0.0001, RF: 0.0001 }));
  const result = calculateFactorReturns(data, { now: NOW, missing: { Mom: 'The momentum file could not be read: Upstream request failed with 404' } });
  const momentum = result.factors.find((factor) => factor.key === 'Mom');
  assert.equal(momentum.status, 'unavailable');
  assert.match(momentum.reason, /momentum file could not be read/);
  assert.doesNotMatch(momentum.reason, /five years/);
  assert.equal(result.status, 'provisional');
});
