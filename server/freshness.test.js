import test from 'node:test';
import assert from 'node:assert/strict';
import { abandonedAfterDays, cryptoHistoryGranularity, describeSeriesFreshness, isCryptoHistoryStale, isDailyCloseStale, isFredSeriesAbandoned, isFredSeriesStale, maxObservationAgeDays, normalPublicationGapDays } from './freshness.js';

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

test('a stale series says its value is dated, not that it was deleted', () => {
  // Stale used to mean removed, which turned one late monthly print into a
  // total macro outage. It now means the latest value is no longer current
  // while the history behind it still feeds the models that measure change.
  const result = describeSeriesFreshness('VIXCLS', '2026-08-01', daysAfter('2026-08-01', 12));
  assert.equal(result.state, 'stale');
  assert.match(result.read, /no longer treated as current/);
  assert.match(result.read, /history still feeds/);
  assert.doesNotMatch(result.read, /excluded from the models/);
});

test('a series far enough past its tolerance is abandoned and does leave the models', () => {
  const result = describeSeriesFreshness('VIXCLS', '2026-01-01', daysAfter('2026-01-01', 120));
  assert.equal(result.state, 'abandoned');
  assert.match(result.read, /excluded from the models/);
  assert.equal(isFredSeriesAbandoned('VIXCLS', '2026-01-01', daysAfter('2026-01-01', 120)), true);
});

test('the described state and the staleness check never disagree about a series', () => {
  // Two functions answering "is this stale?" with different rounding is how a
  // panel ends up saying a series is fine while the loader has already dropped
  // it. They are checked against each other across the whole boundary rather
  // than at one hand-chosen day.
  for (const id of ['WALCL', 'VIXCLS', 'M2SL', 'NFCI', 'DTWEXBGS', 'JPNASSETS']) {
    const limit = maxObservationAgeDays(id);
    for (const offset of [-2, -1, 0, 1, 2]) {
      const now = daysAfter('2026-06-01', limit + offset);
      const described = describeSeriesFreshness(id, '2026-06-01', now);
      const stale = isFredSeriesStale(id, '2026-06-01', now);
      assert.equal(['stale', 'abandoned'].includes(described.state), stale, `${id} at ${limit + offset} days`);
    }
  }
});

test('an unknown series falls back to the business-daily release shape', () => {
  const result = describeSeriesFreshness('MADEUPSERIES', '2026-08-14', daysAfter('2026-08-14', 4));
  assert.equal(result.expectedWithinDays, 5);
  assert.equal(result.maxAgeDays, 9);
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

test('no FRED tolerance sits inside the series own release cycle', () => {
  // This invariant existed before and passed while six series were misconfigured,
  // because it compared a hand-picked tolerance against a hand-picked "expected
  // gap" - two numbers from the same guess. Both are now derived from the
  // release calendar (cadence, publication lag, and whether the observation is
  // dated at the start or the end of the period it covers), so the check has
  // something real to test against.
  const ids = ['WALCL', 'WTREGEN', 'RRPONTSYD', 'M2SL', 'DGS2', 'DFII10', 'NFCI', 'BAMLH0A0HYM2',
    'VIXCLS', 'ECBASSETSW', 'JPNASSETS', 'DEXUSEU', 'DEXJPUS', 'DEXCHUS', 'DTWEXBGS', 'DGS10',
    'DGS3MO', 'T5YIFR', 'T5YIE', 'T10YIE', 'CPIAUCSL', 'THREEFYTP10', 'SOFR', 'IORB', 'PAYEMS',
    'ICSA', 'INDPRO', 'RSAFS', 'IRLTLT01DEM156N'];
  const tooTight = [];
  for (const id of ids) {
    const gap = normalPublicationGapDays(id);
    const tolerance = maxObservationAgeDays(id);
    if (tolerance < gap + 3) tooTight.push(`${id}: tolerance ${tolerance} against a normal gap of ${gap}`);
  }
  assert.deepEqual(tooTight, []);
});

test('a monthly series dated at the start of its month is not stale the week before its release', () => {
  // The BoJ's total assets are monthly, dated at month start, and published
  // about five days after the month closes. On 2 September the newest print is
  // 1 July - 63 days old and entirely on schedule. The old 60-day tolerance
  // called that stale, dropped the series, and took the global liquidity pool,
  // the macro regime read and every verdict downstream of them with it, because
  // the BoJ leg is mandatory in the pool.
  const septemberSecond = Date.parse('2026-09-02T12:00:00.000Z');
  assert.equal(isFredSeriesStale('JPNASSETS', '2026-07-01', septemberSecond), false);
  assert.equal(describeSeriesFreshness('JPNASSETS', '2026-07-01', septemberSecond).state, 'current');

  // Two months with no print is a real outage and must still be caught.
  assert.equal(isFredSeriesStale('JPNASSETS', '2026-04-01', septemberSecond), true);

  // The same trap applies to every monthly series dated this way.
  for (const id of ['CPIAUCSL', 'PAYEMS', 'INDPRO', 'RSAFS', 'M2SL']) {
    assert.ok(normalPublicationGapDays(id) > 60, `${id} is dated at month start and cannot have a sane gap under 60 days`);
    assert.equal(isFredSeriesStale(id, '2026-07-01', septemberSecond), false, `${id} one release cycle behind`);
  }
});

test('abandoned sits far enough past stale to be a different claim', () => {
  for (const id of ['VIXCLS', 'WALCL', 'JPNASSETS', 'M2SL']) {
    assert.ok(abandonedAfterDays(id) >= maxObservationAgeDays(id) * 2, `${id} abandons too close to stale`);
  }
});
