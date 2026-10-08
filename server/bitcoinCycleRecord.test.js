import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBitcoinCycleRecord } from './bitcoinCycleRecord.js';

// Eleven years of daily prices swinging through four-year cycles around a
// rising trend. MVRV-Z is read off the price against its slow average and the
// short-term holders' cost basis is the 155-day average, as their shapes are.
function cycles({ days = 4000, seed = 3 } = {}) {
  let state = seed;
  const random = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648 - 0.5; };
  const prices = [];
  const mvrv = [];
  const sth = [];
  const closes = [];
  for (let day = 0; day < days; day += 1) {
    const date = new Date(Date.UTC(2014, 8, 17) + day * 86_400_000).toISOString().slice(0, 10);
    const value = 500 * Math.exp(0.0009 * day + 1.1 * Math.sin((2 * Math.PI * day) / 1460) + 0.03 * random());
    closes.push(value);
    prices.push({ date, value });
    const slow = closes.slice(-730).reduce((total, entry) => total + entry, 0) / Math.min(730, closes.length);
    mvrv.push({ d: date, mvrvZscore: String((value / slow - 1) * 2.5) });
    const recent = closes.slice(-155);
    sth.push({ d: date, sthRealizedPrice: String(recent.reduce((total, entry) => total + entry, 0) / recent.length) });
  }
  return { prices, mvrv, sth };
}

test('the replay labels weeks with the live phase model and reports what followed each label', () => {
  // Whether the labels rank as their names imply is the question the record
  // asks of real data; here only the mechanics are checked.
  const input = cycles({ days: 6600 });
  const result = calculateBitcoinCycleRecord(input);
  assert.equal(result.status, 'calculated', result.reason);
  assert.ok(result.weeks > 600, `${result.weeks}`);
  const shares = Object.values(result.timeInPhase).reduce((total, value) => total + value, 0) + result.ambiguousShare;
  assert.ok(Math.abs(shares - 100) <= 3, `${shares}`);
  // A 90-day forward return for a labeled week is the close 90 days later over the close that week.
  const week = result.history.find((entry) => entry.phase);
  const index = input.prices.findIndex((point) => point.date === week.date);
  const horizon = result.record.horizons.find((entry) => entry.days === 90);
  const state = horizon.states.find((entry) => entry.key === week.phase);
  assert.ok(state.development.stats.n > 0);
  assert.ok(Number.isFinite(input.prices[index + 90].value / input.prices[index].value));
  // The read names the horizon it ranks and words the ordering by its sign.
  const read = result.record.horizons.find((entry) => entry.days === result.record.readHorizonDays);
  const ordering = read.heldOut.ordering ?? read.development.ordering;
  assert.match(result.read, new RegExp(`Over ${read.days} days`));
  if (ordering >= 0.6) assert.match(result.read, /ranked in the order their names imply/);
  else if (ordering <= -0.2) assert.match(result.read, /ranked against the order their names imply/);
  else assert.match(result.read, /ranked only loosely/);
});

test('every replayed week uses only data up to that week', () => {
  const input = cycles();
  const before = calculateBitcoinCycleRecord(input).history.slice(0, 150);
  // Rewrite everything after day 2,600; the first 150 replayed weeks end before it.
  const altered = { ...input, prices: input.prices.map((point, index) => (index > 2600 ? { ...point, value: point.value * 5 } : point)) };
  const after = calculateBitcoinCycleRecord(altered).history.slice(0, 150);
  assert.ok(before.at(-1).date < input.prices[2600].date);
  assert.deepEqual(after.map((entry) => entry.phase), before.map((entry) => entry.phase));
});

test('too short a history refuses with a reason', () => {
  const result = calculateBitcoinCycleRecord(cycles({ days: 1500 }));
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /Needs 200 weeks of daily closes plus a year to follow/);
});
