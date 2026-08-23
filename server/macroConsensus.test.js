import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateModelConsensus,
  calculateModelCorrelationMatrix,
  collectMacroSignals,
  evaluateMacroAlerts,
} from './macroConsensus.js';

const strongModels = {
  macroRegime: { status: 'calculated', score: 72, regime: 'Expansion / risk-on' },
  liquidity: { status: 'calculated', score: 78, regime: 'Expansion' },
  globalLiquidity: { status: 'calculated', score: 70, regime: 'Expansion' },
  growthNowcast: { status: 'calculated', score: 74, state: 'Accelerating' },
  dataSurprise: { status: 'calculated', score: 68, state: 'Data running above its own trend' },
  yieldCurve: { status: 'calculated', state: 'Steepening', spreads: [{ key: 'tenTwo', spread: 0.8 }] },
  termPremium: { status: 'calculated', percentile: 30, driver: 'rate expectations' },
  reserveScarcity: { status: 'calculated', percentile: 25, state: 'Reserves ample' },
  usdStrength: { status: 'calculated', score: 35, regime: 'Soft' },
  inflation: { status: 'calculated', gapVsRealized: 0.2, state: 'Market and realized inflation are close' },
  regimeHistory: { status: 'calculated', current: { regime: 'Expansion / risk-on', runDays: 120, typicalDwellDays: 200 } },
};

test('signals place every directional model on one axis and mark what is missing', () => {
  const { directional, cautions } = collectMacroSignals(strongModels);
  assert.equal(directional.every((signal) => signal.available), true);
  assert.equal(directional.find((signal) => signal.key === 'dollar').score, 65, 'a soft dollar reads risk-positive');
  // Percentile-derived readings are compressed to a 20-80 band before joining
  // the axis, so ample reserves read positive without pinning to it.
  assert.equal(directional.find((signal) => signal.key === 'reserves').score, 65, 'ample reserves read risk-positive');
  assert.equal(directional.find((signal) => signal.key === 'termPremium').score, 62);

  const thin = collectMacroSignals({ liquidity: { status: 'calculated', score: 60 } });
  assert.equal(thin.directional.filter((signal) => signal.available).length, 1);
  assert.equal(thin.directional.find((signal) => signal.key === 'curve').score, null);

  // A caution peaks when nothing is wrong, so it cannot sit on the risk axis.
  assert.equal(cautions.map((signal) => signal.key).sort().join(','), 'inflation,regimeDwell');
  assert.equal(directional.some((signal) => signal.key === 'inflation'), false);
  assert.equal(cautions.every((signal) => signal.directional === false), true);
});

test('an unavailable model contributes nothing rather than a neutral fifty', () => {
  const { directional } = collectMacroSignals({ ...strongModels, growthNowcast: { status: 'unavailable', reason: 'no proxies', score: null } });
  const growth = directional.find((signal) => signal.key === 'growth');
  assert.equal(growth.available, false);
  assert.equal(growth.score, null);
});

test('models that agree report broad agreement and no contradictions', () => {
  const consensus = calculateModelConsensus(strongModels);
  assert.equal(consensus.status, 'calculated');
  assert.equal(consensus.state, 'Models broadly agree');
  assert.deepEqual(consensus.contradictions, []);
  assert.equal(consensus.spread < 35, true, `spread was ${consensus.spread}`);
});

test('a growth nowcast against an inverted curve is named as a contradiction', () => {
  const divided = calculateModelConsensus({
    ...strongModels,
    growthNowcast: { status: 'calculated', score: 88, state: 'Accelerating' },
    yieldCurve: { status: 'calculated', state: 'Inverted', spreads: [{ key: 'tenTwo', spread: -1.1 }] },
    dataSurprise: { status: 'calculated', score: 20, state: 'Data running below its own trend' },
  });
  assert.equal(['Models partly divided', 'Models sharply divided'].includes(divided.state), true, divided.state);
  const pair = divided.contradictions.find((entry) => entry.key.includes('curve') && entry.key.includes('growth'));
  assert.ok(pair, `expected a curve/growth contradiction, got ${divided.contradictions.map((entry) => entry.key).join(', ')}`);
  assert.match(pair.read, /points apart/);
  assert.equal(divided.mostPositive.key, 'growth');
});

