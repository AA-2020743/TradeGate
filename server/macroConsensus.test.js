import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBackfillRows,
  calculateModelConsensus,
  calculateModelCorrelationMatrix,
  calculateWeightOverlap,
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

const scarceModels = {
  reserveScarcity: { status: 'calculated', state: 'Reserves scarce', spreadBasisPoints: 14, daysAboveThreshold: 9, thresholdBasisPoints: 5 },
  liquidityCalendar: { status: 'calculated', quarterEnd: { daysAway: 40 }, monthsOfCushion: 3.2 },
};

test('an alert is news on the transition, not on every evaluation while it holds', () => {
  const first = evaluateMacroAlerts(scarceModels);
  assert.equal(first.entries.length, 2);
  assert.equal(first.raised.length, 2, 'with no prior state every live condition is new');

  // The same conditions, evaluated again. Nothing has changed, so nothing is
  // news — the feed used to gain two more rows here every single run.
  const second = evaluateMacroAlerts(scarceModels, { previous: first });
  assert.equal(second.entries.length, 2, 'both conditions are still live');
  assert.deepEqual(second.raised, [], 'and neither is news');
  assert.deepEqual(second.resolved, []);
});

test('a condition that clears is published as resolved', () => {
  const live = evaluateMacroAlerts(scarceModels);
  const cleared = evaluateMacroAlerts({
    reserveScarcity: { status: 'calculated', state: 'Reserves ample', spreadBasisPoints: 1, daysAboveThreshold: 0, thresholdBasisPoints: 5 },
    liquidityCalendar: { status: 'calculated', quarterEnd: { daysAway: 40 }, monthsOfCushion: 30 },
  }, { previous: live });
  assert.deepEqual(cleared.entries, []);
  assert.equal(cleared.resolved.length, 2);
  assert.equal(cleared.resolved.every((entry) => entry.text.includes('no longer live')), true);
  assert.match(cleared.read, /2 cleared since the last evaluation/);
});

test('a condition whose model stopped publishing is not reported as resolved', () => {
  const live = evaluateMacroAlerts(scarceModels);
  // The model went unavailable. Whether the condition still holds is unknown,
  // and "unknown" must not be published as "it cleared".
  const blind = evaluateMacroAlerts({
    reserveScarcity: { status: 'unavailable', reason: 'SOFR feed down' },
    liquidityCalendar: { status: 'calculated', quarterEnd: { daysAway: 40 }, monthsOfCushion: 3.2 },
  }, { previous: live });
  assert.equal(blind.resolved.some((entry) => entry.key === 'reserves-tightening'), false);
  assert.equal(blind.skipped.some((entry) => entry.key === 'reserves-tightening'), true);
});

test('a condition that could not be evaluated last time is flagged when it fires', () => {
  const blind = evaluateMacroAlerts({ reserveScarcity: { status: 'unavailable', reason: 'down' } });
  const back = evaluateMacroAlerts(scarceModels, { previous: blind });
  const entry = back.entries.find((item) => item.key === 'reserves-tightening');
  assert.equal(entry.isNew, true);
  assert.equal(entry.unknownBefore, true, 'we genuinely cannot say whether it was live before');
});

test('each signal carries the vintage of the model behind it', () => {
  const today = new Date().toISOString().slice(0, 10);
  const sixWeeksAgo = new Date(Date.now() - (42 * 86_400_000)).toISOString().slice(0, 10);
  const { directional } = collectMacroSignals({
    ...strongModels,
    macroRegime: { status: 'calculated', score: 72, regime: 'Expansion / risk-on', asOf: today, vintage: { oldestInput: { key: 'financialConditions', name: 'FRED NFCI', date: sixWeeksAgo } } },
    liquidity: { status: 'calculated', score: 78, regime: 'Expansion', asOf: today },
  });
  const regime = directional.find((signal) => signal.key === 'macroRegime');
  const liquidity = directional.find((signal) => signal.key === 'liquidity');
  // The regime's headline date is today; its oldest binding input is six weeks
  // old, and that is the moment the reading actually describes.
  assert.equal(regime.asOf, sixWeeksAgo);
  assert.equal(regime.ageDays >= 40, true, `age was ${regime.ageDays}`);
  assert.equal(regime.lagging, true);
  assert.equal(liquidity.ageDays <= 1, true);
  assert.equal(liquidity.lagging, false);
});

