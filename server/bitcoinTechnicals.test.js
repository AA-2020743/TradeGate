import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateBitcoinTechnicals,
  calculateBollingerSqueeze,
  calculateMomentumSlope,
  calculateMovingAverageStack,
  calculateRangePercentile,
  calculateStochasticRsi,
  calculateTdSetup,
  calculateVolatilityAdjustedMomentum,
  detectRsiDivergences,
  emaSeries,
  normalizeCloses,
  rsiSeries,
  smaSeries,
  toWeeklyCloses,
} from './bitcoinTechnicals.js';

const START = Date.UTC(2018, 0, 1);

function series(closes, startMs = START) {
  return closes.map((close, index) => ({
    date: new Date(startMs + (index * 86_400_000)).toISOString().slice(0, 10),
    close,
  }));
}

function build(length, shape) {
  return series(Array.from({ length }, (_, index) => shape(index)));
}

/** A quiet, gently oscillating tape — a real RSI needs both up and down bars. */
function calm(length, level = 100) {
  return Array.from({ length }, (_, index) => level + (6 * Math.sin(index / 2.3)) + (3 * Math.cos(index / 1.7)));
}

/** `steps` closes walking from `previous` to `target`, excluding the start. */
function ramp(previous, target, steps) {
  return Array.from({ length: steps }, (_, index) => previous + (((target - previous) * (index + 1)) / steps));
}

function jitter(values, amplitude = 0.5) {
  return values.map((value, index) => value + (amplitude * Math.sin(index / 1.9)));
}

test('smaSeries and emaSeries leave the warm-up period null', () => {
  const values = [1, 2, 3, 4, 5];
  assert.deepEqual(smaSeries(values, 3), [null, null, 2, 3, 4]);
  assert.deepEqual(smaSeries(values, 9), [null, null, null, null, null]);
  const ema = emaSeries(values, 3);
  assert.equal(ema[0], null);
  assert.equal(ema[1], null);
  assert.equal(ema[2], 2);
  assert.equal(ema[4] > ema[3], true);
});

test('rsiSeries pins the extremes and starts at the period bar', () => {
  const rising = rsiSeries(Array.from({ length: 30 }, (_, index) => 100 + index));
  assert.equal(rising[13], null);
  assert.equal(rising[14], 100);
  const falling = rsiSeries(Array.from({ length: 30 }, (_, index) => 100 - index));
  assert.equal(falling.at(-1), 0);
  const flat = rsiSeries(Array.from({ length: 30 }, () => 100));
  assert.equal(flat.at(-1), 50);
  assert.deepEqual(rsiSeries([1, 2, 3]), [null, null, null]);
});

test('normalizeCloses drops unusable rows and sorts by date', () => {
  const rows = normalizeCloses([
    { date: '2024-01-03', close: 3 },
    { date: '2024-01-01', close: 1 },
    { date: '2024-01-02', close: 0 },
    { date: 'not a date', close: 5 },
    { date: '2024-01-04', close: null },
    { timestamp: '2024-01-05T00:00:00.000Z', value: 5 },
  ]);
  assert.deepEqual(rows.map((row) => row.date), ['2024-01-01', '2024-01-03', '2024-01-05']);
  assert.deepEqual(rows.map((row) => row.close), [1, 3, 5]);
});

test('toWeeklyCloses keeps the last close of each week', () => {
  const rows = normalizeCloses(build(21, (index) => 100 + index));
  const weekly = toWeeklyCloses(rows);
  assert.equal(weekly.length, 4);
  assert.equal(weekly.at(-1).close, 120);
  weekly.slice(0, -1).forEach((row, index) => {
    assert.equal(row.time < weekly[index + 1].time, true);
  });
});

test('stochastic RSI reports oversold on a slide and overbought on a rally', () => {
  const base = calm(100);
  const last = base.at(-1);
  const down = calculateStochasticRsi(series([...base, ...Array.from({ length: 10 }, (_, index) => last * (0.97 ** (index + 1)))]));
  assert.equal(down.status, 'calculated');
  assert.equal(down.zone, 'oversold');
  const up = calculateStochasticRsi(series([...base, ...Array.from({ length: 10 }, (_, index) => last * (1.03 ** (index + 1)))]));
  assert.equal(up.zone, 'overbought');
  assert.equal(up.k >= 80, true);
});

test('stochastic RSI reports the middle of the range on a one-way tape rather than a false extreme', () => {
  // Every bar down means RSI is pinned at zero, so its own range has no width.
  // Reporting 50 is the honest answer; reporting oversold would be inventing one.
  const result = calculateStochasticRsi(build(120, (index) => 200 - index));
  assert.equal(result.status, 'calculated');
  assert.equal(result.k, 50);
  assert.equal(result.zone, 'neutral');
});

