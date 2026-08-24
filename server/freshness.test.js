import test from 'node:test';
import assert from 'node:assert/strict';
import { cryptoHistoryGranularity, describeSeriesFreshness, isCryptoHistoryStale, isDailyCloseStale, isFredSeriesStale } from './freshness.js';

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

test('crypto freshness follows the granularity the provider returned', () => {
  // CoinGecko picks granularity from the window asked for, so one fixed
  // tolerance cannot be right for all of them. The old flat 24-hour rule was
  // simultaneously too tight for daily data - which is up to 24 hours old the
  // moment it arrives, so the rule tripped near the end of every UTC day - and
  // too loose for five-minute data, where an eight-hour-old point passed.
  assert.equal(cryptoHistoryGranularity('1'), 'intraday');
  assert.equal(cryptoHistoryGranularity('30'), 'hourly');
  assert.equal(cryptoHistoryGranularity('365'), 'daily');
  assert.equal(cryptoHistoryGranularity('max'), 'daily');

  const evening = new Date('2026-08-24T23:30:00.000Z').getTime();
  // A daily point stamped at midnight today is 23.5 hours old by the evening,
  // and one stamped yesterday is 47.5 - neither is a fault on a daily series.
  assert.equal(isCryptoHistoryStale('2026-08-24T00:00:00.000Z', evening, 'daily'), false);
  assert.equal(isCryptoHistoryStale('2026-08-23T00:00:00.000Z', evening, 'daily'), false);
  // Three days without a daily point is a real outage.
  assert.equal(isCryptoHistoryStale('2026-08-21T00:00:00.000Z', evening, 'daily'), true);

  // Intraday is held to a much tighter rule than the old flat one allowed.
  assert.equal(isCryptoHistoryStale('2026-08-24T21:30:00.000Z', evening, 'intraday'), false);
  assert.equal(isCryptoHistoryStale('2026-08-24T15:30:00.000Z', evening, 'intraday'), true);
  assert.equal(isCryptoHistoryStale('2026-08-24T13:00:00.000Z', evening, 'hourly'), false);
  assert.equal(isCryptoHistoryStale('2026-08-23T20:00:00.000Z', evening, 'hourly'), true);

  assert.equal(isCryptoHistoryStale('not a date', evening, 'daily'), true);
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

test('the H.10 FX series survive their own weekly release cycle', () => {
  // These are daily-frequency but weekly-released: FRED publishes the prior
  // week's daily rates in one batch. The newest observation therefore ages
  // from 3 days just after a release to 10 the day before the next one.
  // A 10-day tolerance was the exact worst case of the normal cycle, so these
  // went stale every week and took the dollar leg out of the liquidity models
  // with them - reported live as four stale series on a Monday, with a Friday
  // observation ten days behind.
  const monday = Date.parse('2026-08-24T12:00:00.000Z');
  for (const id of ['DTWEXBGS', 'DEXUSEU', 'DEXJPUS', 'DEXCHUS']) {
    assert.equal(isFredSeriesStale(id, '2026-08-14', monday), false, `${id} at the top of its normal cycle`);
    assert.equal(describeSeriesFreshness(id, '2026-08-14', monday).state, 'current', `${id} is between prints, not late`);

    // A release delayed to Tuesday by a holiday is still not a fault.
    assert.equal(isFredSeriesStale(id, '2026-08-13', monday), false, `${id} after a holiday-delayed release`);

    // A genuine outage must still be caught.
    assert.equal(isFredSeriesStale(id, '2026-07-10', monday), true, `${id} six weeks behind is an outage`);
  }
});

test('every FRED tolerance leaves room above its own expected publication gap', () => {
  // The H.10 bug was a tolerance set to the exact top of the normal cycle, so
  // the series tripped it routinely. No series should be configured that way:
  // the hard tolerance has to sit meaningfully above the gap the series is
  // expected to keep, or "stale" means "between prints".
  const ids = ['WALCL', 'WTREGEN', 'RRPONTSYD', 'M2SL', 'DGS2', 'DFII10', 'NFCI', 'BAMLH0A0HYM2',
    'VIXCLS', 'ECBASSETSW', 'JPNASSETS', 'DEXUSEU', 'DEXJPUS', 'DEXCHUS', 'DTWEXBGS', 'DGS10',
    'DGS3MO', 'T5YIFR', 'T5YIE', 'T10YIE', 'CPIAUCSL', 'THREEFYTP10', 'SOFR', 'IORB', 'PAYEMS',
    'ICSA', 'INDPRO', 'RSAFS'];
  const now = Date.parse('2026-08-24T12:00:00.000Z');
  const tooTight = [];
  for (const id of ids) {
    const { expectedWithinDays, maxAgeDays } = describeSeriesFreshness(id, '2026-08-24', now);
    if (maxAgeDays < expectedWithinDays + 3) tooTight.push(`${id}: tolerance ${maxAgeDays} against an expected gap of ${expectedWithinDays}`);
  }
  assert.deepEqual(tooTight, []);
});
