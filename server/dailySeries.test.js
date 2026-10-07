import test from 'node:test';
import assert from 'node:assert/strict';
import { onePointPerDay } from './dailySeries.js';
import { calculateConsensusHistory, storedOutputDate } from './macroConsensus.js';

test('a stray mid-day price is dropped and the 00:00 daily close kept, in time order', () => {
  // The stored bitcoin series as production held it: each day's 00:00
  // CoinGecko close, plus the live price each ingestion run appended.
  const points = [
    { timestamp: '2026-10-06T00:00:00.000Z', value: 62000 },
    { timestamp: '2026-10-06T21:13:00.000Z', value: 63650 },
    { timestamp: '2026-10-05T00:00:00.000Z', value: 61500 },
    { timestamp: '2026-10-07T00:00:00.000Z', value: 62400 },
    { timestamp: '2026-10-07T12:37:00.000Z', value: 64050 },
    { timestamp: 'not a date', value: 1 },
  ];
  assert.deepEqual(onePointPerDay(points).map((point) => point.value), [61500, 62000, 62400]);
  // A day with only one point keeps it, whatever its time.
  assert.deepEqual(onePointPerDay([{ timestamp: '2026-10-08T13:30:00.000Z', value: 5 }]).map((point) => point.value), [5]);
});

test('stored consensus readings without an asOf are dated by when they were calculated', () => {
  // Shaped exactly as getRecentModelOutputs returns rows: camelCase keys,
  // Date objects from pg, and no asOf on the consensus output itself.
  const rows = [0, 1, 2, 3, 3].map((daysAgo, index) => ({
    version: 'macro-consensus-v1',
    effectiveAt: null,
    calculatedAt: new Date(Date.UTC(2026, 9, 7 - daysAgo, 6 + index)),
    output: { status: 'calculated', averageScore: 50 + daysAgo, spread: 20 + daysAgo, state: 'Models broadly agree' },
  }));
  const history = calculateConsensusHistory(rows);
  assert.notEqual(history.status, 'unavailable', history.reason);
  assert.equal(storedOutputDate(rows[0]), '2026-10-07');
  assert.equal(storedOutputDate({ output: { asOf: '2026-09-30' }, calculatedAt: new Date() }), '2026-09-30', 'a model’s own date wins');
  assert.equal(storedOutputDate({ output: {}, effective_at: '2026-09-01' }), '2026-09-01', 'snake_case rows still read');
  // Two runs on the same day are one reading, not movement.
  const sameDay = calculateConsensusHistory(rows.slice(3));
  assert.match(sameDay.reason, /1 available/);
});
