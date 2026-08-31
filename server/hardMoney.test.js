import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRatioValuation, compareIncomeContribution, rankHardMoneyStrength } from './hardMoney.js';

const DAY = 86_400_000;
const SESSIONS = 1_400;
const day = (index) => new Date(Date.UTC(2021, 0, 1) + (index * DAY)).toISOString().slice(0, 10);
const series = (valueAt) => Array.from({ length: SESSIONS }, (_, index) => ({ date: day(index), value: valueAt(index) }));

const gold = series((index) => 1_800 * Math.exp(index * 0.00045));
const priceIndex = series((index) => 4_000 * Math.exp(index * 0.00030));
const totalReturnIndex = series((index) => 4_000 * Math.exp(index * 0.00036));

const value = (key, numerator, denominator) => calculateRatioValuation({
  key, name: key, numerator, denominator, numeratorName: 'asset', denominatorName: 'gold',
});

test('an asset up in dollars and down in gold reports both, and the wedge between them', () => {
  const valuation = value('spx', priceIndex, gold);
  const year = valuation.horizons.find((horizon) => horizon.key === 'year');

  // Gold rising faster than the index: a nominal gain that is a real loss.
  assert.ok(year.nominalPercent > 0, 'up in dollars');
  assert.ok(year.realPercent < 0, 'down in gold');
  assert.ok(year.denominatorPercent > year.nominalPercent, 'gold outran it');
  // The wedge is the denominator's contribution, not a claim about why gold
  // moved - gold rising on its own demand looks identical here.
  assert.equal(year.denominatorEffectPoints, Math.round((year.nominalPercent - year.realPercent) * 100) / 100);
});

test('the dividend contribution is measured in gold, not in dollars', () => {
  const price = value('price', priceIndex, gold);
  const total = value('total', totalReturnIndex, gold);
  const income = compareIncomeContribution(price, total);

  assert.equal(income.status, 'calculated');
  const longest = income.horizons.filter((horizon) => horizon.status === 'calculated').at(-1);
  assert.ok(longest.incomePoints > 0);
  assert.equal(longest.incomePoints, Math.round((longest.totalRealPercent - longest.priceRealPercent) * 100) / 100);

  // The case worth naming: the shares themselves bought no more metal, and
  // every point of real return came from income.
  assert.ok(longest.priceRealPercent < 0 && longest.totalRealPercent > longest.priceRealPercent);
});

test('income contribution refuses when either leg is missing', () => {
  const price = value('price', priceIndex, gold);
  const missing = { status: 'unavailable', reason: 'no total-return history' };
  assert.equal(compareIncomeContribution(price, missing).status, 'unavailable');
  assert.equal(compareIncomeContribution(missing, price).status, 'unavailable');
});

test('cross-asset ranking flags what is up in dollars and down in gold', () => {
  const bitcoin = series((index) => 30_000 * Math.exp(index * 0.00090));
  const ranked = rankHardMoneyStrength([value('spx', priceIndex, gold), value('btc', bitcoin, gold)]);

  assert.equal(ranked.status, 'calculated');
  assert.ok(ranked.diverging.includes('spx'), 'the index gained in dollars and lost in gold');
  assert.ok(!ranked.diverging.includes('btc'));
  assert.match(ranked.read, /the currency rather than the asset/);
});

test('a ratio with too little shared history refuses rather than extrapolating', () => {
  const short = series((index) => 100 + index).slice(0, 100);
  const valuation = value('thin', short, gold.slice(0, 100));
  assert.equal(valuation.status, 'unavailable');
  assert.match(valuation.reason, /252 sessions/);

  // Two series that never share a date have nothing to align.
  const offset = Array.from({ length: 400 }, (_, index) => ({ date: day(index + 5_000), value: 100 + index }));
  assert.equal(value('disjoint', offset, gold).status, 'unavailable');
});

test('ranking needs two usable ratios before it compares anything', () => {
  const single = rankHardMoneyStrength([value('spx', priceIndex, gold)]);
  assert.equal(single.status, 'unavailable');
  assert.equal(rankHardMoneyStrength([]).status, 'unavailable');
  assert.equal(rankHardMoneyStrength().status, 'unavailable');
});
