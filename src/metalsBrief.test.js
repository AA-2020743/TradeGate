import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMetalsBrief } from './metalsBrief.js';

const inputs = {
  gold: { symbol: 'XAU', score: 74, sma50: 2410, sma200: 2250, momentum20d: 3.4, rsi14: 72 },
  accumulation: { schedules: [{ key: 'spx', status: 'calculated', risk: 40, tier: { label: 'Discounted' } }, { key: 'gold', status: 'calculated', risk: 86, tier: { label: 'Stretched' } }] },
  realYield: { status: 'calculated', gapPercent: 22.4, state: 'Outside the fit band' },
  macro: { dollar: { score: 63, regime: 'Firm' } },
  goldSilver: { status: 'calculated', ratio: 86.4, percentile: 83 },
  cot: { percentile: 92 },
};

test('each gold question gets one word, one sentence and the panel that backs it', () => {
  const brief = buildMetalsBrief(inputs);
  const byKey = Object.fromEntries(brief.cards.map((card) => [card.key, card]));
  assert.deepEqual(brief.cards.map((card) => [card.key, card.answer]), [
    ['trend', 'Up'], ['value', 'Stretched'], ['realYield', 'Far above'], ['dollar', 'Headwind'], ['ratio', 'Silver cheap'], ['positioning', 'Crowded long'],
  ]);
  assert.equal(byKey.trend.sentence, 'Its 50-day average is above its 200-day and it is up 3.4% over 20 sessions. The short-term move is stretched (RSI above 70).');
  // The gold schedule, not the first one in the list.
  assert.match(byKey.value.sentence, /"Stretched" tier, scoring 86 of 100\. This says how far it has run, not where it goes next\.$/);
  assert.match(byKey.realYield.sentence, /^Gold is 22\.4% above the price .* outside the range/);
  assert.equal(byKey.dollar.tone, 'negative');
  assert.match(byKey.ratio.sentence, /^An ounce of gold buys 86\.4 ounces of silver, more than on 83% of days/);
  assert.equal(byKey.positioning.scale.label, '92nd percentile');
  assert.equal(brief.summary, 'Gold: trend up, stretched against its own history, the dollar a headwind, positioning crowded long.');
  for (const card of brief.cards) assert.ok(card.anchor, `${card.key} links to its panel`);
});

test('the valuation tier reads in plain words', () => {
  const tier = (label) => buildMetalsBrief({ accumulation: { schedules: [{ key: 'gold', status: 'calculated', risk: 30, tier: { label } }] } }).cards[0];
  assert.deepEqual(['Deep value', 'Discounted', 'Baseline', 'Extended', 'Stretched'].map((label) => tier(label).answer), ['Cheap', 'Below average', 'Average', 'Rich', 'Stretched']);
  assert.equal(tier('Discounted').tone, 'positive');
});

test('a reading that did not publish is left out', () => {
  const brief = buildMetalsBrief({ gold: inputs.gold, realYield: { status: 'unavailable' }, goldSilver: { status: 'unavailable' } });
  assert.deepEqual(brief.cards.map((card) => card.key), ['trend']);
  assert.equal(brief.summary, null);
  assert.deepEqual(buildMetalsBrief().cards, []);
});
