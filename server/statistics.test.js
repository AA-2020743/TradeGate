import test from 'node:test';
import assert from 'node:assert/strict';
import { mean, median, medianSpacingDays, ordinal, percentileRank, standardDeviation } from './statistics.js';

test('a percentile refuses a distribution with no spread to rank against', () => {
  // A yield spread pinned at one level for two years, differing only by the
  // float dust of the subtraction that produced it. Ranking against that is
  // ranking noise, and it published a confident "72nd percentile".
  const flat = Array.from({ length: 600 }, (_, index) => -0.5 + ((index % 7) * 1e-13));
  assert.equal(percentileRank(flat, flat.at(-1)), null);

  // Scale-relative, so it behaves the same for basis points and for trillions.
  const huge = Array.from({ length: 600 }, (_, index) => 6.1e12 + ((index % 7) * 1e-3));
  assert.equal(percentileRank(huge, huge.at(-1)), null);
});

test('a percentile still ranks a distribution that genuinely moves', () => {
  const values = Array.from({ length: 600 }, (_, index) => Math.sin(index / 40) * 0.8);
  const rank = percentileRank(values, values.at(-1));
  assert.ok(Number.isFinite(rank) && rank >= 0 && rank <= 100);
  assert.equal(percentileRank(values, Math.min(...values) - 1), 0);
  assert.equal(percentileRank(values, Math.max(...values) + 1), 100);
});

test('a percentile ignores non-finite entries rather than counting them in the denominator', () => {
  const values = [1, 2, 3, 4, Number.NaN, undefined, null, 5];
  // Four of the five finite entries are at or below 4.
  assert.equal(percentileRank(values, 4), 80);
  assert.equal(percentileRank(values, Number.NaN), null);
  assert.equal(percentileRank([], 1), null);
});

test('a percentile can report unrounded when a caller needs the resolution', () => {
  const values = [1, 2, 3];
  assert.equal(percentileRank(values, 1), 33);
  assert.equal(percentileRank(values, 1, { round: false }).toFixed(4), (100 / 3).toFixed(4));
});

test('the shared arithmetic helpers agree with their definitions', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(mean([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  // Sample standard deviation, so n-1 in the denominator.
  assert.equal(standardDeviation([2, 4]).toFixed(6), Math.sqrt(2).toFixed(6));
  assert.equal(standardDeviation([5]), null);
});

test('median spacing reports a series own resolution', () => {
  const weekly = Array.from({ length: 20 }, (_, index) => ({ date: new Date(Date.UTC(2024, 0, 3) + (index * 7 * 86_400_000)).toISOString().slice(0, 10) }));
  assert.equal(medianSpacingDays(weekly), 7);
  assert.equal(medianSpacingDays(weekly.slice(0, 2)), null);
});

test('an ordinal refuses a value it cannot number, and respects sign', () => {
  // A refused percentile is now a legitimate null, and the equity copy of this
  // helper rendered that as "nullth" inside a breadth narrative.
  assert.equal(ordinal(null), '—');
  assert.equal(ordinal(undefined), '—');
  assert.equal(ordinal(Number.NaN), '—');
  assert.equal(ordinal(-3), '-3rd');
  assert.equal(ordinal(43), '43rd');
  assert.equal(ordinal(22), '22nd');
  assert.equal(ordinal(11), '11th');
  assert.equal(ordinal(1), '1st');
});