test('stochastic RSI refuses a history shorter than its own smoothing chain', () => {
  const thin = calculateStochasticRsi(build(20, (index) => 100 + index));
  assert.equal(thin.status, 'unavailable');
  assert.match(thin.reason, /Needs 34 daily closes/);
});

test('stochastic RSI names the %K/%D cross on the bar it happens', () => {
  const base = calm(100);
  const last = base.at(-1);
  const slide = Array.from({ length: 12 }, (_, index) => last * (0.97 ** (index + 1)));
  const turn = slide.at(-1) * 1.04;
  const atTheCross = calculateStochasticRsi(series([...base, ...slide, turn]));
  assert.equal(atTheCross.cross, 'bullish');
  // Float dust in a rolling mean must not swallow the cross: both lines sit at
  // an arithmetic zero on the bar before, which compares as ~1e-14 apart.
  const later = calculateStochasticRsi(series([...base, ...slide, turn, turn * 1.04]));
  assert.equal(later.cross, null);
});

// Two troughs: the second is lower in price but reached far more gently, which
// is exactly the shape a regular bullish divergence describes.
const BULLISH_DIVERGENCE = jitter([
  ...calm(40),
  ...ramp(100, 64, 10),
  ...ramp(64, 91, 10),
  ...ramp(91, 63, 16),
  ...ramp(63, 78, 8),
]);

// The mirror: a higher price high made on visibly weaker momentum.
const BEARISH_DIVERGENCE = jitter([
  ...calm(40),
  ...ramp(100, 136, 10),
  ...ramp(136, 109, 10),
  ...ramp(109, 137, 16),
  ...ramp(137, 122, 8),
]);

test('a lower price low against a higher RSI low is a regular bullish divergence', () => {
  const result = detectRsiDivergences(series(BULLISH_DIVERGENCE));
  assert.equal(result.status, 'calculated');
  const bullish = result.divergences.find((entry) => entry.kind === 'regularBullish');
  assert.ok(bullish, `expected a regular bullish divergence, got ${JSON.stringify(result.divergences)}`);
  assert.equal(bullish.to.price < bullish.from.price, true);
  assert.equal(bullish.to.rsi > bullish.from.rsi, true);
  assert.equal(bullish.direction, 'bullish');
});

test('a higher price high against a lower RSI high is a regular bearish divergence', () => {
  const result = detectRsiDivergences(series(BEARISH_DIVERGENCE));
  const bearish = result.divergences.find((entry) => entry.kind === 'regularBearish');
  assert.ok(bearish, `expected a regular bearish divergence, got ${JSON.stringify(result.divergences)}`);
  assert.equal(bearish.to.price > bearish.from.price, true);
  assert.equal(bearish.to.rsi < bearish.from.rsi, true);
});

test('divergences report how many bars ago they confirmed rather than implying they are live', () => {
  const result = detectRsiDivergences(series(BULLISH_DIVERGENCE));
  assert.equal(result.divergences.length > 0, true);
  result.divergences.forEach((entry) => {
    assert.equal(Number.isFinite(entry.barsSinceConfirmed), true);
    assert.equal(entry.barsSinceConfirmed >= 0, true);
  });
});

test('a clean trend produces no divergence at all', () => {
  const result = detectRsiDivergences(build(200, (index) => 100 * (1.004 ** index)));
  assert.equal(result.status, 'calculated');
  assert.deepEqual(result.divergences, []);
  assert.match(result.read, /No RSI divergence/);
});

test('the divergence scan refuses a history too short to confirm two pivots', () => {
  const result = detectRsiDivergences(build(30, (index) => 100 + index));
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.divergences, []);
});

test('the moving-average stack ranks a long advance bullish and finds the golden cross', () => {
  const closes = [
    ...Array.from({ length: 300 }, (_, index) => 200 - (index * 0.3)),
    ...Array.from({ length: 400 }, (_, index) => 110 + (index * 0.8)),
  ];
  const result = calculateMovingAverageStack(series(closes));
  assert.equal(result.stackAlignment, 'bullish');
  assert.equal(result.crossState, 'golden');
  assert.equal(result.cross.type, 'golden');
  assert.equal(result.aboveCount, result.totalPublished);
});

test('the weekly averages run on weekly closes, not a day-count approximation', () => {
  const closes = Array.from({ length: 1600 }, (_, index) => 100 + index);
  const result = calculateMovingAverageStack(series(closes));
  const weeklyRows = toWeeklyCloses(normalizeCloses(series(closes)));
  assert.equal(result.weeklyObservations, weeklyRows.length);
  const sma200w = result.averages.find((entry) => entry.key === 'sma200w');
  const expected = weeklyRows.slice(-200).reduce((total, row) => total + row.close, 0) / 200;
  assert.equal(sma200w.status, 'calculated');
  assert.equal(Math.abs(sma200w.value - expected) < 0.01, true);
});

