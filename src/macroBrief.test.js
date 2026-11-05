import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMacroBrief } from './macroBrief.js';

const healthy = {
  liquidity: { status: 'calculated', score: 64, regime: 'Expansion', momentum: 'Accelerating' },
  globalLiquidity: { status: 'calculated', score: 52, regime: 'Neutral' },
  usdStrength: { status: 'calculated', score: 61, regime: 'Firm' },
  growthNowcast: { status: 'calculated', score: 57, state: 'Firm', legs: [{ score: 60 }, { score: 55 }, { score: null }] },
  inflation: { status: 'calculated', realized: { yearOverYearPercent: 3.1 }, anchor: { name: '10-year breakeven', percent: 2.3 } },
  yieldCurve: { status: 'calculated', state: 'Recently un-inverted', spreads: [{ key: 'tenTwo', spread: 0.42 }] },
  recession: {
    status: 'calculated', probability: 18.4, signalPercent: 30, history: [{ month: '1959-01' }],
    episodes: [{ outcome: 'followed' }, { outcome: 'followed' }, { outcome: 'not followed' }, { outcome: 'pending' }],
  },
};

test('each macro question gets one word, one sentence and the tab that backs it', () => {
  const brief = buildMacroBrief(healthy);
  const byKey = Object.fromEntries(brief.cards.map((card) => [card.key, card]));
  assert.deepEqual(brief.cards.map((card) => [card.key, card.answer]), [
    ['liquidity', 'Growing'], ['global', 'Flat'], ['dollar', 'Firm'], ['growth', 'Firm'], ['inflation', 'Above target'], ['curve', 'Recently un-inverted'], ['recession', 'Moderate'],
  ]);
  assert.match(byKey.liquidity.sentence, /growing over 13 weeks, and the pace is picking up\./);
  assert.equal(byKey.inflation.sentence, "Consumer prices are up 3.1% on a year ago, against the Fed's 2% target. Markets price 2.3% a year (10-year breakeven), so they expect it to ease.");
  assert.match(byKey.curve.sentence, /The 10-year sits 0\.42 points above the 2-year\.$/);
  // The recession card quotes the model's own record, not a general claim.
  assert.match(byKey.recession.sentence, /This one is a forecast\. Since 1959 it has risen above 30% 3 times with the outcome known, and a recession began within two years of 2\.$/);
  assert.match(byKey.growth.sentence, /across 2 of 3 measures/);
  // A firm dollar is not good or bad in itself.
  assert.equal(byKey.dollar.tone, 'neutral');
  assert.equal(byKey.dollar.scale.polarity, 'none');
  assert.deepEqual(byKey.recession.scale, { value: 18.4, min: 0, max: 60, left: 'Unlikely', right: 'Likely', polarity: 'pos-left', label: '18.4% in 12 months' });
  assert.equal(brief.summary, 'Liquidity growing, growth firm, inflation above target, recession risk moderate.');
  for (const card of brief.cards) assert.ok(card.tab, `${card.key} names its tab`);
});

test('a model that did not publish is left out, and one reading is not a summary', () => {
  const brief = buildMacroBrief({ liquidity: { status: 'unavailable', reason: 'FRED down' }, yieldCurve: { status: 'calculated', state: 'Inverted', spreads: [{ key: 'tenTwo', spread: -0.6 }] } });
  assert.deepEqual(brief.cards.map((card) => card.key), ['curve']);
  assert.equal(brief.cards[0].tone, 'negative');
  assert.match(brief.cards[0].sentence, /0\.6 points below the 2-year/);
  assert.equal(brief.summary, null);
  assert.deepEqual(buildMacroBrief().cards, []);
});
