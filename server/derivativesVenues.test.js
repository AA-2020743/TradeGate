import test from 'node:test';
import assert from 'node:assert/strict';
import { combineFundingVenues, okxPositioningRows } from './derivativesVenues.js';

test('one venue answering is enough, and the read names who did not', () => {
  const funding = combineFundingVenues({ venues: { binance: new Error('Upstream request failed with 451'), bybit: new Error('Upstream request failed with 403'), okx: 0.0001 } });
  assert.equal(funding.venues, 1);
  assert.equal(funding.okxRate, 0.0001);
  assert.equal(funding.binanceRate, null);
  assert.equal(funding.annualizedPercent, 10.95);
  assert.deepEqual(funding.failedVenues.map((entry) => entry.venue), ['binance', 'bybit']);
  assert.match(funding.failedVenues[0].reason, /451/);
  assert.equal(funding.dispersionAnnualizedPercent, null, 'one venue has no spread');
});

test('no venue answering fails with every reason, not the first', () => {
  assert.throws(() => combineFundingVenues({ venues: { binance: new Error('451'), bybit: new Error('403'), okx: new Error('timeout') } }), /binance \(451\); bybit \(403\); okx \(timeout\)/);
});

test('the cross-venue spread is published and the history venue is named', () => {
  const rates = Array.from({ length: 300 }, (_, index) => 0.00005 + (index * 0.0000002));
  const funding = combineFundingVenues({ venues: { binance: 0.0001, bybit: 0.00012, okx: 0.00008 }, history: { venue: 'OKX', rates } });
  assert.equal(funding.venues, 3);
  assert.equal(funding.dispersionAnnualizedPercent, Math.round(0.00004 * 3 * 365 * 10000) / 100);
  assert.equal(funding.historyVenue, 'OKX');
  assert.ok(Number.isFinite(funding.percentile));
  assert.equal(funding.windowDays, 100);
});

test('OKX dollar open interest becomes coin terms using the same day’s close, and unmatched days drop', () => {
  const day = (index) => String(Date.UTC(2026, 8, 1 + index));
  const rows = okxPositioningRows({
    openInterest: [[day(2), '6000000000', '0'], [day(0), '4000000000', '0'], [day(1), '5000000000', '0'], [day(3), '7000000000', '0']],
    candles: [[day(0), '0', '0', '0', '80000'], [day(1), '0', '0', '0', '100000'], [day(2), '0', '0', '0', '100000']],
  });
  assert.equal(rows.length, 3, 'day 3 has no close');
  assert.deepEqual(rows.map((row) => row.date), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.equal(rows[0].openInterest, 50000);
  assert.equal(rows[0].openInterestValue / rows[0].openInterest, 80000, 'implied price is the close');
});