test('a short history publishes what it can and says which averages are missing', () => {
  const result = calculateMovingAverageStack(build(120, (index) => 100 + index));
  assert.equal(result.status, 'provisional');
  const sma200w = result.averages.find((entry) => entry.key === 'sma200w');
  assert.equal(sma200w.status, 'unavailable');
  assert.match(sma200w.reason, /Needs 200 weekly closes/);
  const ema20 = result.averages.find((entry) => entry.key === 'ema20');
  assert.equal(ema20.status, 'calculated');
});

test('the stretch Z-score is marked provisional until its own distribution is deep enough', () => {
  const result = calculateMovingAverageStack(build(280, (index) => 100 + index));
  assert.equal(result.zScoreStatus, 'provisional');
  assert.equal(Number.isFinite(result.zScore), true);
  const deep = calculateMovingAverageStack(build(700, (index) => 100 + Math.sin(index / 20) * 10 + index * 0.1));
  assert.equal(deep.zScoreStatus, 'calculated');
});

test('the stack refuses a history under thirty closes', () => {
  const result = calculateMovingAverageStack(build(10, () => 100));
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.averages, []);
});

test('bollinger bandwidth reads a squeeze after volatility collapses', () => {
  const closes = [
    ...Array.from({ length: 260 }, (_, index) => 100 + ((index % 2 ? 1 : -1) * 12) + index * 0.05),
    ...Array.from({ length: 60 }, (_, index) => 118 + ((index % 2 ? 1 : -1) * 0.2)),
  ];
  const result = calculateBollingerSqueeze(series(closes));
  assert.equal(result.state, 'squeeze');
  assert.equal(result.percentile <= 20, true);
  assert.equal(result.upper > result.middle && result.middle > result.lower, true);
  assert.match(result.read, /without saying which way/);
});

test('bollinger bandwidth reads expansion when the tape goes violent', () => {
  const closes = [
    ...Array.from({ length: 260 }, (_, index) => 100 + ((index % 2 ? 1 : -1) * 0.2)),
    ...Array.from({ length: 60 }, (_, index) => 100 + ((index % 2 ? 1 : -1) * 15)),
  ];
  const result = calculateBollingerSqueeze(series(closes));
  assert.equal(result.state, 'expansion');
});

test('bollinger bandwidth is provisional while it has fewer readings than its ranking window', () => {
  const result = calculateBollingerSqueeze(build(80, (index) => 100 + Math.sin(index) * 5));
  assert.equal(result.status, 'provisional');
  assert.equal(result.rankedAgainst < 252, true);
  assert.equal(calculateBollingerSqueeze(build(40, () => 100)).status, 'unavailable');
});

test('the range percentile places price inside its own trailing range', () => {
  const closes = [
    ...Array.from({ length: 300 }, (_, index) => 100 + Math.sin(index / 5) * 5),
    ...Array.from({ length: 30 }, (_, index) => 100 + index),
  ];
  const result = calculateRangePercentile(series(closes));
  assert.equal(result.positionInRange, 100);
  assert.equal(result.high >= result.low, true);
  assert.match(result.methodology, /Closes only/);
});

test('the range percentile refuses a history it cannot rank', () => {
  assert.equal(calculateRangePercentile(build(50, () => 100)).status, 'unavailable');
});

test('the TD setup counts consecutive closes against the bar four back', () => {
  const down = calculateTdSetup(series([
    ...Array.from({ length: 10 }, () => 100),
    ...Array.from({ length: 9 }, (_, index) => 99 - index),
  ]));
  assert.equal(down.direction, 'buy');
  assert.equal(down.count, 9);
  assert.equal(down.complete, true);
  const up = calculateTdSetup(series([
    ...Array.from({ length: 10 }, () => 100),
    ...Array.from({ length: 5 }, (_, index) => 101 + index),
  ]));
  assert.equal(up.direction, 'sell');
  assert.equal(up.count, 5);
  assert.equal(up.complete, false);
});

test('the TD setup caps the display count at nine but keeps the raw run', () => {
  const result = calculateTdSetup(series([
    ...Array.from({ length: 10 }, () => 100),
    ...Array.from({ length: 15 }, (_, index) => 99 - index),
  ]));
  assert.equal(result.count, 9);
  assert.equal(result.rawCount, 15);
});

test('the TD countdown and TDST line are withheld rather than approximated from closes', () => {
  const result = calculateTdSetup(build(60, (index) => 100 - index));
  assert.equal(result.countdown.status, 'unavailable');
  assert.match(result.countdown.reason, /highs and lows/);
  assert.equal(result.perfected.status, 'unavailable');
  assert.equal(result.tdst.status, 'unavailable');
});

