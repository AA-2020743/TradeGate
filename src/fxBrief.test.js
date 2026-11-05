import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFxBrief } from './fxBrief.js';

const workspace = {
  usdBreadth: { total: 6, strong20d: 5, strong60d: 4, pct20d: 83 },
  pairs: [
    { key: 'eur', name: 'Euro', momentum20d: -1.2 },
    { key: 'jpy', name: 'Japanese Yen', momentum20d: 0.8 },
    { key: 'gbp', name: 'British Pound', momentum20d: -0.4 },
    { key: 'aud', name: 'Australian Dollar', momentum20d: -2.6 },
  ],
  riskRegime: 'Risk-off',
  rotationSignals: [{ signal: 'Yen safe haven vs S&P 500', status: 'Confirmed' }],
  usdCot: { percentile: 8 },
};
const rateDivergence = { status: 'calculated', averageSpreadPercent: 1.62, averageChangeBasisPoints: 14.2, state: 'US yield advantage widening', score: 71 };
const carry = { status: 'calculated', trade: { long: ['AUD', 'GBP'], short: ['JPY', 'CHF'], carry: 3.9 }, spreadHistory: { from: '1999-01', annualReturn: 2.1, annualVolatility: 8.7, worstMonths: [{ month: '2008-10', value: -11.4 }] } };

test('each currency question gets one word and one sentence from the page\'s own panels', () => {
  const brief = buildFxBrief({ workspace, rateDivergence, carry });
  const byKey = Object.fromEntries(brief.cards.map((card) => [card.key, card]));
  assert.deepEqual(brief.cards.map((card) => [card.key, card.answer]), [
    ['breadth', 'Rising broadly'], ['leaders', 'Yen'], ['rates', 'Widening'], ['carry', '3.9 pts a year'], ['risk', 'Risk-off'], ['positioning', 'Crowded short'],
  ]);
  assert.equal(byKey.breadth.sentence, 'Over the last 20 sessions the dollar has gained against 5 of 6 major currencies (4 of 6 over 60). A move this broad is about the dollar, not any one currency.');
  assert.equal(byKey.leaders.sentence, 'The Japanese yen has done best against the dollar over 20 sessions (+0.8%), the Australian dollar worst (-2.6%).');
  assert.match(byKey.rates.sentence, /^The US 10-year yields 1\.62 points more than its peers, up 14\.2bp in about three months\. A widening gap draws capital toward the dollar\.$/);
  assert.match(byKey.carry.sentence, /^Borrowing in JPY and CHF to hold AUD and GBP earns about 3\.9 points a year in interest, before currency moves\. Since 1999 the same rule has returned 2\.1% a year with 8\.7% volatility; its worst month lost 11\.4%\.$/);
  assert.match(byKey.risk.sentence, /confirms the risk-off read\.$/);
  assert.match(byKey.positioning.sentence, /shorter than in 92% of past weekly reports/);
  assert.equal(brief.summary, 'The dollar rising broadly, its yield advantage widening, currencies risk-off.');
  for (const card of brief.cards) assert.ok(card.anchor, `${card.key} links to its panel`);
});

test('a dollar-named currency is named in full, not as "Dollar"', () => {
  const pairs = [{ key: 'cad', name: 'Canadian Dollar', momentum20d: 1.4 }, { key: 'eur', name: 'Euro', momentum20d: 0.2 }, { key: 'chf', name: 'Swiss Franc', momentum20d: -0.9 }];
  const card = buildFxBrief({ workspace: { pairs } }).cards[0];
  assert.equal(card.answer, 'Canadian dollar');
  assert.equal(card.sentence, 'The Canadian dollar has done best against the dollar over 20 sessions (+1.4%), the Swiss franc worst (-0.9%).');
});

test('missing inputs leave their cards out', () => {
  const brief = buildFxBrief({ workspace: { riskRegime: 'Unavailable', pairs: [] }, rateDivergence: { status: 'unavailable' }, carry: { status: 'unavailable' } });
  assert.deepEqual(brief.cards, []);
  assert.equal(brief.summary, null);
  assert.deepEqual(buildFxBrief().cards, []);
});