test('the consensus names its oldest and freshest signal', () => {
  const today = new Date().toISOString().slice(0, 10);
  const stale = new Date(Date.now() - (50 * 86_400_000)).toISOString().slice(0, 10);
  const consensus = calculateModelConsensus({
    ...strongModels,
    growthNowcast: { status: 'calculated', score: 74, state: 'Accelerating', asOf: stale },
    liquidity: { status: 'calculated', score: 78, regime: 'Expansion', asOf: today },
  });
  assert.equal(consensus.vintage.oldest.key, 'growth');
  assert.equal(consensus.vintage.freshest.key, 'liquidity');
  assert.equal(consensus.vintage.spreadDays >= 45, true);
  assert.equal(consensus.vintage.laggingCount >= 1, true);
  assert.match(consensus.read, /more than three weeks old/);
});

test('a model with no date at all is not counted as fresh', () => {
  const { directional } = collectMacroSignals({ liquidity: { status: 'calculated', score: 60 } });
  const signal = directional.find((entry) => entry.key === 'liquidity');
  assert.equal(signal.asOf, null);
  assert.equal(signal.ageDays, null);
  assert.equal(signal.lagging, false);
});

const overlapModel = {
  status: 'calculated',
  version: 'macro-regime-v1',
  score: 60,
  drivers: [
    { key: 'liquidity', name: 'US liquidity impulse', score: 80, weight: 0.25 },
    { key: 'globalLiquidity', name: 'Global liquidity impulse', score: 78, weight: 0.15 },
    { key: 'credit', name: 'High-yield credit', score: 40, weight: 0.18 },
  ],
};
const overlapMatrix = {
  pairs: [
    { status: 'calculated', left: 'us-liquidity', right: 'global-liquidity', correlation: 0.97 },
    { status: 'calculated', left: 'us-liquidity', right: 'credit-model', correlation: 0.2 },
  ],
};
const driverToModelId = { liquidity: 'us-liquidity', globalLiquidity: 'global-liquidity', credit: 'credit-model' };

test('weight overlap finds a driver pair counted twice and reweights without it', () => {
  const overlap = calculateWeightOverlap(overlapModel, overlapMatrix, { driverToModelId });
  assert.equal(overlap.status, 'calculated');
  assert.equal(overlap.pairs.length, 1);
  assert.equal(overlap.pairs[0].redundantDriver, 'globalLiquidity', 'the lighter of the two carries the redundant weight');
  assert.equal(overlap.adjustedScore !== overlap.headlineScore, true);
  assert.match(overlap.methodology, /published beside the headline rather than replacing it/);
});

test('weight overlap calls nothing duplication until it has been measured', () => {
  const withoutMatrix = calculateWeightOverlap(overlapModel, { pairs: [] }, { driverToModelId });
  assert.equal(withoutMatrix.status, 'unavailable');
  assert.match(withoutMatrix.reason, /overlap cannot be distinguished from agreement/);

  const uncorrelated = calculateWeightOverlap(overlapModel, {
    pairs: [{ status: 'calculated', left: 'us-liquidity', right: 'global-liquidity', correlation: 0.4 }],
  }, { driverToModelId });
  assert.equal(uncorrelated.status, 'calculated');
  assert.deepEqual(uncorrelated.pairs, []);
  assert.equal(uncorrelated.adjustedScore, uncorrelated.headlineScore);
});

test('weight overlap refuses a composite that publishes no drivers', () => {
  assert.equal(calculateWeightOverlap({ status: 'calculated', score: 60 }, overlapMatrix).status, 'unavailable');
  assert.equal(calculateWeightOverlap({ status: 'unavailable' }, overlapMatrix).status, 'unavailable');
});

