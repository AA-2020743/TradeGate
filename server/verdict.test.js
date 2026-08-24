import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCryptoVerdict, buildMetalsVerdict, buildVerdict } from './verdict.js';

const signal = (key, name, score, weight, extra = {}) => ({ key, name, score, weight, ...extra });

test('a verdict renormalises by the weight that actually reported', () => {
  // A missing input must not pull the verdict toward its own absence, which is
  // what happens when the divisor stays at the full weight.
  const verdict = buildVerdict({
    signals: [
      signal('a', 'Price trend', 80, 0.4),
      signal('b', 'Market breadth', 80, 0.3),
      signal('c', 'Liquidity impulse', 80, 0.2),
      signal('d', 'Credit conditions', null, 0.1, { reason: 'no spread history' }),
    ],
  });
  // Three readings all at 80 average to 80, not to 72.
  assert.equal(verdict.score, 80);
  assert.equal(verdict.coverage, 90);
  assert.equal(verdict.status, 'provisional', 'a missing input keeps it provisional');
  assert.deepEqual(verdict.missing.map((entry) => entry.name), ['Credit conditions']);
});

test('a verdict always publishes what argues against it', () => {
  const verdict = buildVerdict({
    signals: [
      signal('a', 'Price trend', 88, 0.3),
      signal('b', 'Market breadth', 22, 0.25, { detail: 'only 31% above the 200-day' }),
      signal('c', 'Liquidity impulse', 70, 0.25),
      signal('d', 'Credit conditions', 30, 0.2),
    ],
  });
  assert.ok(verdict.opposing.length >= 2, 'dissent must be listed, not summarised away');
  assert.equal(verdict.opposing[0].name, 'Market breadth');
  assert.match(verdict.read, /argues the other way/);
  // Split readings must not read as a confident call.
  assert.equal(verdict.confidence, 'low');
  assert.match(verdict.confidenceReason, /split/);
});

test('contributions rank by how much they move the verdict, not by how extreme they are', () => {
  const verdict = buildVerdict({
    signals: [
      // Further from neutral, but carrying almost no weight.
      signal('tiny', 'Sentiment balance', 100, 0.05),
      // Closer to neutral, but carrying most of the verdict.
      signal('heavy', 'Price trend', 70, 0.8),
      signal('mid', 'Market breadth', 62, 0.15),
    ],
  });
  assert.equal(verdict.supporting[0].name, 'Price trend');
});

test('a verdict says how close it is to being a different verdict', () => {
  const nearBoundary = buildVerdict({
    signals: [signal('a', 'A', 66, 1), signal('b', 'B', 66, 1), signal('c', 'C', 66, 1)],
  });
  assert.equal(nearBoundary.call, 'Constructive');
  assert.equal(nearBoundary.margin.becomes, 'Neutral');
  assert.equal(nearBoundary.margin.points, 1);
  // A call one point from its boundary cannot be reported as high confidence.
  assert.notEqual(nearBoundary.confidence, 'high');
  assert.match(nearBoundary.confidenceReason, /1 point from Neutral/);
});

test('a verdict refuses when too little reported to reach one', () => {
  const verdict = buildVerdict({
    signals: [
      signal('a', 'Price trend', 61, 0.3),
      signal('b', 'Market breadth', 58, 0.25),
      signal('c', 'Liquidity impulse', null, 0.25),
      signal('d', 'Credit conditions', null, 0.2),
    ],
  });
  assert.equal(verdict.status, 'unavailable');
  assert.match(verdict.reason, /3 readings/);
  // The shape stays the same so a consumer never special-cases it.
  for (const key of ['call', 'headline', 'confidence', 'read', 'margin']) assert.equal(verdict[key], null);
  assert.deepEqual(verdict.supporting, []);
});

