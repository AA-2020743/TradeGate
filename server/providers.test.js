import test from 'node:test';
import assert from 'node:assert/strict';
import { alignedRatioSeries, calculateTwelveCreditSlot, mergeFredSeries, mergeMarketSnapshot, parseRssItems, percentileOf, smaOf } from './providers.js';

test('simple moving average requires the full window', () => {
  assert.equal(smaOf([1, 2, 3], 3), 2);
  assert.equal(smaOf([1, 2], 3), null);
  assert.equal(smaOf([], 1), null);
});

test('percentile ranks a value within its history', () => {
  assert.equal(percentileOf([1, 2, 3, 4], 3), 75);
  assert.equal(percentileOf([], 3), null);
  assert.equal(percentileOf([1, 2], Number.NaN), null);
});

test('ratio series aligns unequal-length histories from the tail', () => {
  const left = [10, 20, 30, 40];
  const right = [2, 2];
  assert.deepEqual(alignedRatioSeries(left, right), [15, 20]);
});

test('RSS parser extracts titles, links, and timestamps', () => {
  const xml = '<rss><channel><item><title><![CDATA[Fed releases statement]]></title><link>https://federalreserve.gov/a</link><pubDate>Thu, 20 Aug 2026 18:00:00 GMT</pubDate></item><item><title>Plain title</title><link>https://example.com/b</link></item></channel></rss>';
  const items = parseRssItems(xml, 'Federal Reserve');
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Fed releases statement');
  assert.equal(items[0].source, 'Federal Reserve');
  assert.equal(items[0].publishedAt, '2026-08-20T18:00:00.000Z');
  assert.equal(items[1].publishedAt, null);
});

test('Twelve Data credit scheduling allows a bounded burst', () => {
  const reservations = [
    { at: 1_000, credits: 6 },
    { at: 1_000, credits: 1 },
  ];
  assert.equal(calculateTwelveCreditSlot(reservations, 1_000, 1, 8), 1_000);
});

test('Twelve Data credit scheduling waits for the rolling minute to clear', () => {
  const reservations = [
    { at: 1_000, credits: 6 },
    { at: 1_000, credits: 1 },
    { at: 1_000, credits: 1 },
  ];
  assert.equal(calculateTwelveCreditSlot(reservations, 1_000, 1, 8), 61_000);
});

test('partial market refresh retains only failed-provider cached assets', () => {
  const previous = {
    assets: [
      { key: 'BTC', symbol: 'BTC', source: 'CoinGecko', price: 100, asOf: '2026-08-21T10:00:00.000Z' },
      { key: 'SPY', symbol: 'SPY', source: 'Twelve Data', price: 500, asOf: '2026-08-21T10:00:00.000Z' },
    ],
  };
  const next = {
    assets: [{ key: 'BTC', symbol: 'BTC', source: 'CoinGecko', price: 101, asOf: '2026-08-21T10:05:00.000Z' }],
    errors: [{ provider: 'Twelve Data', message: 'Unavailable' }],
  };
  const merged = mergeMarketSnapshot(previous, next);
  assert.equal(merged.assets.find((asset) => asset.key === 'BTC').price, 101);
  assert.equal(merged.assets.find((asset) => asset.key === 'SPY').price, 500);
  assert.equal(merged.assets.find((asset) => asset.key === 'SPY').stale, true);
  assert.equal(merged.assets.find((asset) => asset.key === 'SPY').cached, true);
});

test('stale successful quote does not replace a fresher cached quote', () => {
  const previous = {
    assets: [{ key: 'SPY', symbol: 'SPY', source: 'Twelve Data', price: 500, asOf: '2026-08-20T00:00:00.000Z' }],
  };
  const next = {
    assets: [{ key: 'SPY', symbol: 'SPY', source: 'Twelve Data', price: 450, asOf: '2026-08-01T00:00:00.000Z', stale: true }],
    errors: [{ provider: 'Twelve Data', symbol: 'SPY', message: 'Quote timestamp is stale' }],
  };
  const merged = mergeMarketSnapshot(previous, next);
  assert.equal(merged.assets.length, 1);
  assert.equal(merged.assets[0].price, 500);
  assert.equal(merged.assets[0].cached, true);
});

test('stale live FRED response does not replace a fresh stored series', () => {
  const stored = { id: 'VIXCLS', key: 'vix', date: '2026-08-20', value: 15, stored: true, stale: false };
  const live = { id: 'VIXCLS', key: 'vix', date: '2026-08-01', value: 30, stored: false, stale: true };
  assert.equal(mergeFredSeries([live], [stored])[0], stored);
});
