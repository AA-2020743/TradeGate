import test from 'node:test';
import assert from 'node:assert/strict';
import { isCryptoHistoryStale, isDailyCloseStale, isFredSeriesStale } from './freshness.js';

const now = new Date('2026-08-21T12:00:00.000Z').getTime();

test('stored FRED freshness respects each series release cadence', () => {
  assert.equal(isFredSeriesStale('WALCL', '2026-08-11', now), false);
  assert.equal(isFredSeriesStale('VIXCLS', '2026-08-11', now), true);
  assert.equal(isFredSeriesStale('M2SL', '2026-06-01', now), false);
  assert.equal(isFredSeriesStale('M2SL', '2026-04-01', now), true);
});

test('stored FRED series without a valid date are stale', () => {
  assert.equal(isFredSeriesStale('WALCL', null, now), true);
  assert.equal(isFredSeriesStale('WALCL', 'not-a-date', now), true);
});

test('daily closes remain usable through a long weekend', () => {
  const tuesdayMorning = new Date('2026-09-08T12:00:00.000Z').getTime();
  assert.equal(isDailyCloseStale('2026-09-04T00:00:00.000Z', tuesdayMorning), false);
  assert.equal(isDailyCloseStale('2026-09-02T00:00:00.000Z', tuesdayMorning), true);
});

test('always-open crypto history uses a one-day freshness limit', () => {
  assert.equal(isCryptoHistoryStale('2026-08-21T00:00:00.000Z', now), false);
  assert.equal(isCryptoHistoryStale('2026-08-20T00:00:00.000Z', now), true);
});