test('a disagreement inside one family is labelled as such', () => {
  const divided = calculateModelConsensus({
    ...strongModels,
    growthNowcast: { status: 'calculated', score: 90, state: 'Accelerating' },
    dataSurprise: { status: 'calculated', score: 15, state: 'Data running below its own trend' },
  });
  const sameFamily = divided.contradictions.find((entry) => entry.sameFamily);
  assert.ok(sameFamily, 'growth and data surprise are both growth readings');
  assert.equal(sameFamily.family, 'growth');
  assert.match(sameFamily.read, /inside one family/);
  assert.equal(divided.sameFamilyContradictions >= 1, true);
});

test('the consensus average never replaces the spread it is averaging over', () => {
  const divided = calculateModelConsensus({
    ...strongModels,
    growthNowcast: { status: 'calculated', score: 95, state: 'Accelerating' },
    dataSurprise: { status: 'calculated', score: 5, state: 'Data running below its own trend' },
  });
  assert.equal(Number.isFinite(divided.averageScore), true);
  assert.equal(divided.spread >= 60, true);
  assert.equal(divided.contradictions.length > 0, true);
  assert.match(divided.methodology, /never instead of them/);
});

test('the consensus refuses with fewer than three published models', () => {
  const consensus = calculateModelConsensus({ liquidity: { status: 'calculated', score: 60 } });
  assert.equal(consensus.status, 'unavailable');
  assert.match(consensus.reason, /three published macro models/);
  assert.deepEqual(consensus.contradictions, []);
});

function outputs(scores, startDay = 0) {
  return scores.map((score, index) => ({
    effective_at: new Date(Date.UTC(2025, 0, 1 + ((index + startDay) * 7))).toISOString().slice(0, 10),
    output: { asOf: new Date(Date.UTC(2025, 0, 1 + ((index + startDay) * 7))).toISOString().slice(0, 10), score },
  }));
}

test('the model correlation matrix finds near-duplicate pairs', () => {
  const base = Array.from({ length: 30 }, (_, index) => 50 + (Math.sin(index / 4) * 20));
  const matrix = calculateModelCorrelationMatrix({
    'us-liquidity': outputs(base),
    'macro-regime': outputs(base.map((value) => value * 0.98 + 1)),
    'usd-strength': outputs(base.map((value) => 100 - value)),
  });
  assert.equal(matrix.status, 'calculated');
  const duplicate = matrix.pairs.find((pair) => pair.key === 'us-liquidity|macro-regime');
  assert.equal(duplicate.correlation > 0.95, true, `correlation was ${duplicate.correlation}`);
  assert.equal(matrix.redundantPairs.includes('us-liquidity|macro-regime'), true);
  const inverse = matrix.pairs.find((pair) => pair.key === 'us-liquidity|usd-strength');
  assert.equal(inverse.correlation < -0.95, true);
});

test('repeated runs over one vintage cannot stack into a correlation', () => {
  const repeated = [
    ...outputs([50, 55, 60, 65, 70, 75, 80, 75, 70, 65, 60, 55, 50, 45]),
    // Fifteen extra runs against the vintage already present.
    ...Array.from({ length: 15 }, () => ({ effective_at: '2025-01-01', output: { asOf: '2025-01-01', score: 50 } })),
  ];
  const matrix = calculateModelCorrelationMatrix({ a: repeated, b: repeated });
  const pair = matrix.pairs[0];
  assert.equal(pair.observations, 14, 'one reading per vintage, not one per run');
});

test('the correlation matrix explains why it is empty without stored history', () => {
  const matrix = calculateModelCorrelationMatrix({});
  assert.equal(matrix.status, 'unavailable');
  assert.match(matrix.reason, /PostgreSQL is configured/);
  assert.deepEqual(matrix.pairs, []);
});

test('a pair whose score never moved is unavailable, not correlated', () => {
  const flat = outputs(Array.from({ length: 20 }, () => 50));
  const matrix = calculateModelCorrelationMatrix({ a: flat, b: outputs(Array.from({ length: 20 }, (_, index) => 40 + index)) });
  assert.equal(matrix.pairs[0].status, 'unavailable');
  assert.match(matrix.pairs[0].reason, /never moved/);
});

test('alerts fire on a fresh un-inversion and rank high severity first', () => {
  const alerts = evaluateMacroAlerts({
    yieldCurve: { status: 'calculated', spreads: [{ key: 'tenTwo', name: '10-year minus 2-year', unInverted: true, sessionsSinceUnInversion: 6, spread: 0.1, trough: { value: -0.9, date: '2025-08-01' } }] },
    liquidityCalendar: { status: 'calculated', quarterEnd: { daysAway: 4 }, monthsOfCushion: 30 },
  });
  assert.equal(alerts.status, 'calculated');
  assert.equal(alerts.entries[0].key, 'curve-uninverted');
  assert.equal(alerts.entries[0].severity, 'high');
  assert.equal(alerts.entries.at(-1).key, 'quarter-end');
  assert.match(alerts.entries[0].text, /nearer signal/);
});

