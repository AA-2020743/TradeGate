import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSeriesFreshness, isCryptoHistoryStale, isDailyCloseStale, isFredSeriesStale } from './freshness.js';

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

const at = (isoDate) => new Date(`${isoDate}T00:00:00.000Z`).getTime();
const daysAfter = (isoDate, days) => at(isoDate) + (days * 86_400_000);

test('a series between prints is current, not merely not-yet-stale', () => {
  // WALCL prints weekly; four days on is normal.
  const result = describeSeriesFreshness('WALCL', '2026-08-17', daysAfter('2026-08-17', 4));
  assert.equal(result.state, 'current');
  assert.equal(result.ageDays, 4);
  assert.equal(result.expectedWithinDays, 9);
  assert.match(result.read, /within this series' normal 9-day publication gap/);
});

test('a weekly series past its gap is overdue while still inside tolerance', () => {
  const result = describeSeriesFreshness('WALCL', '2026-08-05', daysAfter('2026-08-05', 12));
  assert.equal(result.state, 'overdue');
  assert.equal(result.ageDays, 12);
  assert.match(result.read, /the next print is late/);
  assert.match(result.read, /remains in the models/);
});

test('the same age reads differently for a monthly series', () => {
  // 45 days is overdue for nothing weekly, but normal for M2.
  const monthly = describeSeriesFreshness('M2SL', '2026-07-01', daysAfter('2026-07-01', 38));
  assert.equal(monthly.state, 'current');
  const weekly = describeSeriesFreshness('NFCI', '2026-07-01', daysAfter('2026-07-01', 38));
  assert.equal(weekly.state, 'stale');
});

test('past the tolerance a series is stale and says it left the models', () => {
  const result = describeSeriesFreshness('VIXCLS', '2026-08-01', daysAfter('2026-08-01', 7));
  assert.equal(result.state, 'stale');
  assert.match(result.read, /excluded from the models/);
});

test('the stale boundary agrees with the existing staleness check', () => {
  for (const id of ['WALCL', 'VIXCLS', 'M2SL', 'NFCI', 'DTWEXBGS']) {
    const { maxAgeDays } = describeSeriesFreshness(id, '2026-01-01', at('2026-01-01'));
    const justInside = daysAfter('2026-06-01', maxAgeDays - 1);
    const atLimit = daysAfter('2026-06-01', maxAgeDays);
    assert.equal(describeSeriesFreshness(id, '2026-06-01', justInside).state !== 'stale', true, `${id} just inside`);
    assert.equal(describeSeriesFreshness(id, '2026-06-01', atLimit).state, 'stale', `${id} at limit`);
  }
});

test('an unknown series falls back to a tolerance and a derived gap', () => {
  const result = describeSeriesFreshness('MADEUPSERIES', '2026-08-14', daysAfter('2026-08-14', 5));
  assert.equal(result.maxAgeDays, 14);
  assert.equal(result.expectedWithinDays, 7);
  assert.equal(result.state, 'current');
});

test('a missing or unreadable date is stale and says which', () => {
  assert.equal(describeSeriesFreshness('WALCL', null).state, 'stale');
  assert.match(describeSeriesFreshness('WALCL', null).read, /No observation date/);
  assert.match(describeSeriesFreshness('WALCL', 'not-a-date').read, /could not be read/);
  assert.equal(describeSeriesFreshness('WALCL', 'not-a-date').ageDays, null);
});

test('a future-dated observation is reported as zero days rather than negative', () => {
  const result = describeSeriesFreshness('WALCL', '2026-08-20', daysAfter('2026-08-20', -3));
  assert.equal(result.ageDays, 0);
  assert.equal(result.state, 'current');
});