test('a flat tape runs no TD setup at all', () => {
  const result = calculateTdSetup(build(40, () => 100));
  assert.equal(result.direction, null);
  assert.equal(result.count, 0);
  assert.match(result.read, /no TD setup is running/);
});

test('momentum slope separates a rising RSI from a falling one at the same level', () => {
  const accelerating = calculateMomentumSlope(series([
    ...Array.from({ length: 60 }, (_, index) => 200 - index),
    ...Array.from({ length: 20 }, (_, index) => 140 + (index * 2)),
  ]));
  assert.equal(accelerating.direction, 'accelerating');
  assert.equal(accelerating.slopePerBar > 0, true);
  const decelerating = calculateMomentumSlope(series([
    ...Array.from({ length: 60 }, (_, index) => 100 + index),
    ...Array.from({ length: 20 }, (_, index) => 160 - (index * 2)),
  ]));
  assert.equal(decelerating.direction, 'decelerating');
});

test('volatility-adjusted momentum separates a quiet grind from a violent one', () => {
  const grind = calculateVolatilityAdjustedMomentum(build(100, (index) => 100 * (1.004 ** index)));
  const chop = calculateVolatilityAdjustedMomentum(series(
    Array.from({ length: 100 }, (_, index) => 100 * (1.004 ** index) * (index % 2 ? 1.08 : 0.92)),
  ));
  assert.equal(grind.status, 'calculated');
  assert.equal(chop.status, 'calculated');
  assert.equal(Math.abs(grind.returnPercent - chop.returnPercent) < 20, true);
  assert.equal(grind.ratio > chop.ratio, true);
  assert.equal(grind.quality, 'strong');
});

test('volatility-adjusted momentum refuses a window it cannot fill', () => {
  assert.equal(calculateVolatilityAdjustedMomentum(build(40, (index) => 100 + index)).status, 'unavailable');
  assert.equal(calculateVolatilityAdjustedMomentum(build(120, () => 100)).status, 'unavailable');
});

// A trend with realistic variation around it. A pure exponential has exactly
// constant relative Bollinger bandwidth, so the squeeze module correctly
// refuses to rank it - which says something about the fixture, not the tape.
const drifting = (index, rate) => 100 * (rate ** index) * (1 + (Math.sin(index / 23) * 0.02) + (Math.sin(index / 7) * 0.008));

test('the composite publishes a score, its legs and what is still missing', () => {
  // A 200-week average needs roughly four years of dailies, so a fully
  // "calculated" composite is only honest on that much history.
  const result = calculateBitcoinTechnicals(build(1600, (index) => drifting(index, 1.001)));
  assert.equal(result.status, 'calculated');
  assert.equal(result.unavailableModules.length, 0);
  assert.equal(result.provisionalModules.length, 0);
  assert.equal(result.score > 60, true);
  assert.equal(result.stance, 'Strong');
  assert.equal(result.legs.length, 7);
  result.legs.forEach((leg) => {
    assert.equal(Number.isInteger(leg.score), true);
    assert.equal(leg.score >= 0 && leg.score <= 100, true);
  });
});

test('a falling tape scores below a rising one on the same composite', () => {
  const up = calculateBitcoinTechnicals(build(1600, (index) => drifting(index, 1.001)));
  const down = calculateBitcoinTechnicals(build(1600, (index) => drifting(index, 0.999)));
  assert.equal(down.score < up.score, true);
  assert.equal(['Weak', 'Guarded'].includes(down.stance), true);
});

test('a thin history reports as provisional, not as a settled reading', () => {
  const result = calculateBitcoinTechnicals(build(120, (index) => 100 + index));
  assert.equal(result.status, 'provisional');
  // The stack cannot reach a 200-week average on 120 days, so even though every
  // module publishes something, the composite must not claim to be complete.
  assert.equal(result.modules.movingAverages.status, 'provisional');
  assert.equal(result.provisionalModules.includes('movingAverages'), true);
});

test('a history too short for a whole module names that module', () => {
  const result = calculateBitcoinTechnicals(build(80, (index) => 100 + Math.sin(index / 3) * 5 + index));
  assert.equal(result.status, 'provisional');
  assert.equal(result.unavailableModules.includes('range'), true);
  assert.equal(result.coverage < 100, true);
});

test('too little history publishes no score rather than a calm-looking one', () => {
  const result = calculateBitcoinTechnicals(build(15, (index) => 100 + index));
  assert.equal(result.status, 'unavailable');
  assert.equal(result.score, null);
  assert.match(result.reason, /Fewer than three momentum legs/);
});

test('an empty history is handled without throwing', () => {
  const result = calculateBitcoinTechnicals([]);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.observations, 0);
  assert.equal(result.asOf, null);
});