test('a rule whose model did not publish is skipped and listed, not treated as quiet', () => {
  const alerts = evaluateMacroAlerts({ yieldCurve: { status: 'unavailable', reason: 'no yields' } });
  assert.equal(alerts.status, 'quiet');
  assert.equal(alerts.entries.length, 0);
  assert.equal(alerts.skipped.length > 0, true);
  assert.match(alerts.skipped[0].reason, /did not publish/);
  assert.match(alerts.methodology, /different answers/);
});

test('a rule that throws on an unexpected shape is skipped rather than assumed', () => {
  const alerts = evaluateMacroAlerts({ curve: { status: 'calculated' } }, {
    rules: [{ key: 'boom', model: 'curve', severity: 'high', test: () => { throw new Error('bad shape'); }, text: () => 'never' }],
  });
  assert.deepEqual(alerts.entries, []);
  assert.match(alerts.skipped[0].reason, /could not be evaluated/);
});

test('reserve scarcity and a short runway both raise high-severity alerts', () => {
  const alerts = evaluateMacroAlerts({
    reserveScarcity: { status: 'calculated', state: 'Reserves scarce', spreadBasisPoints: 14, daysAboveThreshold: 9, thresholdBasisPoints: 5 },
    liquidityCalendar: { status: 'calculated', quarterEnd: { daysAway: 40 }, monthsOfCushion: 3.2 },
  });
  assert.equal(alerts.counts.high, 2);
  assert.equal(alerts.entries.every((entry) => entry.severity === 'high'), true);
  assert.match(alerts.read, /2 of them high severity/);
});

test('a divided consensus raises its own alert naming the most divergent pair', () => {
  const consensus = calculateModelConsensus({
    ...strongModels,
    growthNowcast: { status: 'calculated', score: 95, state: 'Accelerating' },
    dataSurprise: { status: 'calculated', score: 5, state: 'Data running below its own trend' },
  });
  const alerts = evaluateMacroAlerts({ consensus });
  assert.equal(alerts.entries.some((entry) => entry.key === 'models-divided'), true);
  assert.match(alerts.entries.find((entry) => entry.key === 'models-divided').text, /most divergent pair/);
});

test('percentile-derived signals cannot pin to the axis extremes', () => {
  const extreme = collectMacroSignals({
    ...strongModels,
    termPremium: { status: 'calculated', percentile: 100, driver: 'term premium' },
    reserveScarcity: { status: 'calculated', percentile: 0, state: 'Reserves abundant' },
  });
  const premium = extreme.directional.find((signal) => signal.key === 'termPremium');
  const reserves = extreme.directional.find((signal) => signal.key === 'reserves');
  // Untreated these were 0 and 100, which let two uniformly-distributed
  // readings out-shout every composite on the axis at once.
  assert.equal(premium.score, 20);
  assert.equal(reserves.score, 80);
  assert.equal(premium.score > 0 && reserves.score < 100, true);
});

test('a model standing apart is reported once, not restated against every other', () => {
  const consensus = calculateModelConsensus({
    ...strongModels,
    termPremium: { status: 'calculated', percentile: 100, driver: 'term premium' },
    reserveScarcity: { status: 'calculated', percentile: 100, state: 'Reserves scarce' },
  });
  assert.equal(consensus.signals.find((signal) => signal.key === 'termPremium').score, 20);
  // Two readings far below the rest genuinely do contradict each of them, so
  // the pair list is long by arithmetic. The outlier list is the readable form.
  assert.equal(consensus.contradictions.length > consensus.outliers.length, true);
  assert.deepEqual(consensus.outliers.map((entry) => entry.key).sort(), ['reserves', 'termPremium']);
  consensus.outliers.forEach((entry) => {
    assert.equal(entry.direction, 'more risk-negative');
    assert.match(entry.read, /below the median of the other/);
  });
  assert.match(consensus.read, /stand apart from the rest/);
});

test('no outlier is reported when every model sits together', () => {
  const consensus = calculateModelConsensus(strongModels);
  assert.deepEqual(consensus.outliers, []);
});