test('backfill rows are produced per date and flagged as backfilled', () => {
  const dates = ['2025-01-06', '2025-01-13', '2025-01-20'];
  const backfill = buildBackfillRows('us-liquidity', (date) => 50 + dates.indexOf(date), dates);
  assert.equal(backfill.rows.length, 3);
  assert.equal(backfill.rows[0].output.backfilled, true);
  assert.equal(backfill.rows[0].output.asOf, '2025-01-06');
  assert.equal(backfill.rows.at(-1).output.score, 52);
  assert.match(backfill.read, /3 backfilled readings/);
});

test('a date the score function cannot answer is dropped, not scored zero', () => {
  const backfill = buildBackfillRows('m', (date) => {
    if (date === '2025-01-13') throw new Error('no history that far back');
    return date === '2025-01-20' ? null : 60;
  }, ['2025-01-06', '2025-01-13', '2025-01-20']);
  assert.equal(backfill.rows.length, 1);
  assert.equal(backfill.rows[0].output.asOf, '2025-01-06');
});

test('backfilled rows feed the overlap matrix like any other stored vintage', () => {
  const dates = Array.from({ length: 20 }, (_, index) => new Date(Date.UTC(2025, 0, 6 + (index * 7))).toISOString().slice(0, 10));
  const left = buildBackfillRows('a', (date) => 50 + (Math.sin(dates.indexOf(date) / 3) * 20), dates);
  const right = buildBackfillRows('b', (date) => 50 - (Math.sin(dates.indexOf(date) / 3) * 20), dates);
  const matrix = calculateModelCorrelationMatrix({
    a: left.rows.map((row) => ({ effective_at: row.asOf, output: row.output })),
    b: right.rows.map((row) => ({ effective_at: row.asOf, output: row.output })),
  });
  assert.equal(matrix.status, 'calculated');
  assert.equal(matrix.pairs[0].correlation < -0.95, true);
});

test('anti-correlated drivers offset rather than duplicate, and the score is left alone', () => {
  const overlap = calculateWeightOverlap({
    status: 'calculated',
    version: 'macro-regime-v1',
    score: 60,
    drivers: [
      { key: 'liquidity', name: 'US liquidity impulse', score: 80, weight: 0.25 },
      { key: 'dollar', name: 'Inverse dollar pressure', score: 20, weight: 0.1 },
    ],
  }, {
    pairs: [{ status: 'calculated', left: 'us-liquidity', right: 'usd-strength', correlation: -1 }],
  }, { driverToModelId: { liquidity: 'us-liquidity', dollar: 'usd-strength' } });

  assert.deepEqual(overlap.pairs, [], 'a mirror-image pair is not the same factor counted twice');
  assert.equal(overlap.offsetting.length, 1);
  assert.equal(overlap.adjustedScore, overlap.headlineScore, 'the score must not be adjusted for an offsetting pair');
  assert.match(overlap.offsetting[0].read, /largely cancel/);
  assert.match(overlap.read, /offsets rather than duplicates/);
});

test('a positive duplicate still adjusts the score even alongside an offsetting pair', () => {
  const overlap = calculateWeightOverlap({
    status: 'calculated',
    version: 'macro-regime-v1',
    score: 60,
    drivers: [
      { key: 'liquidity', name: 'US liquidity impulse', score: 80, weight: 0.25 },
      { key: 'globalLiquidity', name: 'Global liquidity impulse', score: 78, weight: 0.15 },
      { key: 'dollar', name: 'Inverse dollar pressure', score: 20, weight: 0.1 },
    ],
  }, {
    pairs: [
      { status: 'calculated', left: 'us-liquidity', right: 'global-liquidity', correlation: 0.97 },
      { status: 'calculated', left: 'us-liquidity', right: 'usd-strength', correlation: -0.98 },
    ],
  }, { driverToModelId: { liquidity: 'us-liquidity', globalLiquidity: 'global-liquidity', dollar: 'usd-strength' } });

  assert.equal(overlap.pairs.length, 1);
  assert.equal(overlap.pairs[0].redundantDriver, 'globalLiquidity');
  assert.equal(overlap.offsetting.length, 1);
  assert.equal(Number.isFinite(overlap.adjustedScore), true);
});