test('a near-neutral score does not claim a direction it has not earned', () => {
  const verdict = buildVerdict({
    signals: [signal('a', 'A', 56, 1), signal('b', 'B', 54, 1), signal('c', 'C', 55, 1)],
  });
  assert.equal(verdict.call, 'Neutral');
  // "Neutral at 55, supportive" reads as a contradiction rather than a nuance.
  assert.doesNotMatch(verdict.read, /supportive on this scale/);
  assert.match(verdict.read, /points off neutral/);
});

test('a stale input holds confidence back and says which one', () => {
  const verdict = buildVerdict({
    signals: [
      signal('a', 'Price trend', 72, 0.4),
      signal('b', 'Market breadth', 70, 0.3),
      signal('c', 'Liquidity impulse', 68, 0.3, { ageDays: 61 }),
    ],
  });
  assert.match(verdict.confidenceReason, /Liquidity impulse is 61 days old/);
});

test('a verdict does not claim every input reported when one did not', () => {
  // 90% coverage is enough for high confidence, but the sentence explaining
  // that confidence must not contradict the "not counted" line beside it.
  const verdict = buildVerdict({
    signals: [
      signal('a', 'Price trend', 78, 0.27),
      signal('b', 'Price momentum', 64, 0.2),
      signal('c', 'Market breadth', 71, 0.2),
      signal('d', 'Liquidity impulse', 70, 0.13),
      signal('e', 'Volatility quality', 66, 0.1),
      signal('f', 'Earnings revisions', null, 0.1, { reason: 'no counts returned' }),
    ],
  });
  assert.equal(verdict.confidence, 'high');
  assert.doesNotMatch(verdict.confidenceReason, /Every input reported/);
  assert.match(verdict.confidenceReason, /1 input did not report/);
  assert.equal(verdict.status, 'provisional');
});

test('several reasons for low confidence read as a sentence, not a stammer', () => {
  const verdict = buildVerdict({
    signals: [
      signal('a', 'Price trend', 96, 0.34),
      signal('b', 'Market breadth', 12, 0.33, { ageDays: 90 }),
      signal('c', 'Liquidity impulse', 56, 0.33),
    ],
  });
  assert.equal(verdict.confidence, 'low');
  assert.doesNotMatch(verdict.confidenceReason, /, and .*, and /);
  assert.match(verdict.confidenceReason, / and /);
});

test('the crypto verdict inverts funding and the dollar, and follows stablecoin supply', () => {
  const base = {
    bitcoin: {
      technicals: { status: 'calculated', score: 72, stance: 'Strong' },
      stablecoins: { status: 'calculated', change30dPercent: 2.1, state: 'Dry powder building' },
      leverage: { status: 'calculated', percentile: 50, annualizedPercent: 10 },
    },
    globalLiquidity: { status: 'calculated', score: 68, regime: 'Expansion' },
    usdStrength: { status: 'calculated', score: 40, regime: 'Soft' },
  };
  const withFunding = (percentile) => buildCryptoVerdict({ ...base, bitcoin: { ...base.bitcoin, leverage: { status: 'calculated', percentile, annualizedPercent: percentile / 5 } } });
  const withDollar = (score) => buildCryptoVerdict({ ...base, usdStrength: { status: 'calculated', score, regime: 'x' } });
  const withStables = (change) => buildCryptoVerdict({ ...base, bitcoin: { ...base.bitcoin, stablecoins: { status: 'calculated', change30dPercent: change, state: 'x' } } });

  // Crowded leverage is fragile, so an extreme funding percentile must lower
  // the verdict, not raise it.
  assert.ok(withFunding(95).score < withFunding(10).score);
  // A strong dollar is a headwind.
  assert.ok(withDollar(85).score < withDollar(15).score);
  // Expanding stablecoin supply is capital arriving.
  assert.ok(withStables(4).score > withStables(-3).score);
});

