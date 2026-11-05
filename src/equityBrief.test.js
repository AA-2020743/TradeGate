import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEquityBrief } from './equityBrief.js';

const technical = (regime, overrides = {}) => ({
  score: regime === 'Constructive' ? 72 : regime === 'Guarded' ? 25 : 50,
  regime,
  latest: 110,
  indicators: { sma20: 105, sma50: 100, sma200: 90, momentum20d: 2.4, rsi14: 58, pctFrom52wHigh: -1.2, ...overrides },
});
const sector = (rank, name, symbol) => ({ rank, name, symbol, quadrant: rank <= 3 ? 'Leading' : 'Lagging' });

const healthy = {
  indexName: 'the S&P 500',
  technical: technical('Constructive'),
  drawdown: { status: 'calculated', drawdownPercent: -1.2, inDrawdown: true, peakDate: '2026-10-28' },
  volatility: { status: 'calculated', slope: 'upward', terms: [{ window: 20, annualizedPercent: 11.2, percentile: 30 }, { window: 120, annualizedPercent: 14.1, percentile: 40 }] },
  vixTerm: { status: 'calculated', vixVix3m: 0.86, state: 'Contango — calm regime' },
  valuation: { status: 'calculated', cape: 37.1, capePercentile: 97, medianCape: 16, earningsYield: 2.7, historyFrom: '1881-01' },
  breadth: { status: 'calculated', pctAbove200: 64 },
  equalWeight: { status: 'calculated', slope50: 1.8 },
  rotation: { sectors: [sector(1, 'Technology', 'XLK'), sector(2, 'Industrials', 'XLI'), sector(3, 'Financials', 'XLF'), sector(4, 'Utilities', 'XLU')] },
  revisions: { status: 'calculated', diffusion: 63, covered: 48 },
  fearGreed: { score: 71, rating: 'greed', percentile1y: 82 },
};

test('each question gets one word and one sentence, from the panels already on the page', () => {
  const brief = buildEquityBrief(healthy);
  const byKey = Object.fromEntries(brief.cards.map((card) => [card.key, card]));
  assert.deepEqual(brief.cards.map((card) => [card.key, card.answer]), [
    ['trend', 'Up'], ['risk', 'Calm'], ['valuation', 'Expensive'], ['breadth', 'Broad'], ['leadership', 'Cyclical'], ['earnings', 'Rising'], ['sentiment', 'Greed'],
  ]);
  assert.equal(byKey.risk.sentence, 'The S&P 500 is 1.2% below its 2026-10-28 peak, its 20-day volatility of 11.2% is higher than 30% of its own readings over the last three years and near-dated options cost less than three-month ones, the usual calm shape.');
  assert.match(byKey.trend.sentence, /^The S&P 500 trades above all three of its moving averages/);
  assert.equal(byKey.valuation.sentence, 'Its cyclically adjusted P/E of 37.1 is higher than 97% of months since 1881 (median 16), an earnings yield of 2.7%. Valuation has said little about the next year or two; it is a guide to returns over the coming decade.');
  assert.equal(byKey.breadth.sentence, '64% of S&P 500 stocks trade above their 200-day average and the average stock has beaten the index by 1.8% over 50 days, so gains are spreading.');
  assert.match(byKey.leadership.sentence, /^Technology, Industrials and Financials have been strongest/);
  // Sentiment is described, never scored as good or bad.
  assert.equal(byKey.sentiment.tone, 'neutral');
  assert.match(byKey.sentiment.sentence, /has not tested whether that works/);
  assert.equal(brief.summary, 'The S&P 500: trend up, risk calm, valuation expensive, breadth broad.');
  for (const card of brief.cards) assert.ok(card.anchor, `${card.key} links to its panel`);
  // A scale marker where the answer is a position between two ends; none for
  // the sector mix, which is not one number.
  assert.deepEqual(byKey.valuation.scale, { value: 97, left: 'Cheap', right: 'Expensive', polarity: 'pos-left', label: '97th percentile' });
  assert.equal(byKey.sentiment.scale.polarity, 'none');
  assert.equal(byKey.risk.scale.label, 'Volatility 30th pct.');
  assert.equal(byKey.leadership.scale, undefined);
});

test('stress, a narrow rally and defensive leadership read as such', () => {
  const brief = buildEquityBrief({
    ...healthy,
    drawdown: { status: 'calculated', drawdownPercent: -12.4, inDrawdown: true, peakDate: '2026-07-01' },
    vixTerm: { status: 'calculated', vixVix3m: 1.08, state: 'Backwardation — stress pricing' },
    breadth: { status: 'calculated', pctAbove200: 51 },
    equalWeight: { status: 'calculated', slope50: -3.2 },
    rotation: { sectors: [sector(1, 'Utilities', 'XLU'), sector(2, 'Consumer Staples', 'XLP'), sector(3, 'Technology', 'XLK'), sector(4, 'Energy', 'XLE')] },
  });
  const byKey = Object.fromEntries(brief.cards.map((card) => [card.key, card]));
  assert.equal(byKey.risk.answer, 'Stressed');
  assert.match(byKey.risk.sentence, /12\.4% below its 2026-07-01 peak.*how stress is priced\.$/);
  assert.equal(byKey.breadth.answer, 'Narrow');
  assert.match(byKey.breadth.sentence, /trailed the index by 3\.2% over 50 days, so gains are concentrated in the largest names\.$/);
  assert.equal(byKey.leadership.answer, 'Defensive');
});

test('a card whose inputs did not publish is left out, not shown blank', () => {
  const brief = buildEquityBrief({ indexName: 'the Nikkei 225', technical: technical('Neutral'), valuation: { status: 'unavailable', reason: 'no data' } });
  assert.deepEqual(brief.cards.map((card) => card.key), ['trend']);
  assert.equal(brief.cards[0].answer, 'Sideways');
  // One reading is not a summary.
  assert.equal(brief.summary, null);
  assert.deepEqual(buildEquityBrief().cards, []);
});
