import test from 'node:test';
import assert from 'node:assert/strict';
import { crossCheckSeries, dataQualityFor, gateOnDataQuality, summarizeCrossChecks } from './priceCrossCheck.js';
import { primaryProvider } from './providers.js';

const DAY = 86_400_000;
const START = Date.UTC(2026, 3, 1);
const date = (index) => new Date(START + (index * DAY)).toISOString().slice(0, 10);
let seed = 5;
const noise = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed / 2147483648) - 0.5; };
const base = Array.from({ length: 120 }, (_, index) => 100 * Math.exp(index * 0.001) * (1 + (0.02 * noise())));
const points = (values, shift = 0) => values.map((value, index) => ({ date: date(index + shift), value }));
const check = (primary, shadow, extra = {}) => crossCheckSeries({ symbol: 'X', name: 'Test', primary, shadow, primarySource: 'Twelve Data', shadowSource: 'Yahoo', ...extra });

test('two sources that agree to the cent pass', () => {
  const result = check(points(base), points(base.map((value) => value * (1 + 0.0001))));
  assert.equal(result.status, 'pass');
  assert.equal(result.overlap, 60);
  assert.ok(result.medianReturnDifferencePoints < 0.01);
});

test('a missed split is caught even though every other day agrees', () => {
  // The shadow applied a 2:1 split 30 days ago; the primary did not. The level
  // gap is obvious, and the single-day return difference is ~50 points.
  const split = base.map((value, index) => (index >= 90 ? value / 2 : value));
  const result = check(points(base), points(split));
  assert.equal(result.status, 'review');
  assert.ok(result.maxReturnDifferencePoints > 40);
  assert.equal(result.worstDate, date(90));
  assert.ok(result.breaches.some((breach) => /latest closes differ/.test(breach)));
});

test('a single wrong close weeks ago is caught by returns even when today agrees', () => {
  const wrong = base.map((value, index) => (index === 80 ? value * 1.06 : value));
  const result = check(points(base), points(wrong));
  assert.equal(result.latestDifferencePercent, 0);
  assert.equal(result.status, 'review');
  assert.match(result.breaches.join(' '), /returns differ by .* points on/);
});

test('a source compared with itself is not called a pass', () => {
  const result = crossCheckSeries({ symbol: 'X', primary: points(base), shadow: points(base), primarySource: 'Yahoo', shadowSource: 'Yahoo' });
  assert.equal(result.status, 'not-independent');
  assert.match(result.reason, /prove nothing/);
});

test('a one-day stamp convention is aligned, not flagged, when allowed', () => {
  // The shadow stamps each close one day later than the primary.
  const shifted = points(base, 1);
  const strict = check(points(base), shifted);
  assert.equal(strict.status, 'review', 'same-date pairing misreads the convention as error');
  const aligned = check(points(base), shifted, { allowOffset: true });
  assert.equal(aligned.status, 'pass');
  assert.equal(aligned.offsetDays, 1);
  assert.match(aligned.alignment, /different days/);
});

test('too little overlap refuses rather than comparing a handful of days', () => {
  const result = check(points(base.slice(0, 10)), points(base.slice(0, 10)));
  assert.equal(result.status, 'unavailable');
});

test('the summary names who disagrees and never counts a self-comparison as agreement', () => {
  const pass = check(points(base), points(base));
  const review = check(points(base), points(base.map((value, index) => (index === 80 ? value * 1.06 : value))));
  const self = crossCheckSeries({ symbol: 'Y', primary: points(base), shadow: points(base), primarySource: 'Yahoo', shadowSource: 'Yahoo' });
  const summary = summarizeCrossChecks([{ ...pass, symbol: 'A' }, { ...review, symbol: 'B' }, self]);
  assert.deepEqual(summary.passed, ['A']);
  assert.deepEqual(summary.review, ['B']);
  assert.deepEqual(summary.notIndependent, ['Y']);
  assert.match(summary.read, /^B disagrees/);
  const onlySelf = summarizeCrossChecks([self]);
  assert.equal(onlySelf.status, 'provisional');
  assert.match(onlySelf.read, /No symbol could be compared/);
});

test('history labels resolve to the provider that actually produced them', () => {
  assert.equal(primaryProvider('Yahoo Finance'), 'Yahoo');
  assert.equal(primaryProvider('Twelve Data'), 'Twelve Data');
  assert.equal(primaryProvider('CoinGecko'), 'CoinGecko');
  assert.equal(primaryProvider('PostgreSQL (stored provider history)', 'Twelve Data'), 'Twelve Data (stored)');
  // Ingestion falls back to Yahoo when Twelve Data fails, so stored history
  // can be Yahoo's; an unknown writer is not assumed to be anyone.
  assert.equal(primaryProvider('PostgreSQL (stored provider history)', 'Yahoo Finance'), 'Yahoo (stored)');
  assert.equal(primaryProvider('PostgreSQL (stored provider history)', null), null);
});

test('stored Yahoo history is not independent of live Yahoo', () => {
  const result = crossCheckSeries({ symbol: 'SPY', primary: points(base), shadow: points(base), primarySource: 'Yahoo (stored)', shadowSource: 'Yahoo' });
  assert.equal(result.status, 'not-independent');
});

test('a series under review makes its model provisional and says why; its numbers stay', () => {
  const quality = dataQualityFor({ status: 'review', primarySource: 'Twelve Data', shadowSource: 'Yahoo', breaches: ['latest closes differ by 2.1%'] });
  assert.equal(quality.status, 'review');
  assert.match(quality.read, /Twelve Data and Yahoo disagree on this series: latest closes differ by 2\.1%/);
  const gated = gateOnDataQuality({ status: 'calculated', score: 71 }, quality);
  assert.equal(gated.status, 'provisional');
  assert.equal(gated.score, 71, 'the reading is kept, not withheld');
  assert.equal(gated.provisionalReason, quality.read);
  // An already-unavailable model is not promoted to provisional.
  assert.equal(gateOnDataQuality({ status: 'unavailable' }, quality).status, 'unavailable');
});

test('only an independent pass verifies; anything that could not compare is unverified, not passed', () => {
  assert.equal(dataQualityFor({ status: 'pass', shadowSource: 'Yahoo', overlap: 60 }).status, 'verified');
  assert.equal(gateOnDataQuality({ status: 'calculated' }, dataQualityFor({ status: 'pass', shadowSource: 'Yahoo', overlap: 60 })).status, 'calculated');
  for (const check of [{ status: 'not-independent', reason: 'same provider' }, { status: 'unavailable', reason: 'no overlap' }, null]) {
    const quality = dataQualityFor(check);
    assert.equal(quality.status, 'unverified');
    const gated = gateOnDataQuality({ status: 'calculated' }, quality);
    assert.equal(gated.status, 'calculated', 'an unchecked series is published as it would have been');
    assert.equal(gated.dataQuality.status, 'unverified');
  }
});
