import test from 'node:test';
import assert from 'node:assert/strict';
import { describeTechnical } from './technicalSummary.js';

const model = (overrides = {}) => ({
  version: 'technical-v1',
  score: 72,
  regime: 'Constructive',
  latest: 110,
  ...overrides,
  indicators: { sma20: 105, sma50: 100, sma200: 90, momentum20d: 4.12, rsi14: 61.3, pctFrom52wHigh: -3.24, ...overrides.indicators },
});

test('an uptrend is described by what carries it, not by its score', () => {
  const summary = describeTechnical(model(), 'SPY');
  assert.equal(summary.headline, 'The trend is up');
  assert.equal(summary.tone, 'positive');
  assert.equal(summary.sentence, 'SPY trades above all three of its moving averages, is up 4.1% over the past month and sits 3.2% below its 52-week high.');
  assert.doesNotMatch(summary.sentence, /score|observations/);
});

test('a mixed or falling picture says so, and an overstretched move is flagged', () => {
  const mixed = describeTechnical(model({ score: 48, regime: 'Neutral', latest: 98, indicators: { momentum20d: -1.04, pctFrom52wHigh: -0.2 } }), 'GLD');
  assert.equal(mixed.headline, 'No clear trend');
  assert.equal(mixed.sentence, 'GLD trades above one of its three moving averages, is down 1.0% over the past month and sits at or near its 52-week high.');

  const falling = describeTechnical(model({ score: 20, regime: 'Guarded', latest: 80, indicators: { momentum20d: -12.6, rsi14: 24.4, pctFrom52wHigh: -31 } }), 'BTC');
  assert.equal(falling.headline, 'The trend is down');
  assert.equal(falling.tone, 'negative');
  assert.match(falling.sentence, /^BTC trades below all three of its moving averages, is down 12\.6% over the past month and sits 31\.0% below its 52-week high\. /);
  assert.match(falling.sentence, /RSI of 24 is below the 30 usually read as oversold\.$/);
});

test('a short history is described with the averages it actually has', () => {
  const short = describeTechnical(model({ indicators: { sma50: null, sma200: null, pctFrom52wHigh: null } }), 'ETH');
  assert.match(short.sentence, /^ETH trades above its only moving average and is up 4\.1% over the past month\.$/);
  const bare = describeTechnical({ score: 50, regime: 'Neutral', indicators: {} }, 'XYZ');
  assert.equal(bare.sentence, "Too little of XYZ's history was available to describe the trend.");
  assert.equal(describeTechnical(null, 'SPY'), null);
});