test('the crypto verdict leaves out the legs whose direction depends on a horizon', () => {
  const verdict = buildCryptoVerdict({
    bitcoin: {
      technicals: { status: 'calculated', score: 60 },
      leverage: { status: 'calculated', percentile: 50 },
      stablecoins: { status: 'calculated', change30dPercent: 0 },
      // Present and calculated, but deliberately not counted: a high MVRV is
      // bearish over a cycle and bullish over a quarter, a drawdown is
      // restrictive to a trend follower and an opportunity to a contrarian,
      // and high realized volatility accompanies both capitulation and melt-up.
      valuation: { status: 'calculated', percentile: 95, band: 'Late cycle' },
      drawdown: { status: 'calculated', drawdownPct: -40 },
      realizedVolatility: { status: 'calculated', percentile: 88 },
    },
    globalLiquidity: { status: 'calculated', score: 60 },
    usdStrength: { status: 'calculated', score: 50 },
  });
  const counted = [...verdict.supporting, ...verdict.opposing, ...verdict.missing].map((entry) => entry.key);
  for (const excluded of ['valuation', 'drawdown', 'realizedVolatility']) {
    assert.ok(!counted.includes(excluded), `${excluded} must not vote on a directional axis`);
  }
});

test('one heavy dissenter holds confidence back even when outvoted', () => {
  // Counting readings understates a single heavy dissenter: two-of-three is a
  // 67% majority that still leaves a third of the verdict arguing the other
  // way, and that used to pass as high confidence.
  const verdict = buildVerdict({
    signals: [
      signal('a', 'Broad dollar model', 78, 0.45),
      signal('b', 'Cross-rate breadth', 34, 0.3),
      signal('c', 'US yield advantage', 55, 0.25),
    ],
  });
  assert.equal(verdict.dissentWeight, 30);
  assert.notEqual(verdict.confidence, 'high');
  assert.match(verdict.confidenceReason, /30% of the weight argues the other way/);
});

test('unanimous readings carry no dissent and are not held back', () => {
  const verdict = buildVerdict({
    signals: [
      signal('a', 'Broad dollar model', 78, 0.45),
      signal('b', 'Cross-rate breadth', 83, 0.3),
      signal('c', 'US yield advantage', 72, 0.25),
    ],
  });
  assert.equal(verdict.dissentWeight, 0);
  assert.equal(verdict.confidence, 'high');
  assert.deepEqual(verdict.opposing, []);
});

test('an acronym survives the mid-sentence lowercasing in a headline', () => {
  const verdict = buildVerdict({
    signals: [
      signal('a', 'US yield advantage', 78, 0.4),
      signal('b', 'Broad dollar model', 74, 0.35),
      signal('c', 'Cross-rate breadth', 30, 0.25),
    ],
  });
  assert.match(verdict.headline, /US yield advantage/);
  assert.doesNotMatch(verdict.headline, /us yield advantage/);
  // Ordinary names still read as part of the sentence.
  assert.match(verdict.headline, /broad dollar model/);
  assert.match(verdict.headline, /cross-rate breadth/);
});

test('the metals verdict inverts the dollar and does not double-count real yields', () => {
  const soft = buildMetalsVerdict({ goldTechnical: { score: 60 }, usdStrength: { score: 20 }, globalLiquidity: { score: 60 } });
  const firm = buildMetalsVerdict({ goldTechnical: { score: 60 }, usdStrength: { score: 80 }, globalLiquidity: { score: 60 } });
  // Gold is priced in dollars, so a firmer dollar is a headwind.
  assert.ok(firm.score < soft.score);

  // Real yields are gold's most direct driver and are already a component of
  // the broad-dollar model. Adding them again under their own name would weigh
  // them twice, so the verdict carries exactly three signals.
  const keys = [...soft.supporting, ...soft.opposing, ...soft.missing].map((entry) => entry.key);
  assert.deepEqual(keys.sort(), ['dollar', 'globalLiquidity', 'technicals']);
  assert.ok(!keys.includes('realYield'));
});
