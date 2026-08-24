import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAtomFeed, buildCoingeckoRequest, buildSocrataRequest, buildHeatmapRow, buildLiquidityNarrative, buildLiquidityTransmission, buildWorkspaceNarrative, calculateBitcoinCyclePhase, calculateChangeCorrelations, calculateCryptoRotation, calculateDollarScenarios, calculateDollarTransmissionRead, calculateLeadLag, calculateLiquidityRunway, calculatePositioningModel, calculateCrossMarketRelationship, calculateGlobalLiquidityModel, calculateHeatmapRisk, calculateMacroRegimeModel, calculateMacroRegimeProximity, classifyMacroRegimeByScore, calculateMetalsCostStructure, calculateOpenInterestQuadrant, calculateRsi, calculateScreenerScores, calculateSeriesLeadLag, calculateTechnicalSnapshot, calculateTrendQuality, classifyHeadlineSentiment, calculateUsdStrengthModel, calculateUsLiquidityModel, calculateLiquidityCyclePosition, escapeXml, isPublished, measureChangeOverDays, pearsonCorrelation } from './analytics.js';

test('RSI reaches 100 for an uninterrupted advance', () => {
  const values = Array.from({ length: 30 }, (_, index) => 100 + index);
  assert.equal(calculateRsi(values), 100);
});

test('RSI is neutral for a flat series', () => {
  assert.equal(calculateRsi(Array(30).fill(100)), 50);
});

test('Pearson correlation identifies direct and inverse relationships', () => {
  assert.equal(pearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8]), 1);
  assert.equal(pearsonCorrelation([1, 2, 3, 4], [8, 6, 4, 2]), -1);
});

test('Technical snapshot derives a constructive regime from persistent strength', () => {
  const points = Array.from({ length: 260 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    value: 100 + (index * 0.4) + Math.sin(index / 5),
  }));
  const snapshot = calculateTechnicalSnapshot(points);
  assert.equal(snapshot.version, 'technical-v1');
  assert.equal(snapshot.regime, 'Constructive');
  assert.ok(snapshot.score >= 65);
  assert.ok(snapshot.indicators.sma200 < snapshot.latest);
  assert.ok(Math.abs(snapshot.indicators.pctFrom52wHigh) < 1);

  const drawnPoints = points.map((point, index) => ({ ...point, value: index > 250 ? point.value * 0.9 : point.value }));
  const drawn = calculateTechnicalSnapshot(drawnPoints);
  assert.ok(drawn.indicators.pctFrom52wHigh <= -5);
});

test('Cross-market relationship calculates inverse return correlation', () => {
  let leftValue = 100;
  let rightValue = 200;
  const left = [];
  const right = [];
  for (let index = 0; index < 90; index += 1) {
    const returnValue = 0.004 + (Math.sin(index / 4) * 0.003);
    leftValue *= Math.exp(returnValue);
    rightValue *= Math.exp(-returnValue);
    left.push({ date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10), value: leftValue });
    right.push({ timestamp: new Date(Date.UTC(2025, 0, index + 1)).toISOString(), value: rightValue });
  }
  const relationship = calculateCrossMarketRelationship(left, right);
  assert.equal(relationship.version, 'cross-market-correlation-v1');
  assert.equal(relationship.regime, 'Inverse');
  assert.ok(relationship.correlations['60D'] < -0.9);
  assert.equal(relationship.divergence, 'Inverse relationship aligned');
});

test('US liquidity model detects an expanding impulse', () => {
  const weekly = (key, start, step, multiplier = 1) => ({
    key,
    multiplier,
    history: Array.from({ length: 30 }, (_, index) => ({
      date: new Date(Date.UTC(2025, 0, 1 + (index * 7))).toISOString().slice(0, 10),
      value: start + (index * step),
    })),
  });
  const model = calculateUsLiquidityModel([
    weekly('fedBalanceSheet', 7_000_000, 20_000),
    weekly('treasuryGeneralAccount', 800_000, -5_000),
    weekly('reverseRepo', 500, -8, 1000),
    weekly('usM2', 21_000, 50, 1000),
    weekly('dxy', 110, -0.15),
  ]);
  assert.equal(model.version, 'us-liquidity-v1');
  assert.equal(model.regime, 'Expansion');
  assert.ok(model.score > 50);
  assert.equal(model.breadth.positive, 3);
  assert.equal(model.history.length, 30);
  const quarter = model.decomposition.find((window) => window.windowDays === 91);
  assert.ok(quarter);
  assert.equal(quarter.dominantLeg, 'fedBalanceSheet');
  assert.equal(quarter.legs.find((leg) => leg.key === 'fedBalanceSheet').contribution, 260_000);
  assert.equal(quarter.legs.find((leg) => leg.key === 'treasuryGeneralAccount').contribution, 65_000);
  assert.equal(quarter.legs.find((leg) => leg.key === 'reverseRepo').contribution, 104_000);
  assert.equal(quarter.netChange, 429_000);
});

test('US liquidity model refuses to publish with a missing mandatory driver', () => {
  const history = Array.from({ length: 30 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, 1 + (index * 7))).toISOString().slice(0, 10),
    value: 100 + index,
  }));
  const model = calculateUsLiquidityModel([
    { key: 'usM2', multiplier: 1, history },
    { key: 'dxy', multiplier: 1, history },
  ]);
  assert.equal(model.status, 'unavailable');
  assert.equal(model.score, null);
  // The reason has to name the driver: an unexplained blank panel is the thing
  // a reader cannot act on.
  assert.match(model.reason, /Fed net liquidity/);
  assert.deepEqual(model.missing, ['Fed net liquidity']);
});

test('Global liquidity model aggregates USD-converted central-bank legs', () => {
  const weekly = (key, start, step) => ({
    key,
    multiplier: 1,
    history: Array.from({ length: 120 }, (_, index) => ({
      date: new Date(Date.UTC(2024, 0, 1 + (index * 7))).toISOString().slice(0, 10),
      value: start + (index * step),
    })),
  });
  const model = calculateGlobalLiquidityModel([
    weekly('fedBalanceSheet', 7_000_000, 20_000),
    weekly('treasuryGeneralAccount', 800_000, -5_000),
    { ...weekly('reverseRepo', 2_000, -15), multiplier: 1000 },
    { ...weekly('usM2', 20_000, 30), multiplier: 1000 },
    weekly('ecbBalanceSheet', 6_200_000, 15_000),
    weekly('bojBalanceSheet', 7_500_000, 8_000),
    weekly('pbocBalanceSheet', 45_000, 50),
    weekly('eurUsd', 1.08, 0.002),
    weekly('yenPerUsd', 150, -0.2),
    weekly('yuanPerUsd', 7.2, -0.01),
    weekly('dxy', 110, -0.15),
  ]);
  assert.equal(model.version, 'global-liquidity-v1');
  assert.equal(model.regime, 'Expansion');
  assert.ok(model.score > 50);
  assert.equal(model.centralBanks.length, 4);
  const usLeg = model.centralBanks.find((leg) => leg.key === 'us');
  const ecbLeg = model.centralBanks.find((leg) => leg.key === 'ecb');
  const bojLeg = model.centralBanks.find((leg) => leg.key === 'boj');
  const pbocLeg = model.centralBanks.find((leg) => leg.key === 'pboc');
  const expectedNetUs = (7_000_000 + (119 * 20_000)) - (800_000 - (119 * 5_000)) - ((2_000 - (119 * 15)) * 1000);
  assert.ok(Math.abs(usLeg.valueUsdMillions - expectedNetUs) < 1_000);
  assert.ok(Math.abs(ecbLeg.valueUsdMillions - ((6_200_000 + (119 * 15_000)) * (1.08 + (119 * 0.002)))) < 1_000);
  assert.ok(Math.abs(bojLeg.valueUsdMillions - (((7_500_000 + (119 * 8_000)) * 100) / (150 - (119 * 0.2)))) < 1_000);
  assert.ok(Math.abs(pbocLeg.valueUsdMillions - (((45_000 + (119 * 50)) * 1000) / (7.2 - (119 * 0.01)))) < 1_000);
  assert.match(pbocLeg.source, /BIS/);
  assert.ok(model.drivers.some((driver) => driver.key === 'usM2'));
  assert.ok(model.drivers.some((driver) => driver.key === 'pbocCentralBank'));
  const shareTotal = model.centralBanks.reduce((total, leg) => total + leg.sharePercent, 0);
  assert.ok(Math.abs(shareTotal - 100) <= 1);
  assert.equal(model.history.length, 120);
  // The old cyclePercentile field is gone: it ranked a trending level against
  // its entire history, which is a ratchet rather than a gauge.
  assert.equal('cyclePercentile' in model, false);
  assert.ok(Number.isFinite(model.cycle.levelPercentile));
});

test('Global liquidity model refuses to publish without FX conversion rates', () => {
  const weekly = (key, start, step = 0) => ({
    key,
    multiplier: 1,
    history: Array.from({ length: 30 }, (_, index) => ({
      date: new Date(Date.UTC(2025, 0, 1 + (index * 7))).toISOString().slice(0, 10),
      value: start + (index * step),
    })),
  });
  const model = calculateGlobalLiquidityModel([
    weekly('fedBalanceSheet', 7_000_000, 20_000),
    weekly('treasuryGeneralAccount', 800_000, -5_000),
    { ...weekly('reverseRepo', 2_000, -15), multiplier: 1000 },
    { ...weekly('usM2', 20_000, 30), multiplier: 1000 },
    weekly('ecbBalanceSheet', 6_200_000, 15_000),
    weekly('bojBalanceSheet', 750_000, 2_000),
    weekly('dxy', 110, -0.15),
  ]);
  assert.equal(model.status, 'unavailable');
  assert.equal(model.score, null);
  assert.match(model.reason, /ECB balance sheet converted at EURUSD/);
  assert.equal(model.missing.length, 2, 'both the ECB and BoJ legs are missing their conversion rate');
});

test('USD strength combines the broad dollar with connected macro drivers', () => {
  const daily = (key, start, step) => ({
    key,
    multiplier: 1,
    history: Array.from({ length: 300 }, (_, index) => ({
      date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
      value: start + (index * step),
    })),
  });
  const model = calculateUsdStrengthModel([
    daily('dxy', 100, 0.04),
    daily('realYield10y', 1.5, 0.003),
    daily('us2yYield', 4, 0.002),
    daily('financialConditions', -0.4, 0.0005),
    daily('vix', 16, 0),
  ], { score: 45, composite: -0.1, version: 'liquidity-test' });
  assert.equal(model.version, 'usd-strength-v1');
  assert.equal(model.status, 'calculated');
  // The rate-differential leg carries 5% of the weight and has no input here,
  // so full coverage now requires it.
  assert.equal(model.coverage, 95);
  assert.ok(model.score > 50);
  assert.equal(model.history.length, 300);
  assert.match(model.proxy, /not the ICE DXY/);

  const withRates = calculateUsdStrengthModel([
    daily('dxy', 100, 0.04),
    daily('realYield10y', 1.5, 0.003),
    daily('us2yYield', 4, 0.002),
    daily('financialConditions', -0.4, 0.0005),
    daily('vix', 16, 0),
  ], { score: 45, composite: -0.1, version: 'liquidity-test' }, {
    rateDivergence: { status: 'calculated', version: 'rate-divergence-v1', score: 80, averageSpreadPercent: 1.9, averageChangeBasisPoints: 20 },
  });
  assert.equal(withRates.coverage, 100);
  assert.equal(withRates.drivers.find((driver) => driver.key === 'rateDifferential').score, 80);
  assert.ok(withRates.score >= model.score, 'a widening US yield advantage cannot weaken the dollar read');
});

test('an unavailable rate divergence drops out rather than scoring neutral', () => {
  const daily = (key, start, step) => ({
    key,
    multiplier: 1,
    history: Array.from({ length: 300 }, (_, index) => ({
      date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
      value: start + (index * step),
    })),
  });
  const model = calculateUsdStrengthModel([
    daily('dxy', 100, 0.04),
    daily('realYield10y', 1.5, 0.003),
    daily('us2yYield', 4, 0.002),
    daily('financialConditions', -0.4, 0.0005),
    daily('vix', 16, 0),
  ], { score: 45, composite: -0.1, version: 'liquidity-test' }, {
    rateDivergence: { status: 'unavailable', reason: 'no foreign leg', score: null },
  });
  assert.equal(model.coverage, 95);
  assert.equal(model.drivers.find((driver) => driver.key === 'rateDifferential').score, null);
  assert.equal(model.missing.includes('US yield advantage over DM peers'), true);
});

test('USD strength is explicitly provisional when only dollar price is available', () => {
  const series = {
    key: 'dxy',
    multiplier: 1,
    history: Array.from({ length: 260 }, (_, index) => ({
      date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
      value: 100 + (index * 0.02),
    })),
  };
  const model = calculateUsdStrengthModel([series]);
  assert.equal(model.status, 'provisional');
  assert.equal(model.coverage, 45);
  assert.equal(model.dollarSmile, null);
  assert.ok(model.missing.includes('10Y real-yield impulse'));
});

test('USD dollar-smile state stays unavailable with one-sided benign inputs', () => {
  const daily = (key, start, step = 0) => ({
    key,
    multiplier: 1,
    history: Array.from({ length: 260 }, (_, index) => ({
      date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
      value: start + (index * step),
    })),
  });
  const lowVixOnly = calculateUsdStrengthModel([daily('dxy', 100, 0.02), daily('vix', 15)]);
  const realYieldOnly = calculateUsdStrengthModel([daily('dxy', 100, 0.02), daily('realYield10y', 1.5, 0.002)]);
  const highVix = calculateUsdStrengthModel([daily('dxy', 100, 0.02), daily('vix', 30)]);
  assert.equal(lowVixOnly.dollarSmile, null);
  assert.equal(realYieldOnly.dollarSmile, null);
  assert.equal(highVix.dollarSmile, 'Global stress support');
});

test('macro regime uses independent liquidity, conditions, credit, volatility, and dollar sleeves', () => {
  const history = (key, value) => ({
    key,
    multiplier: 1,
    history: Array.from({ length: 120 }, (_, index) => ({
      date: new Date(Date.UTC(2025, 0, 1 + (index * 3))).toISOString().slice(0, 10),
      value,
    })),
  });
  const model = calculateMacroRegimeModel([
    history('financialConditions', -0.5),
    history('highYieldSpread', 3),
    history('vix', 15),
  ], { score: 75, composite: 0.3, version: 'liquidity-test', asOf: '2026-01-01' }, { score: 40, version: 'usd-test', asOf: '2026-01-01', indicators: { momentum20d: -1 } });
  assert.equal(model.version, 'macro-regime-v1');
  assert.equal(model.status, 'calculated');
  assert.equal(model.coverage, 85);
  assert.equal(model.regime, 'Expansion / risk-on');
  assert.equal(model.settings.riskBudget, 'High');
  assert.equal(model.panicConfirmed, false);
});

test('macro regime refuses a single-sleeve classification', () => {
  const model = calculateMacroRegimeModel([], { score: 70, version: 'liquidity-test' });
  assert.equal(model.status, 'unavailable');
  assert.equal(model.regime, null);
  assert.equal(model.panicConfirmed, null);
});

test('macro regime leaves panic confirmation unavailable without stress inputs', () => {
  const model = calculateMacroRegimeModel([], { score: 70, version: 'liquidity-test' }, { score: 45, version: 'usd-test', indicators: {} }, { score: 60, version: 'global-test' });
  assert.equal(model.status, 'provisional');
  assert.equal(model.panicConfirmed, null);
});

test('macro regime folds in the global liquidity sleeve', () => {
  const model = calculateMacroRegimeModel(
    [],
    { score: 70, version: 'liquidity-test' },
    { score: 45, version: 'usd-test', indicators: {} },
    { score: 80, composite: 0.2, version: 'global-liquidity-v1' },
  );
  const globalDriver = model.drivers.find((driver) => driver.key === 'globalLiquidity');
  assert.ok(globalDriver);
  assert.equal(globalDriver.score, 80);
  assert.equal(globalDriver.weight, 0.15);
  assert.equal(model.coverage, 50);
});
test('Change correlations identify aligned and inverse series', () => {
  const daily = (base, scale) => Array.from({ length: 80 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
    value: base + (scale * (index + Math.sin(index / 3))),
  }));
  const direct = calculateChangeCorrelations(daily(100, 1), daily(50, 2));
  assert.ok(Math.abs(direct.correlations['20D'] - 1) < 1e-9);
  assert.ok(Math.abs(direct.correlations['60D'] - 1) < 1e-9);
  assert.equal(direct.observations, 79);
  const inverse = calculateChangeCorrelations(daily(100, 1), daily(90, -0.5));
  assert.ok(Math.abs(inverse.correlations['20D'] + 1) < 1e-9);
});

test('Change correlations refuse short or misaligned histories', () => {
  const points = (count) => Array.from({ length: count }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
    value: 100 + index,
  }));
  assert.equal(calculateChangeCorrelations(points(30), points(10)), null);
  assert.equal(calculateChangeCorrelations(points(15), points(15)), null);
});

test('Liquidity narrative reports score and regime changes between runs', () => {
  const narrative = buildLiquidityNarrative(
    [
      { output: { score: 72, regime: 'Expansion' } },
      { output: { score: 64, regime: 'Neutral' } },
    ],
    [
      { output: { score: 58, regime: 'Expansion', globalLiquidityUsdMillions: 25_500_000 } },
      { output: { score: 55, regime: 'Expansion', globalLiquidityUsdMillions: 25_480_000 } },
    ],
  );
  assert.equal(narrative.status, 'updated');
  assert.ok(narrative.entries.some((entry) => entry.key === 'usScore'));
  assert.ok(narrative.entries.some((entry) => entry.key === 'usRegime'));
  assert.ok(narrative.entries.some((entry) => entry.key === 'globalScore'));

  const stable = buildLiquidityNarrative(
    [{ output: { score: 70, regime: 'Expansion' } }, { output: { score: 70, regime: 'Expansion' } }],
    [],
  );
  assert.equal(stable.status, 'stable');
  assert.equal(buildLiquidityNarrative([{ output: { score: 70 } }], []).status, 'insufficient-history');
});

test('Workspace narrative detects vitals changes across persisted runs', () => {
  const narrative = buildWorkspaceNarrative({
    'sentiment-snapshot': [
      { output: { fearGreed: { score: 61.2, rating: 'greed' } } },
      { output: { fearGreed: { score: 52.5, rating: 'neutral' } } },
    ],
    'equity-risk': [
      { output: { spxBreadth: { pctAbove200: 70 }, creditStress: { level: 2.9 } } },
      { output: { spxBreadth: { pctAbove200: 66 }, creditStress: { level: 2.85 } } },
    ],
    'bitcoin-cycle': [
      { output: { valuation: { mvrvZ: 0.41 }, leverage: { annualizedPercent: 5.93 } } },
      { output: { valuation: { mvrvZ: 0.4 }, leverage: { annualizedPercent: 6.1 } } },
    ],
  });
  assert.equal(narrative.status, 'updated');
  assert.ok(narrative.entries.some((entry) => entry.key === 'sentiment-snapshot:fearGreedRating'));
  assert.ok(narrative.entries.some((entry) => entry.key === 'sentiment-snapshot:fearGreedScore'));
  assert.ok(narrative.entries.some((entry) => entry.key === 'equity-risk:pctAbove200'));
  assert.ok(!narrative.entries.some((entry) => entry.key === 'equity-risk:hyOas'));
  assert.ok(!narrative.entries.some((entry) => entry.key === 'bitcoin-cycle:mvrvZ'));

  const stable = buildWorkspaceNarrative({
    'fx-workspace': [
      { output: { usdCot: { percentile: 99 } } },
      { output: { usdCot: { percentile: 99 } } },
    ],
  });
  assert.equal(stable.status, 'stable');
  assert.equal(buildWorkspaceNarrative({ 'metals-workspace': [{ output: {} }] }).status, 'insufficient-history');
});

test('Liquidity states vitals raise alerts on regime and stablecoin transitions', () => {
  const narrative = buildWorkspaceNarrative({
    'liquidity-states': [
      { output: { usRegime: 'Expansion', globalRegime: 'Contraction', globalMomentum: 'Accelerating', stablecoinState: 'Expanding', stablecoinChange30dPct: 0.62, dominantLeg: 'fedBalanceSheet', netChange13wUsdBillions: 120 } },
      { output: { usRegime: 'Neutral', globalRegime: 'Contraction', globalMomentum: 'Decelerating', stablecoinState: 'Flat', stablecoinChange30dPct: 0.31, dominantLeg: 'treasuryGeneralAccount', netChange13wUsdBillions: -140 } },
    ],
  });
  assert.equal(narrative.status, 'updated');
  assert.ok(narrative.entries.some((entry) => entry.key === 'liquidity-states:usRegime' && entry.text.includes('Neutral') && entry.text.includes('Expansion')));
  assert.ok(narrative.entries.some((entry) => entry.key === 'liquidity-states:globalMomentum'));
  assert.ok(narrative.entries.some((entry) => entry.key === 'liquidity-states:stablecoinState'));
  assert.ok(narrative.entries.some((entry) => entry.key === 'liquidity-states:stablecoinChange30d'));
  assert.ok(narrative.entries.some((entry) => entry.key === 'liquidity-states:dominantLeg'));
  assert.ok(narrative.entries.some((entry) => entry.key === 'liquidity-states:netChange13w'));
  assert.ok(!narrative.entries.some((entry) => entry.key === 'liquidity-states:globalRegime'));

  const unchanged = buildWorkspaceNarrative({
    'liquidity-states': [
      { output: { usRegime: 'Expansion', stablecoinChange30dPct: 0.62 } },
      { output: { usRegime: 'Expansion', stablecoinChange30dPct: 0.58 } },
    ],
  });
  assert.equal(unchanged.status, 'stable');
});

test('Dollar transmission vitals raise alerts on backdrop flips', () => {
  const narrative = buildWorkspaceNarrative({
    'dollar-transmission': [
      { output: { tailwindLabel: 'Dollar headwind', tailwindScore: -2, corr60: -0.52, linkRegime: 'Inverse' } },
      { output: { tailwindLabel: 'Dollar tailwind', tailwindScore: 1, corr60: -0.31, linkRegime: 'Inverse' } },
    ],
  });
  assert.equal(narrative.status, 'updated');
  assert.ok(narrative.entries.some((entry) => entry.key === 'dollar-transmission:tailwindLabel' && entry.text.includes('headwind') && entry.text.includes('tailwind')));
  assert.ok(narrative.entries.some((entry) => entry.key === 'dollar-transmission:corr60'));

  const unchanged = buildWorkspaceNarrative({
    'dollar-transmission': [
      { output: { tailwindLabel: 'Neutral dollar', tailwindScore: 0, corr60: -0.4 } },
      { output: { tailwindLabel: 'Neutral dollar', tailwindScore: 0, corr60: -0.38 } },
    ],
  });
  assert.equal(unchanged.status, 'stable');
});

test('Liquidity transmission detects a two-week lead into an asset', () => {
  const weeks = 110;
  const pattern = (index) => Math.sin(index / 3) * 4;
  const weekDate = (index) => new Date(Date.UTC(2024, 0, 4 + (index * 7))).toISOString().slice(0, 10);
  let liquidityLevel = 1000;
  let assetLevel = 100;
  const liquidityPoints = [];
  const assetPoints = [];
  for (let index = 0; index < weeks; index += 1) {
    liquidityPoints.push({ date: weekDate(index), value: liquidityLevel });
    assetPoints.push({ timestamp: weekDate(index), value: assetLevel });
    liquidityLevel *= 1 + pattern(index) / 100;
    assetLevel *= 1 + pattern(index - 2) / 100;
  }
  const transmission = buildLiquidityTransmission(liquidityPoints, assetPoints, 'Test asset');
  assert.equal(transmission.status, 'calculated');
  assert.equal(transmission.bestLagWeeks, 2);
  assert.ok(transmission.corrAtBest > 0.5);
  assert.ok(transmission.read.includes('Liquidity leads'));
});

test('Atom feed builder escapes content and produces valid structure', () => {
  assert.equal(escapeXml('A & B <tag> "quoted" \'single\''), 'A &amp; B &lt;tag&gt; &quot;quoted&quot; &apos;single&apos;');
  const xml = buildAtomFeed(
    { title: 'TradeGate alerts & wire', id: 'urn:tradegate:feed:alerts', updated: '2026-08-21T00:00:00Z', link: '/api/alerts/feed' },
    [{ title: 'Regime <shift>', id: 'urn:tradegate:alert:1', updated: '2026-08-20T12:00:00Z', content: 'US net-liquidity regime rose 2 to Expansion.' }],
  );
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>'));
  assert.ok(xml.includes('<feed xmlns="http://www.w3.org/2005/Atom">'));
  assert.ok(xml.includes('<title>TradeGate alerts &amp; wire</title>'));
  assert.ok(xml.includes('<title>Regime &lt;shift&gt;</title>'));
  assert.ok(xml.includes('<content type="text">US net-liquidity regime rose 2 to Expansion.</content>'));
});
test('COT positioning ranks net speculative exposure', () => {
  const history = Array.from({ length: 60 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, 1 + (index * 7))).toISOString().slice(0, 10),
    netNoncomm: index < 59 ? index * 1000 : 59000,
    openInterest: 1_000_000,
  }));
  const model = calculatePositioningModel([
    { key: 'sp500', name: 'E-mini S&P 500', history },
    { key: 'gold', name: 'COMEX Gold', history: [] },
  ]);
  assert.equal(model.version, 'positioning-cot-v1');
  assert.equal(model.status, 'calculated');
  const sp = model.contracts.find((contract) => contract.key === 'sp500');
  assert.equal(sp.percentile, 100);
  assert.equal(sp.crowd, 'Crowded long');
  assert.equal(sp.stance, 'Leveraged funds net long');
  assert.equal(sp.weeklyChange, 1000);
  assert.equal(model.coverage, 50);
});
test('heatmap rows derive labels from technical and positioning inputs', () => {
  const technical = {
    asOf: '2026-08-20',
    score: 68,
    latest: 110,
    indicators: { sma50: 105, sma200: 100, momentum20d: 3.2, annualizedVolatility20d: 12.4 },
  };
  const row = buildHeatmapRow({ symbol: 'SPY', name: 'S&P 500', group: 'US indices', technical, alignment: 0.72, crowdingPercentile: 93 });
  assert.equal(row.status, 'calculated');
  assert.equal(row.regime, 'Risk-on');
  assert.equal(row.trend, 'Uptrend');
  assert.equal(row.volatility, 'Low');
  assert.equal(row.alignment, 'High');
  assert.equal(row.crowding, 'Crowded');
  const missing = buildHeatmapRow({ symbol: 'X', name: 'X', group: 'G', technical: null, alignment: null, crowdingPercentile: null });
  assert.equal(missing.status, 'unavailable');
});

test('lead-lag recovers known shifts between return series', () => {
  const base = Array.from({ length: 140 }, (_, i) => Math.sin(i / 4.7) + 0.6 * Math.sin(i / 1.9));
  const x = base.slice(0, 120);
  const yFollows = x.map((_, i) => (i >= 2 ? base[i - 2] : NaN));
  const yLeads = base.slice(0, 120).map((_, i) => base[i + 2]);
  const following = calculateLeadLag(x, yFollows);
  assert.equal(following.bestLag, 2);
  assert.equal(following.corrAtBest, 1);
  assert.equal(following.synchronousCorr === null || typeof following.synchronousCorr === 'number', true);
  const leading = calculateLeadLag(x, yLeads);
  assert.equal(leading.bestLag, -2);
  assert.equal(leading.curve.length, 9);
});

test('screener scores weight momentum, trend, and inverse volatility', () => {
  const rows = calculateScreenerScores([
    { symbol: 'AAA', mom20: 10, vsSma200: 5, vol20: 10 },
    { symbol: 'BBB', mom20: 0, vsSma200: 0, vol20: 30 },
    { symbol: 'CCC', mom20: 4, vsSma200: null, vol20: 12 },
  ]);
  assert.equal(rows[0].score, 93);
  assert.equal(rows[1].score, 32);
  assert.equal(rows[2].score, null);
});

test('headline sentiment classifies by transparent keyword lexicon', () => {
  assert.equal(classifyHeadlineSentiment('Stocks surge as rate cut hopes rise').tone, 'positive');
  assert.equal(classifyHeadlineSentiment('Markets plunge amid recession fears').tone, 'negative');
  assert.equal(classifyHeadlineSentiment('Fed publishes minutes from June meeting').tone, 'neutral');
  assert.equal(classifyHeadlineSentiment('').tone, 'neutral');
});

test('trend quality annualizes a clean exponential advance with a perfect fit', () => {
  const closes = Array.from({ length: 120 }, (_, index) => 100 * Math.exp(0.001 * index));
  const trend = calculateTrendQuality(closes);
  assert.equal(trend.observations, 90);
  assert.equal(trend.r2, 1);
  assert.equal(trend.annualizedSlopePct, 28.7);
  assert.equal(trend.quality, 28.7);
});

test('trend quality discounts an equally steep but erratic advance', () => {
  const clean = Array.from({ length: 90 }, (_, index) => 100 * Math.exp(0.001 * index));
  const noisy = clean.map((value, index) => value * (index % 2 === 0 ? 1.06 : 0.94));
  const cleanTrend = calculateTrendQuality(clean);
  const noisyTrend = calculateTrendQuality(noisy);
  assert.ok(noisyTrend.r2 < 0.6);
  assert.ok(noisyTrend.quality < cleanTrend.quality);
});

test('trend quality is negative for a persistent decline and floored at -100%', () => {
  const trend = calculateTrendQuality(Array.from({ length: 90 }, (_, index) => 100 * Math.exp(-0.05 * index)));
  assert.equal(trend.annualizedSlopePct, -100);
  assert.equal(trend.quality, -100);
});

test('trend quality withholds a reading without a full window of positive closes', () => {
  assert.equal(calculateTrendQuality(Array.from({ length: 89 }, () => 100)), null);
  assert.equal(calculateTrendQuality(Array.from({ length: 90 }, (_, index) => (index === 3 ? 0 : 100))), null);
  assert.equal(calculateTrendQuality(null), null);
});

test('flat closes produce a zero slope and no quality edge', () => {
  const trend = calculateTrendQuality(Array(90).fill(100));
  assert.equal(trend.annualizedSlopePct, 0);
  assert.equal(trend.r2, 0);
  assert.equal(trend.quality, 0);
});

test('screener scores rank trend quality cross-sectionally without moving the composite', () => {
  const rows = calculateScreenerScores([
    { symbol: 'AAA', mom20: 10, vsSma200: 5, vol20: 10, trendQuality: 40, trendR2: 0.9 },
    { symbol: 'BBB', mom20: 0, vsSma200: 0, vol20: 30, trendQuality: -12, trendR2: 0.4 },
    { symbol: 'CCC', mom20: 4, vsSma200: 2, vol20: 12, trendQuality: null, trendR2: null },
  ]);
  assert.equal(rows[0].qualityRank, 100);
  assert.equal(rows[1].qualityRank, 50);
  assert.equal(rows[2].qualityRank, null);
  assert.equal(rows[0].score, 93);
});

function dailyDates(count, start = Date.UTC(2025, 0, 1), stepDays = 1) {
  return Array.from({ length: count }, (_, index) => new Date(start + (index * stepDays * 86_400_000)).toISOString().slice(0, 10));
}

test('lead-lag ranked by magnitude finds an inverse link a signed scan would miss', () => {
  // Y mirrors X three bars later, so the real relationship is strongly negative.
  const driver = Array.from({ length: 200 }, (_, index) => Math.sin(index / 3) + Math.cos(index / 11));
  const follower = driver.map((_, index) => (index >= 3 ? -driver[index - 3] : 0));
  const signed = calculateLeadLag(driver, follower, 10, 40);
  const magnitude = calculateLeadLag(driver, follower, 10, 40, { rankBy: 'magnitude' });
  assert.equal(magnitude.bestLag, 3);
  assert.ok(magnitude.corrAtBest < -0.9);
  assert.ok(Math.abs(signed.corrAtBest) < Math.abs(magnitude.corrAtBest));
});

test('a series that moves first is reported as the leader, in bars and in days', () => {
  const driver = Array.from({ length: 200 }, (_, index) => Math.sin(index / 4) + Math.sin(index / 9));
  const follower = driver.map((_, index) => (index >= 2 ? driver[index - 2] : 0));
  const result = calculateSeriesLeadLag(driver, follower, dailyDates(201));
  assert.equal(result.leads, 'left');
  assert.equal(result.leadBars, 2);
  assert.equal(result.leadDays, 2);
  assert.equal(result.barDays, 1);
  assert.ok(result.edge >= 0.05);
});

test('the follower side is named when the right series moves first', () => {
  const driver = Array.from({ length: 200 }, (_, index) => Math.sin(index / 4) + Math.sin(index / 9));
  const result = calculateSeriesLeadLag(driver.map((_, index) => (index >= 3 ? driver[index - 3] : 0)), driver, dailyDates(201));
  assert.equal(result.leads, 'right');
  assert.equal(result.leadBars, 3);
});

test('a weekly cadence reports its lead in weeks of calendar days, not sessions', () => {
  const driver = Array.from({ length: 120 }, (_, index) => Math.sin(index / 4) + Math.sin(index / 9));
  const follower = driver.map((_, index) => (index >= 2 ? driver[index - 2] : 0));
  const result = calculateSeriesLeadLag(driver, follower, dailyDates(121, Date.UTC(2024, 0, 1), 7));
  assert.equal(result.leads, 'left');
  assert.equal(result.leadBars, 2);
  assert.equal(result.barDays, 7);
  assert.equal(result.leadDays, 14);
});

test('a synchronous pair claims no leader', () => {
  const driver = Array.from({ length: 200 }, (_, index) => Math.sin(index / 5));
  const result = calculateSeriesLeadLag(driver, driver.map((value) => value * 2), dailyDates(201));
  assert.equal(result.leads, 'none');
  assert.equal(result.leadBars, 0);
  assert.equal(result.leadDays, 0);
  assert.equal(result.bestLagBars, 0);
});

test('a lag that barely beats the synchronous reading is not called a lead', () => {
  const noise = Array.from({ length: 200 }, (_, index) => Math.sin(index / 7) + (Math.sin(index * 12.9898) * 43_758.5453 % 1));
  const result = calculateSeriesLeadLag(noise, [...noise].reverse(), dailyDates(201));
  assert.ok(result.edge < 0.05 ? result.leads === 'none' : result.leadBars > 0);
});

test('lead-lag withholds a reading when the aligned history is too short', () => {
  const short = Array.from({ length: 30 }, (_, index) => index % 5);
  assert.equal(calculateSeriesLeadLag(short, short, dailyDates(31)), null);
});

test('change correlations publish a lead-lag block alongside the windows', () => {
  const dates = dailyDates(200);
  const leftPoints = dates.map((date, index) => ({ date, value: 100 + Math.sin(index / 4) * 10 }));
  const rightPoints = dates.map((date, index) => ({ date, value: 100 + Math.sin((index - 2) / 4) * 10 }));
  const result = calculateChangeCorrelations(leftPoints, rightPoints);
  assert.equal(result.leadLag.leads, 'left');
  assert.equal(result.leadLag.leadBars, 2);
  assert.equal(typeof result.correlations['60D'], 'number');
});

test('the cross-market model reports which side moves first', () => {
  const dates = dailyDates(200);
  // Bitcoin mirrors the dollar four sessions later, so the dollar leads.
  const dollar = dates.map((_, index) => 100 + Math.sin(index / 5) * 4 + Math.cos(index / 13) * 2);
  const bitcoin = dates.map((_, index) => 60_000 * (1 + (index >= 4 ? -(dollar[index - 4] - 100) / 100 : 0)));
  const model = calculateCrossMarketRelationship(
    dates.map((date, index) => ({ date, value: dollar[index] })),
    dates.map((date, index) => ({ date, value: bitcoin[index] })),
  );
  assert.equal(model.leadLag.leads, 'left');
  assert.equal(model.leadLag.leadBars, 4);
  assert.ok(model.leadLag.corrAtBest < 0);
});

test('a cross-market pair moving in lockstep claims no leader', () => {
  const dates = dailyDates(200);
  const left = dates.map((_, index) => 100 + Math.sin(index / 6) * 5);
  const model = calculateCrossMarketRelationship(
    dates.map((date, index) => ({ date, value: left[index] })),
    dates.map((date, index) => ({ date, value: left[index] * 300 })),
  );
  assert.equal(model.leadLag.leads, 'none');
});

function fredSeries(key, latest, ninetyOneDaysAgo = latest) {
  const day = (offset) => new Date(Date.UTC(2026, 6, 1) - (offset * 86_400_000)).toISOString().slice(0, 10);
  return { key, multiplier: 1, history: [{ date: day(120), value: ninetyOneDaysAgo }, { date: day(91), value: ninetyOneDaysAgo }, { date: day(0), value: latest }] };
}

test('a panic tape ranks global stress as the dominant dollar path', () => {
  const model = calculateDollarScenarios([
    fredSeries('vix', 34),
    fredSeries('highYieldSpread', 7.2, 4.9),
    fredSeries('financialConditions', 0.8),
    fredSeries('realYield10y', 1.4, 1.5),
    fredSeries('us2yYield', 3.6, 3.9),
  ], { growthSpread60d: -4 });
  assert.equal(model.status, 'calculated');
  assert.equal(model.leading.key, 'globalStress');
  assert.match(model.read, /Global stress is the dominant dollar path/);
  assert.ok(model.scenarios.find((item) => item.key === 'globalStress').score > 80);
});

test('rising real yields into a calm tape rank U.S. outperformance first', () => {
  const model = calculateDollarScenarios([
    fredSeries('vix', 13),
    fredSeries('highYieldSpread', 2.9, 3.1),
    fredSeries('financialConditions', -0.55),
    fredSeries('realYield10y', 2.3, 1.5),
    fredSeries('us2yYield', 4.6, 3.7),
  ], { growthSpread60d: -6 });
  assert.equal(model.leading.key, 'usOutperformance');
  assert.ok(model.scenarios.find((item) => item.key === 'globalStress').score < 40);
});

test('U.S. leadership without carry or panic ranks the defensive path first', () => {
  const model = calculateDollarScenarios([
    fredSeries('vix', 14),
    fredSeries('highYieldSpread', 3.6, 3.6),
    fredSeries('financialConditions', -0.2),
    fredSeries('realYield10y', 1.2, 1.9),
    fredSeries('us2yYield', 3.2, 3.9),
  ], { growthSpread60d: -9 });
  assert.equal(model.leading.key, 'weakGlobalGrowth');
});

test('shares of the calculated paths sum to about one hundred', () => {
  const model = calculateDollarScenarios([
    fredSeries('vix', 21),
    fredSeries('highYieldSpread', 4.1, 4),
    fredSeries('financialConditions', 0),
    fredSeries('realYield10y', 1.8, 1.7),
    fredSeries('us2yYield', 4, 3.9),
  ], { growthSpread60d: -1 });
  const shares = model.scenarios.map((item) => item.share).filter(Number.isFinite);
  assert.equal(shares.length, 3);
  assert.ok(Math.abs(shares.reduce((total, value) => total + value, 0) - 100) <= 2);
});

test('two paths within five points report no dominant path rather than a winner', () => {
  const model = calculateDollarScenarios([
    fredSeries('vix', 20),
    fredSeries('highYieldSpread', 4, 4),
    fredSeries('financialConditions', 0),
    fredSeries('realYield10y', 1.8, 1.8),
    fredSeries('us2yYield', 4, 4),
  ], { growthSpread60d: 0 });
  assert.equal(model.leading, null);
  assert.match(model.read, /no path dominates/);
});

test('a path missing its growth leg still publishes on its remaining evidence', () => {
  const model = calculateDollarScenarios([
    fredSeries('vix', 30),
    fredSeries('highYieldSpread', 6.5, 4.8),
    fredSeries('financialConditions', 0.6),
    fredSeries('realYield10y', 1.4, 1.5),
    fredSeries('us2yYield', 3.6, 3.9),
  ], {});
  assert.equal(model.status, 'calculated');
  const defensive = model.scenarios.find((item) => item.key === 'weakGlobalGrowth');
  assert.deepEqual(defensive.missing, ['U.S. equity leadership, 60 sessions']);
  assert.equal(defensive.coverage, 67);
  assert.equal(defensive.status, 'calculated');
});

test('no FRED inputs leaves every path explicitly unavailable', () => {
  const model = calculateDollarScenarios([], {});
  assert.equal(model.status, 'unavailable');
  assert.equal(model.leading, null);
  assert.equal(model.scenarios.length, 3);
  assert.ok(model.scenarios.every((item) => item.status === 'unavailable' && item.score === null));
});

test('a single leg is not enough for a path to publish a score', () => {
  const model = calculateDollarScenarios([fredSeries('vix', 28)], {});
  assert.equal(model.scenarios.find((item) => item.key === 'globalStress').score, null);
  assert.equal(model.status, 'unavailable');
});

test('a weakening dollar is a tailwind only while the link is inverse', () => {
  const weakDollar = { usdMomentum: -1.5, usdScore: 40 };
  const inverse = calculateDollarTransmissionRead({ ...weakDollar, corr60: -0.55 });
  assert.equal(inverse.label, 'Dollar tailwind');
  assert.equal(inverse.score, 2);
  assert.equal(inverse.linkSign, 1);
});

test('the same weakening dollar is a headwind under a positive link', () => {
  const positive = calculateDollarTransmissionRead({ usdMomentum: -1.5, usdScore: 40, corr60: 0.55 });
  assert.equal(positive.label, 'Dollar headwind');
  assert.equal(positive.score, -2);
  assert.equal(positive.linkSign, -1);
  assert.equal(positive.dollarWeakness, 2);
});

test('a strengthening dollar flips with the link in the same way', () => {
  assert.equal(calculateDollarTransmissionRead({ usdMomentum: 1.5, usdScore: 70, corr60: -0.5 }).label, 'Dollar headwind');
  assert.equal(calculateDollarTransmissionRead({ usdMomentum: 1.5, usdScore: 70, corr60: 0.5 }).label, 'Dollar tailwind');
});

test('a link inside the dead band transmits nothing rather than a tailwind', () => {
  const weak = calculateDollarTransmissionRead({ usdMomentum: -2, usdScore: 35, corr60: 0.08 });
  assert.equal(weak.label, 'Link too weak to transmit');
  assert.equal(weak.score, 0);
  assert.equal(weak.linkSign, 0);
  assert.match(weak.reason, /no reliable bitcoin signal/);
});

test('an unmeasured link withholds the read instead of assuming inverse', () => {
  const unmeasured = calculateDollarTransmissionRead({ usdMomentum: -2, usdScore: 35, corr60: null });
  assert.equal(unmeasured.label, null);
  assert.equal(unmeasured.status, 'provisional');
  assert.equal(unmeasured.dollarWeakness, 2);
  assert.match(unmeasured.reason, /has to be measured/);
});

test('a measured link with no dollar reading stays provisional', () => {
  const noDollar = calculateDollarTransmissionRead({ corr60: -0.6 });
  assert.equal(noDollar.status, 'provisional');
  assert.equal(noDollar.label, null);
  assert.equal(noDollar.linkSign, 1);
});

test('a dollar going nowhere reads neutral under a live link', () => {
  const flat = calculateDollarTransmissionRead({ usdMomentum: 0.1, usdScore: 50, corr60: -0.6 });
  assert.equal(flat.label, 'Neutral dollar');
  assert.equal(flat.score, 0);
});

test('no inputs at all is explicitly unavailable', () => {
  const empty = calculateDollarTransmissionRead({});
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.score, null);
  assert.equal(empty.dollarWeakness, null);
});

const flatThen = (length, start, end) => Array.from({ length }, (_, index) => (index < length - 21 ? start : start + ((end - start) * ((index - (length - 22)) / 21))));

test('cheap energy with miners outpacing the metal reads as expanding margins', () => {
  const model = calculateMetalsCostStructure({
    crude: Array.from({ length: 260 }, (_, index) => 90 - (index * 0.1)),
    naturalGas: Array.from({ length: 260 }, (_, index) => 4 - (index * 0.008)),
    minerToMetalRatio: Array.from({ length: 260 }, (_, index) => 0.2 + (index * 0.0004)),
  });
  assert.equal(model.status, 'calculated');
  assert.equal(model.headline, 'Margins expanding');
  assert.ok(model.energyPressure < 50);
  assert.match(model.read, /Margins expanding/);
});

test('expensive energy with miners lagging reads as compressing margins', () => {
  const model = calculateMetalsCostStructure({
    crude: Array.from({ length: 260 }, (_, index) => 60 + (index * 0.12)),
    naturalGas: Array.from({ length: 260 }, (_, index) => 2 + (index * 0.01)),
    minerToMetalRatio: Array.from({ length: 260 }, (_, index) => 0.3 - (index * 0.0004)),
  });
  assert.equal(model.headline, 'Margins compressing');
  assert.ok(model.energyPressure > 50);
});

test('the cost model never invents an all-in sustaining cost', () => {
  const model = calculateMetalsCostStructure({
    crude: Array.from({ length: 260 }, () => 75),
    naturalGas: Array.from({ length: 260 }, () => 3),
    minerToMetalRatio: Array.from({ length: 260 }, () => 0.25),
  });
  const aisc = model.legs.find((leg) => leg.key === 'aisc');
  assert.equal(aisc.status, 'unavailable');
  assert.equal(aisc.value, null);
  assert.match(aisc.reason, /filings-based feed/);
  // Three of four legs calculated, so the model is provisional rather than complete.
  assert.equal(model.status, 'calculated');
});

test('each leg carries its level, 20-session change and one-year percentile', () => {
  const crude = Array.from({ length: 260 }, (_, index) => 50 + index);
  const model = calculateMetalsCostStructure({ crude, naturalGas: [], minerToMetalRatio: [] });
  const leg = model.legs.find((item) => item.key === 'crude');
  assert.equal(leg.value, 309);
  assert.equal(leg.percentile, 100);
  assert.equal(leg.change20d, Math.round(((309 / 289) - 1) * 10000) / 100);
  assert.equal(leg.source, 'Yahoo CL=F');
});

test('a leg without enough history is unavailable rather than approximated', () => {
  const model = calculateMetalsCostStructure({ crude: Array.from({ length: 30 }, () => 70), naturalGas: [], minerToMetalRatio: [] });
  const crude = model.legs.find((leg) => leg.key === 'crude');
  assert.equal(crude.status, 'unavailable');
  assert.equal(crude.value, null);
  assert.match(crude.reason, /60 sessions/);
  assert.equal(model.status, 'unavailable');
  assert.equal(model.headline, null);
  assert.match(model.read, /required before producer economics/);
});

test('a margin read without energy still says which way miners moved', () => {
  const model = calculateMetalsCostStructure({
    crude: [], naturalGas: [],
    minerToMetalRatio: Array.from({ length: 260 }, (_, index) => 0.2 + (index * 0.0004)),
  });
  assert.equal(model.headline, 'Miners outpacing the metal');
  assert.equal(model.energyPressure, null);
  assert.equal(model.status, 'provisional');
});

test('no inputs at all leaves the cost structure unavailable', () => {
  const model = calculateMetalsCostStructure({});
  assert.equal(model.status, 'unavailable');
  assert.equal(model.legs.filter((leg) => leg.status === 'calculated').length, 0);
});

const heatmapAsset = (overrides) => ({ symbol: 'SPY', name: 'S&P 500', group: 'US', status: 'calculated', score: 60, alignmentValue: 0.4, crowdingPercentile: null, ...overrides });

test('a crowded market that has rolled over outranks one that is still working', () => {
  const model = calculateHeatmapRisk([
    heatmapAsset({ symbol: 'GLD', name: 'Gold', score: 72, crowdingPercentile: 94 }),
    heatmapAsset({ symbol: 'QQQ', name: 'Nasdaq 100', score: 38, crowdingPercentile: 88 }),
  ]);
  assert.equal(model.headline.type, 'Crowded and turning');
  assert.equal(model.headline.symbol, 'QQQ');
  assert.match(model.headline.read, /the crowd is offside rather than early/);
  assert.equal(model.concerns[1].type, 'Crowded consensus');
  assert.equal(model.concerns[1].symbol, 'GLD');
});

test('a stressed market still moving with the complex is flagged as transmitting', () => {
  const model = calculateHeatmapRisk([
    heatmapAsset({ symbol: 'EEM', name: 'Emerging markets', score: 28, alignmentValue: 0.78 }),
    heatmapAsset({ symbol: 'GLD', name: 'Gold', score: 30, alignmentValue: 0.05 }),
  ]);
  const transmitting = model.concerns.filter((concern) => concern.type === 'Stress transmitting');
  assert.equal(transmitting.length, 1);
  assert.equal(transmitting[0].symbol, 'EEM');
  assert.match(transmitting[0].read, /unlikely to stay contained/);
});

test('broad stress is raised against the universe rather than any one market', () => {
  const model = calculateHeatmapRisk([
    heatmapAsset({ symbol: 'A', score: 20, alignmentValue: 0.1 }),
    heatmapAsset({ symbol: 'B', score: 25, alignmentValue: 0.1 }),
    heatmapAsset({ symbol: 'C', score: 70, alignmentValue: 0.1 }),
  ]);
  const broad = model.concerns.find((concern) => concern.type === 'Broad stress');
  assert.ok(broad);
  assert.equal(broad.symbol, null);
  assert.equal(model.stressShare, 67);
  assert.match(broad.read, /2 of 3 calculated markets \(67%\)/);
});

test('a calm universe reports no weak link rather than inventing one', () => {
  const model = calculateHeatmapRisk([
    heatmapAsset({ symbol: 'SPY', score: 62, alignmentValue: 0.5, crowdingPercentile: 40 }),
    heatmapAsset({ symbol: 'GLD', name: 'Gold', score: 55, alignmentValue: 0.2, crowdingPercentile: 55 }),
  ]);
  assert.equal(model.status, 'calculated');
  assert.deepEqual(model.concerns, []);
  assert.equal(model.headline, null);
  assert.match(model.read, /No single weak link stands out/);
});

test('markets without a positioning contract contribute no crowding concern', () => {
  const model = calculateHeatmapRisk([heatmapAsset({ symbol: 'EWJ', name: 'Japan', score: 30, crowdingPercentile: null, alignmentValue: 0.1 })]);
  assert.equal(model.concerns.filter((concern) => concern.type.startsWith('Crowded')).length, 0);
});

test('an unavailable market is excluded from the universe entirely', () => {
  const model = calculateHeatmapRisk([
    { symbol: 'X', name: 'X', status: 'unavailable' },
    heatmapAsset({ symbol: 'SPY', score: 60, alignmentValue: 0.3, crowdingPercentile: 20 }),
  ]);
  assert.equal(model.universeSize, 1);
  assert.equal(model.stressShare, 0);
});

test('a universe with nothing calculated is explicitly unavailable', () => {
  const model = calculateHeatmapRisk([{ symbol: 'X', status: 'unavailable' }]);
  assert.equal(model.status, 'unavailable');
  assert.equal(model.headline, null);
  assert.equal(calculateHeatmapRisk().status, 'unavailable');
});

test('the regime classifier keeps its documented band edges', () => {
  assert.equal(classifyMacroRegimeByScore(70), 'Expansion / risk-on');
  assert.equal(classifyMacroRegimeByScore(69), 'Constructive');
  assert.equal(classifyMacroRegimeByScore(58), 'Constructive');
  assert.equal(classifyMacroRegimeByScore(57), 'Transition / choppy');
  assert.equal(classifyMacroRegimeByScore(36), 'Transition / choppy');
  assert.equal(classifyMacroRegimeByScore(35), 'Contraction / risk-off');
  assert.equal(classifyMacroRegimeByScore(null), null);
});

test('proximity measures the points needed to actually change the label', () => {
  const midBand = calculateMacroRegimeProximity(64);
  assert.equal(midBand.regime, 'Constructive');
  assert.deepEqual(midBand.higher, { regime: 'Expansion / risk-on', distance: 6 });
  assert.deepEqual(midBand.lower, { regime: 'Transition / choppy', distance: 7 });
  assert.equal(midBand.nearest.direction, 'higher');
  assert.equal(midBand.borderline, false);
});

test('a score one point inside its band is reported as borderline', () => {
  const edge = calculateMacroRegimeProximity(58);
  assert.equal(edge.regime, 'Constructive');
  assert.equal(edge.lower.distance, 1);
  assert.equal(edge.lower.regime, 'Transition / choppy');
  assert.equal(edge.borderline, true);
  assert.match(edge.read, /1 point from Transition \/ choppy below/);
});

test('proximity is consistent with the classifier at every integer score', () => {
  for (let score = 0; score <= 100; score += 1) {
    const proximity = calculateMacroRegimeProximity(score);
    assert.equal(proximity.regime, classifyMacroRegimeByScore(score));
    for (const side of [proximity.higher, proximity.lower]) {
      if (!side) continue;
      const step = side === proximity.higher ? 1 : -1;
      // The named distance must be the first score that changes the label.
      assert.equal(classifyMacroRegimeByScore(score + (side.distance * step)), side.regime);
      assert.equal(classifyMacroRegimeByScore(score + ((side.distance - 1) * step)), proximity.regime);
    }
  }
});

test('the extremes of the scale have only one direction to travel', () => {
  const bottom = calculateMacroRegimeProximity(0);
  assert.equal(bottom.lower, null);
  assert.equal(bottom.higher.regime, 'Transition / choppy');
  const top = calculateMacroRegimeProximity(100);
  assert.equal(top.higher, null);
  assert.equal(top.lower.regime, 'Constructive');
});

test('a confirmed panic publishes no proximity because it overrides the bands', () => {
  const day = (offset) => new Date(Date.UTC(2026, 6, 1) - (offset * 86_400_000)).toISOString().slice(0, 10);
  const series = (key, latest, past) => ({ key, multiplier: 1, history: [{ date: day(120), value: past ?? latest }, { date: day(0), value: latest }] });
  const panicked = calculateMacroRegimeModel(
    [series('vix', 42, 20), series('highYieldSpread', 6.4, 4), series('financialConditions', 0.9, 0.1)],
    { score: 30, version: 'us-liquidity-v1' },
  );
  assert.equal(panicked.panicConfirmed, true);
  assert.equal(panicked.regime, 'Stress / deleveraging');
  assert.equal(panicked.proximity, null);

  const calm = calculateMacroRegimeModel(
    [series('vix', 15, 16), series('highYieldSpread', 3.2, 3.3), series('financialConditions', -0.4, -0.3)],
    { score: 62, version: 'us-liquidity-v1' },
  );
  assert.equal(calm.panicConfirmed, false);
  assert.equal(calm.proximity.regime, calm.regime);
  assert.ok(calm.proximity.nearest.distance > 0);
});

const cycleLegs = ({ drawdownPct, mvrvZ, vsW, vsD, funding, vol, stable, sth }) => ({
  trend: Number.isFinite(vsW) || Number.isFinite(vsD) ? { status: 'calculated', pctVsSma200w: vsW, pctVsSma200d: vsD } : { status: 'unavailable' },
  valuation: Number.isFinite(mvrvZ) ? { status: 'calculated', mvrvZ } : { status: 'unavailable' },
  drawdown: Number.isFinite(drawdownPct) ? { status: 'calculated', drawdownPct } : { status: 'unavailable' },
  leverage: Number.isFinite(funding) ? { status: 'calculated', percentile: funding } : { status: 'unavailable' },
  realizedVolatility: Number.isFinite(vol) ? { status: 'calculated', percentile: vol } : { status: 'unavailable' },
  stablecoins: Number.isFinite(stable) ? { status: 'calculated', change30dPercent: stable } : { status: 'unavailable' },
  shortTermHolder: Number.isFinite(sth) ? { status: 'calculated', premiumPercent: sth } : { status: 'unavailable' },
});

test('a deep bear with a negative Z-score places bitcoin in capitulation', () => {
  const model = calculateBitcoinCyclePhase(cycleLegs({ drawdownPct: -72, mvrvZ: -0.6, vsW: -22, vsD: -35, funding: 8, vol: 40, stable: -1.5, sth: -28 }));
  assert.equal(model.leading.key, 'capitulation');
  assert.match(model.read, /Capitulation \/ accumulation is the best-supported phase/);
  assert.ok(model.leading.margin >= 5);
});

test('a stretched Z-score with crowded funding at the highs places it in euphoria', () => {
  const model = calculateBitcoinCyclePhase(cycleLegs({ drawdownPct: -1, mvrvZ: 6.5, vsW: 180, vsD: 35, funding: 95, vol: 88, stable: 3, sth: 42 }));
  assert.equal(model.leading.key, 'euphoria');
  assert.ok(model.phases.find((phase) => phase.key === 'capitulation').score < 25);
});

test('a shallow drawdown with mid-cycle valuation and calm funding is expansion', () => {
  const model = calculateBitcoinCyclePhase(cycleLegs({ drawdownPct: -8, mvrvZ: 3.5, vsW: 90, vsD: 14, funding: 30, vol: 45, stable: 1, sth: 12 }));
  assert.equal(model.leading.key, 'expansion');
});

test('a base rebuilding above the long average is early recovery', () => {
  const model = calculateBitcoinCyclePhase(cycleLegs({ drawdownPct: -30, mvrvZ: 1, vsW: 15, vsD: 2, funding: 35, vol: 50, stable: 2.5, sth: 3 }));
  assert.equal(model.leading.key, 'recovery');
});

test('two phases within five points are reported as ambiguous rather than resolved', () => {
  const model = calculateBitcoinCyclePhase(cycleLegs({ drawdownPct: -19, mvrvZ: 2.25, vsW: 52, vsD: 8, funding: 50, vol: 50, stable: 0, sth: 5 }));
  const ranked = model.phases.filter((phase) => phase.score !== null).sort((a, b) => b.score - a.score);
  if (ranked[0].score - ranked[1].score < 5) {
    assert.equal(model.leading, null);
    assert.match(model.read, /genuinely ambiguous/);
  } else {
    assert.ok(model.leading);
  }
});

test('a phase with fewer than two calculated legs does not publish a score', () => {
  const model = calculateBitcoinCyclePhase(cycleLegs({ mvrvZ: 4 }));
  const euphoria = model.phases.find((phase) => phase.key === 'euphoria');
  assert.equal(euphoria.score, null);
  assert.equal(euphoria.status, 'unavailable');
  assert.equal(euphoria.coverage, 25);
  assert.equal(model.status, 'unavailable');
  assert.match(model.read, /required before a cycle phase can be placed/);
});

test('a phase scoring on half its legs says so through coverage', () => {
  const model = calculateBitcoinCyclePhase(cycleLegs({ drawdownPct: -70, mvrvZ: -0.5, vsW: -20, sth: -30 }));
  assert.equal(model.leading.key, 'capitulation');
  const euphoria = model.phases.find((phase) => phase.key === 'euphoria');
  // Two legs is enough to score, but the reader is told which two are missing.
  assert.equal(euphoria.status, 'calculated');
  assert.equal(euphoria.coverage, 50);
  assert.deepEqual(euphoria.missing, ['Funding percentile', 'Realized-volatility percentile']);
  assert.equal(model.phases.find((phase) => phase.key === 'capitulation').coverage, 100);
});

test('a phase short of two legs drops out and marks the model provisional', () => {
  const model = calculateBitcoinCyclePhase({
    trend: { status: 'calculated', pctVsSma200w: -20, pctVsSma200d: -30 },
    valuation: { status: 'unavailable' },
    drawdown: { status: 'unavailable' },
    leverage: { status: 'unavailable' },
    realizedVolatility: { status: 'unavailable' },
    stablecoins: { status: 'calculated', change30dPercent: 2 },
    shortTermHolder: { status: 'calculated', premiumPercent: -25 },
  });
  assert.equal(model.status, 'provisional');
  assert.equal(model.phases.find((phase) => phase.key === 'euphoria').score, null);
  assert.equal(model.phases.find((phase) => phase.key === 'capitulation').score !== null, true);
});

test('an entirely unavailable workspace places no phase at all', () => {
  const model = calculateBitcoinCyclePhase({});
  assert.equal(model.status, 'unavailable');
  assert.equal(model.leading, null);
  assert.equal(model.phases.length, 4);
  assert.ok(model.phases.every((phase) => phase.score === null));
});

test('a keyless CoinGecko request stays on the public host with no key header', () => {
  const request = buildCoingeckoRequest('/global');
  assert.equal(request.plan, 'keyless');
  assert.equal(request.url, 'https://api.coingecko.com/api/v3/global');
  assert.equal(request.headers, null);
});

test('a demo key keeps the public host but carries the demo header', () => {
  const request = buildCoingeckoRequest('/global', { apiKey: 'CG-demo123' });
  assert.equal(request.plan, 'demo');
  assert.equal(request.url, 'https://api.coingecko.com/api/v3/global');
  assert.deepEqual(request.headers, { 'x-cg-demo-api-key': 'CG-demo123' });
});

test('a pro key moves host and header together', () => {
  const request = buildCoingeckoRequest('/global', { apiKey: 'CG-pro456', plan: 'pro' });
  assert.equal(request.plan, 'pro');
  assert.equal(request.url, 'https://pro-api.coingecko.com/api/v3/global');
  assert.deepEqual(request.headers, { 'x-cg-pro-api-key': 'CG-pro456' });
});

test('asking for the pro plan without a key falls back to keyless rather than a host that will reject it', () => {
  const request = buildCoingeckoRequest('/global', { plan: 'pro' });
  assert.equal(request.plan, 'keyless');
  assert.equal(request.url, 'https://api.coingecko.com/api/v3/global');
  assert.equal(request.headers, null);
});

test('a blank or whitespace key is treated as no key at all', () => {
  for (const apiKey of ['', '   ', null, undefined]) {
    const request = buildCoingeckoRequest('/global', { apiKey, plan: 'pro' });
    assert.equal(request.plan, 'keyless');
    assert.equal(request.headers, null);
  }
});

test('parameters are encoded and empty ones are dropped', () => {
  const request = buildCoingeckoRequest('/simple/price', {
    apiKey: 'CG-x',
    params: { ids: 'bitcoin', vs_currencies: 'usd', include_24hr_change: 'true', precision: '', missing: null, skipped: undefined },
  });
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('ids'), 'bitcoin');
  assert.equal(url.searchParams.get('include_24hr_change'), 'true');
  assert.equal(url.searchParams.has('precision'), false);
  assert.equal(url.searchParams.has('missing'), false);
  assert.equal(url.searchParams.has('skipped'), false);
});

test('a path is accepted with or without its leading slash', () => {
  assert.equal(buildCoingeckoRequest('global').url, buildCoingeckoRequest('/global').url);
});

test('a rising market with bitcoin ahead is a concentrating bid', () => {
  const model = calculateCryptoRotation({ bitcoinChange24hPct: 4.2, totalMarketCapChange24hPct: 2.1, btcDominancePct: 58.4 });
  assert.equal(model.regime, 'Bitcoin-led advance');
  assert.equal(model.spread, 2.1);
  assert.equal(model.btcDominancePct, 58.4);
  assert.match(model.read, /concentrating rather than broadening/);
});

test('a rising market with bitcoin behind is the bid broadening out', () => {
  const model = calculateCryptoRotation({ bitcoinChange24hPct: 0.8, totalMarketCapChange24hPct: 3.4 });
  assert.equal(model.regime, 'Altcoin-led advance');
  assert.equal(model.spread, -2.6);
});

test('the same positive spread reads as a haven bid when the market is falling', () => {
  const rising = calculateCryptoRotation({ bitcoinChange24hPct: 2, totalMarketCapChange24hPct: 0.5 });
  const falling = calculateCryptoRotation({ bitcoinChange24hPct: -1, totalMarketCapChange24hPct: -2.5 });
  assert.equal(rising.spread, falling.spread);
  assert.equal(rising.regime, 'Bitcoin-led advance');
  assert.equal(falling.regime, 'Flight to bitcoin');
  assert.match(falling.read, /haven within crypto/);
});

test('weakness starting at the centre is a bitcoin-led decline', () => {
  const model = calculateCryptoRotation({ bitcoinChange24hPct: -5.1, totalMarketCapChange24hPct: -3.2 });
  assert.equal(model.regime, 'Bitcoin-led decline');
  assert.match(model.read, /starts at the centre/);
});

test('a spread inside the band is a broad move rather than a named rotation', () => {
  const up = calculateCryptoRotation({ bitcoinChange24hPct: 2.1, totalMarketCapChange24hPct: 2.0 });
  assert.equal(up.regime, 'Broad advance');
  assert.equal(up.decisive, false);
  const down = calculateCryptoRotation({ bitcoinChange24hPct: -1.9, totalMarketCapChange24hPct: -2.0 });
  assert.equal(down.regime, 'Broad decline');
  assert.equal(down.decisive, false);
  assert.match(down.read, /indiscriminate rather than rotational/);
});

test('the band edge is inclusive so a quarter point already counts as rotation', () => {
  assert.equal(calculateCryptoRotation({ bitcoinChange24hPct: 1.25, totalMarketCapChange24hPct: 1 }).regime, 'Bitcoin-led advance');
  assert.equal(calculateCryptoRotation({ bitcoinChange24hPct: 1.24, totalMarketCapChange24hPct: 1 }).regime, 'Broad advance');
});

test('a missing change withholds the rotation read entirely', () => {
  assert.equal(calculateCryptoRotation({ bitcoinChange24hPct: 2 }).status, 'unavailable');
  assert.equal(calculateCryptoRotation({ totalMarketCapChange24hPct: 2 }).status, 'unavailable');
  const empty = calculateCryptoRotation({});
  assert.equal(empty.regime, null);
  assert.match(empty.reason, /Both the bitcoin 24-hour change/);
});

test('dominance is carried for context but does not decide the regime', () => {
  const high = calculateCryptoRotation({ bitcoinChange24hPct: 0.5, totalMarketCapChange24hPct: 3, btcDominancePct: 72, ethDominancePct: 11 });
  // Dominance is high, yet the flow is out of bitcoin — the level must not override it.
  assert.equal(high.regime, 'Altcoin-led advance');
  assert.equal(high.btcDominancePct, 72);
  assert.equal(high.ethDominancePct, 11);
});

test('an anonymous Socrata request carries no token header', () => {
  const request = buildSocrataRequest('publicreporting.cftc.gov', '6dca-aqww', { params: { $limit: '160' } });
  assert.equal(request.authenticated, false);
  assert.equal(request.headers, null);
  assert.equal(request.url, 'https://publicreporting.cftc.gov/resource/6dca-aqww.json?%24limit=160');
});

test('an app token travels as a header, not in the query string', () => {
  const request = buildSocrataRequest('publicreporting.cftc.gov', '6dca-aqww', { appToken: 'tok123', params: { $limit: '160' } });
  assert.equal(request.authenticated, true);
  assert.deepEqual(request.headers, { 'X-App-Token': 'tok123' });
  assert.equal(new URL(request.url).searchParams.has('$$app_token'), false);
  assert.equal(request.url.includes('tok123'), false);
});

test('Socrata query parameters are encoded and blank ones dropped', () => {
  const request = buildSocrataRequest('publicreporting.cftc.gov', '6dca-aqww', {
    params: { $where: "cftc_contract_market_code='088691'", $order: 'report_date_as_yyyy_mm_dd DESC', $offset: '', missing: null },
  });
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('$where'), "cftc_contract_market_code='088691'");
  assert.equal(url.searchParams.get('$order'), 'report_date_as_yyyy_mm_dd DESC');
  assert.equal(url.searchParams.has('$offset'), false);
  assert.equal(url.searchParams.has('missing'), false);
});

test('a blank token is treated as anonymous', () => {
  for (const appToken of ['', '   ', null, undefined]) {
    assert.equal(buildSocrataRequest('publicreporting.cftc.gov', 'x', { appToken }).authenticated, false);
  }
});

test('the host is accepted with or without a scheme or trailing slash', () => {
  const expected = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json';
  for (const host of ['publicreporting.cftc.gov', 'https://publicreporting.cftc.gov', 'https://publicreporting.cftc.gov/']) {
    assert.equal(buildSocrataRequest(host, '6dca-aqww').url, expected);
  }
});

// Two points 91 days apart is all the delta helper needs.
const runwaySeries = (key, then, now) => ({
  key,
  multiplier: 1,
  history: [
    { date: new Date(Date.UTC(2026, 4, 1)).toISOString().slice(0, 10), value: then },
    { date: new Date(Date.UTC(2026, 6, 31)).toISOString().slice(0, 10), value: now },
  ],
});

test('a draining facility absorbing QT publishes its runway in months', () => {
  // Balance sheet down 300bn, RRP down 300bn over the window, 400bn left.
  const model = calculateLiquidityRunway([
    runwaySeries('fedBalanceSheet', 7_300_000, 7_000_000),
    runwaySeries('reverseRepo', 700_000, 400_000),
    runwaySeries('treasuryGeneralAccount', 700_000, 750_000),
  ]);
  assert.equal(model.status, 'calculated');
  assert.equal(model.state, 'Reverse repo is absorbing the tightening');
  assert.equal(model.offsetRatio, 1);
  // 300bn over ~3 months is ~100bn a month; 400bn left is about 4 months.
  assert.ok(model.runwayMonths > 3.8 && model.runwayMonths < 4.2, `runway ${model.runwayMonths}`);
  assert.match(model.read, /about 4 months left/);
  assert.equal(model.treasuryDirection, 'rebuilding');
});

test('QT with no drawdown to cushion it says the tightening reaches reserves', () => {
  const model = calculateLiquidityRunway([
    runwaySeries('fedBalanceSheet', 7_300_000, 7_000_000),
    runwaySeries('reverseRepo', 20_000, 20_000),
    runwaySeries('treasuryGeneralAccount', 700_000, 700_000),
  ]);
  assert.equal(model.state, 'Tightening lands on reserves');
  assert.equal(model.runwayMonths, null);
  assert.equal(model.offsetRatio, null);
  assert.match(model.read, /reaches reserves directly/);
  assert.equal(model.treasuryDirection, 'flat');
});

test('a drawdown covering only part of the contraction is called out as partial', () => {
  const model = calculateLiquidityRunway([
    runwaySeries('fedBalanceSheet', 7_400_000, 7_000_000),
    runwaySeries('reverseRepo', 500_000, 420_000),
    runwaySeries('treasuryGeneralAccount', 700_000, 690_000),
  ]);
  assert.equal(model.state, 'Reverse repo only partly absorbing the tightening');
  assert.equal(model.offsetRatio, 0.2);
  assert.ok(model.runwayMonths > 0);
  assert.equal(model.treasuryDirection, 'drawing down');
});

test('an expanding balance sheet needs nothing absorbed on its behalf', () => {
  const growing = calculateLiquidityRunway([
    runwaySeries('fedBalanceSheet', 7_000_000, 7_200_000),
    runwaySeries('reverseRepo', 400_000, 400_000),
    runwaySeries('treasuryGeneralAccount', 700_000, 700_000),
  ]);
  assert.equal(growing.state, 'Balance sheet expanding');
  assert.equal(growing.runwayMonths, null);

  const both = calculateLiquidityRunway([
    runwaySeries('fedBalanceSheet', 7_000_000, 7_200_000),
    runwaySeries('reverseRepo', 400_000, 300_000),
    runwaySeries('treasuryGeneralAccount', 700_000, 700_000),
  ]);
  assert.equal(both.state, 'Balance sheet expanding with reverse repo still draining');
  assert.ok(both.runwayMonths > 0);
});

test('an empty facility publishes no runway even while the balance sheet shrinks', () => {
  const model = calculateLiquidityRunway([
    runwaySeries('fedBalanceSheet', 7_300_000, 7_000_000),
    runwaySeries('reverseRepo', 90_000, 0),
    runwaySeries('treasuryGeneralAccount', 700_000, 700_000),
  ]);
  // It drained to nothing, so there is no cushion left to measure.
  assert.equal(model.reverseRepoLevel, 0);
  assert.equal(model.runwayMonths, null);
});

test('the runway is withheld without both required histories', () => {
  const noRrp = calculateLiquidityRunway([runwaySeries('fedBalanceSheet', 7_300_000, 7_000_000)]);
  assert.equal(noRrp.status, 'unavailable');
  assert.equal(noRrp.state, null);
  assert.match(noRrp.reason, /reverse-repo histories/);
  assert.equal(calculateLiquidityRunway([]).status, 'unavailable');
  assert.equal(calculateLiquidityRunway().status, 'unavailable');
});

// A daily series, so a window of any length has a real comparison point.
const dailyRunwaySeries = (key, from, to, days = 120) => ({
  key,
  multiplier: 1,
  history: Array.from({ length: days }, (_, index) => ({
    date: new Date(Date.UTC(2026, 3, 1) + (index * 86_400_000)).toISOString().slice(0, 10),
    value: from + (((to - from) * index) / (days - 1)),
  })),
});

test('a shorter window is honoured in both the pace and the methodology', () => {
  const model = calculateLiquidityRunway([
    dailyRunwaySeries('fedBalanceSheet', 7_300_000, 7_000_000),
    dailyRunwaySeries('reverseRepo', 700_000, 400_000),
  ], { windowDays: 30 });
  assert.equal(model.windowDays, 30);
  // A 300bn drawdown spread over 120 days is 75bn a month, so the 400bn left
  // lasts a little over five months.
  assert.ok(model.runwayMonths > 4 && model.runwayMonths < 7, `runway ${model.runwayMonths}`);
  assert.match(model.methodology, /over 30 days/);
});

test('a window with no comparison point inside it refuses rather than rescaling', () => {
  // Two observations 91 days apart cannot answer a 30-day question. Taking the
  // older one anyway reported a 91-day drawdown as a 30-day pace, tripling the
  // implied drain and cutting the runway to a third of the truth.
  const model = calculateLiquidityRunway([
    runwaySeries('fedBalanceSheet', 7_300_000, 7_000_000),
    runwaySeries('reverseRepo', 700_000, 400_000),
  ], { windowDays: 30 });
  assert.equal(model.status, 'unavailable');
  assert.equal(model.runwayMonths, null);
});

// Binance publishes contracts and their notional value; price is the quotient.
const oiRows = (contractsSeries, priceSeries) => contractsSeries.map((contracts, index) => ({
  openInterest: contracts,
  openInterestValue: contracts * priceSeries[index],
}));
const flat = (value, length = 8) => Array.from({ length }, () => value);

test('a rally on falling open interest is spot-led, not a washout', () => {
  // The notional falls here because contracts drop faster than price rises;
  // reading notional as price would call this a deleveraging washout.
  const rows = oiRows([80_000, ...flat(78_000, 6), 64_000], [60_000, ...flat(62_000, 6), 66_000]);
  const model = calculateOpenInterestQuadrant(rows);
  assert.equal(model.status, 'calculated');
  assert.equal(model.quadrant, 'Spot-led advance');
  assert.ok(model.priceChange7d > 0, `price change ${model.priceChange7d}`);
  assert.ok(model.oiChange7d < 0, `oi change ${model.oiChange7d}`);
  assert.equal(Math.round(((80_000 * 60_000) / 80_000)), 60_000);
});

test('a decline on rising open interest is levered pressure, not expansion', () => {
  const rows = oiRows([60_000, ...flat(62_000, 6), 84_000], [70_000, ...flat(69_000, 6), 61_600]);
  const model = calculateOpenInterestQuadrant(rows);
  assert.equal(model.quadrant, 'Levered pressure');
  assert.ok(model.priceChange7d < 0);
  assert.ok(model.oiChange7d > 0);
});

test('both rising is a levered expansion and both falling a washout', () => {
  const up = calculateOpenInterestQuadrant(oiRows([70_000, ...flat(72_000, 6), 80_000], [60_000, ...flat(61_000, 6), 66_000]));
  assert.equal(up.quadrant, 'Levered expansion');
  const down = calculateOpenInterestQuadrant(oiRows([80_000, ...flat(78_000, 6), 70_000], [66_000, ...flat(64_000, 6), 60_000]));
  assert.equal(down.quadrant, 'Deleveraging washout');
});

test('price is recovered from notional rather than read off it', () => {
  // Contracts halve while price doubles: notional is unchanged, so anything
  // reading notional as price would see no move at all.
  const rows = oiRows([80_000, ...flat(80_000, 6), 40_000], [50_000, ...flat(50_000, 6), 100_000]);
  const model = calculateOpenInterestQuadrant(rows);
  assert.equal(model.priceChange7d, 100);
  assert.equal(model.oiChange7d, -50);
  assert.equal(model.quadrant, 'Spot-led advance');
  assert.equal(model.impliedPrice, 100_000);
});

test('rows are paired before filtering so the two series cannot fall out of step', () => {
  const rows = oiRows([80_000, ...flat(78_000, 6), 64_000], [60_000, ...flat(62_000, 6), 66_000]);
  // A row missing one field must drop entirely, not shift one series by a bar.
  const damaged = rows.map((row, index) => (index === 3 ? { ...row, openInterestValue: null } : row));
  const model = calculateOpenInterestQuadrant(damaged);
  assert.equal(model.observations, rows.length - 1);
  assert.equal(model.status, 'unavailable');
});

test('too little history withholds the quadrant', () => {
  assert.equal(calculateOpenInterestQuadrant(oiRows(flat(70_000, 5), flat(60_000, 5))).status, 'unavailable');
  assert.equal(calculateOpenInterestQuadrant([]).status, 'unavailable');
  assert.equal(calculateOpenInterestQuadrant().status, 'unavailable');
  assert.match(calculateOpenInterestQuadrant([]).reason, /8 paired open-interest observations/);
});

test('zero or negative contract counts are dropped rather than dividing', () => {
  const rows = oiRows([80_000, ...flat(78_000, 6), 64_000], [60_000, ...flat(62_000, 6), 66_000]);
  const withZero = [{ openInterest: 0, openInterestValue: 0 }, ...rows];
  const model = calculateOpenInterestQuadrant(withZero);
  assert.equal(model.status, 'calculated');
  assert.ok(Number.isFinite(model.impliedPrice));
});

function macroSeries(key, { start, step = 0, count = 60, everyDays = 7, multiplier = 1, endOffsetDays = 0 } = {}) {
  const base = Date.UTC(2025, 0, 1);
  return {
    key,
    multiplier,
    history: Array.from({ length: count }, (_, index) => ({
      date: new Date(base + ((index * everyDays - endOffsetDays) * 86_400_000)).toISOString().slice(0, 10),
      value: start + (index * step),
    })),
  };
}

test('net liquidity refuses to carry a stale leg forward', () => {
  const fed = macroSeries('fedBalanceSheet', { start: 7_000_000, step: 20_000, count: 60 });
  // The TGA stops updating four months before the Fed does. Carrying its last
  // value forward would keep printing net liquidity as though it were current.
  const treasury = macroSeries('treasuryGeneralAccount', { start: 800_000, step: -5_000, count: 42 });
  const reverseRepo = { ...macroSeries('reverseRepo', { start: 2_000, step: -15, count: 60 }), multiplier: 1000 };
  const model = calculateUsLiquidityModel([
    fed,
    treasury,
    reverseRepo,
    { ...macroSeries('usM2', { start: 20_000, step: 30, count: 60 }), multiplier: 1000 },
    macroSeries('dxy', { start: 110, step: -0.15, count: 60 }),
  ]);
  const lastAligned = model.history.at(-1).date;
  const lastTreasury = treasury.history.at(-1).date;
  const gapDays = (new Date(lastAligned) - new Date(lastTreasury)) / 86_400_000;
  assert.equal(gapDays <= 10, true, `net liquidity ran to ${lastAligned} on a TGA that stopped at ${lastTreasury}`);
});

test('a fully covered set of legs still produces a point on every Fed date', () => {
  const model = calculateUsLiquidityModel([
    macroSeries('fedBalanceSheet', { start: 7_000_000, step: 20_000, count: 60 }),
    macroSeries('treasuryGeneralAccount', { start: 800_000, step: -5_000, count: 60 }),
    { ...macroSeries('reverseRepo', { start: 2_000, step: -15, count: 60 }), multiplier: 1000 },
    { ...macroSeries('usM2', { start: 20_000, step: 30, count: 60 }), multiplier: 1000 },
    macroSeries('dxy', { start: 110, step: -0.15, count: 60 }),
  ]);
  assert.equal(model.status, 'calculated');
  assert.equal(model.history.length, 60);
  assert.equal(Number.isFinite(model.netLiquidity), true);
});

test('an unavailable model is not mistaken for a published one', () => {
  assert.equal(isPublished(null), false);
  assert.equal(isPublished({ status: 'unavailable', reason: 'x' }), false);
  assert.equal(isPublished({ status: 'calculated', score: 60 }), true);
  assert.equal(isPublished({ status: 'provisional', score: 60 }), true);
  assert.equal(isPublished({ score: 60 }), true);
});

test('liquidity momentum reports steady rather than flipping on float noise', () => {
  // A perfectly linear pool: the 28-day and 91-day impulses are the same
  // reading, and the label used to be decided by which was larger by 1e-16.
  const flat = (key, options) => macroSeries(key, options);
  const model = calculateUsLiquidityModel([
    flat('fedBalanceSheet', { start: 7_000_000, step: 0, count: 60 }),
    flat('treasuryGeneralAccount', { start: 800_000, step: 0, count: 60 }),
    { ...flat('reverseRepo', { start: 2_000, step: 0, count: 60 }), multiplier: 1000 },
    { ...flat('usM2', { start: 20_000, step: 0, count: 60 }), multiplier: 1000 },
    flat('dxy', { start: 110, step: 0, count: 60 }),
  ]);
  assert.equal(model.momentum, 'Steady');
});

test('the liquidity cycle ranks growth, not the raw level of a trending pool', () => {
  const day = (index) => new Date(Date.UTC(2019, 0, 1) + (index * 7 * 86_400_000)).toISOString().slice(0, 10);
  // A pool that grows every single week: its level is at an all-time high on
  // every observation, so a whole-history level percentile is always 100 and
  // carries no information at all.
  const steady = Array.from({ length: 320 }, (_, index) => ({ date: day(index), value: 1_000_000 + (index * 5_000) }));
  // The same shape of level - still making new highs - but the pace collapses.
  const decelerating = Array.from({ length: 320 }, (_, index) => ({
    date: day(index),
    value: 1_000_000 + (index < 200 ? index * 8_000 : (200 * 8_000) + ((index - 200) * 700)),
  }));

  const first = calculateLiquidityCyclePosition(steady);
  const second = calculateLiquidityCyclePosition(decelerating);
  assert.equal(first.levelPercentile, 100);
  assert.equal(second.levelPercentile, 100, 'the level percentile cannot tell these two pools apart');
  assert.equal(second.growthPercent < first.growthPercent, true, `${second.growthPercent} should be below ${first.growthPercent}`);
  assert.equal(first.status, 'calculated');
  assert.match(first.methodology, /ranked against a trailing/);
});

test('the growth percentile places a pool inside its own growth history', () => {
  const day = (index) => new Date(Date.UTC(2018, 0, 1) + (index * 7 * 86_400_000)).toISOString().slice(0, 10);
  // Growth that accelerates and then rolls over, so the percentile has a real
  // distribution to rank against rather than a monotone one.
  let level = 1_000_000;
  const points = Array.from({ length: 420 }, (_, index) => {
    const pace = 1 + (0.004 * (1 + Math.sin(index / 40)));
    level *= pace;
    return { date: day(index), value: level };
  });
  const result = calculateLiquidityCyclePosition(points);
  assert.equal(result.status, 'calculated');
  assert.equal(result.growthPercentile > 0 && result.growthPercentile < 100, true, `percentile was ${result.growthPercentile}`);
  assert.equal(['Expanding', 'Expanding but decelerating', 'Mid-cycle', 'Contracting', 'Contracting but turning up'].includes(result.phase), true);
});

test('the liquidity cycle refuses a history it cannot rank', () => {
  const result = calculateLiquidityCyclePosition([{ date: '2025-01-01', value: 100 }]);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.levelPercentile, null);
});

test('the macro regime is stamped with its oldest binding input, not its freshest', () => {
  const daily = (key, start, step, count, endOffsetDays = 0) => ({
    key,
    multiplier: 1,
    history: Array.from({ length: count }, (_, index) => ({
      date: new Date(Date.UTC(2025, 0, 1) + ((index - endOffsetDays) * 86_400_000)).toISOString().slice(0, 10),
      value: start + (index * step),
    })),
  });
  const model = calculateMacroRegimeModel([
    // NFCI stops 60 days before VIX does.
    daily('financialConditions', -0.2, 0.001, 240, 60),
    daily('highYieldSpread', 3.4, 0.002, 300),
    daily('vix', 16, 0.01, 300),
  ]);
  assert.equal(model.status !== 'unavailable', true);
  assert.equal(model.asOf, model.vintage.oldestInput.date);
  assert.equal(model.vintage.oldestInput.key, 'financialConditions');
  assert.equal(model.vintage.spreadDays >= 55, true, `spread was ${model.vintage.spreadDays}`);
  assert.match(model.vintage.note, /oldest input/);
});

test('a driver missing its change term scores on level alone and says so', () => {
  const short = (key, value) => ({ key, multiplier: 1, history: [{ date: '2025-06-02', value }] });
  const long = (key, start, step) => ({
    key,
    multiplier: 1,
    history: Array.from({ length: 300 }, (_, index) => ({
      date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
      value: start + (index * step),
    })),
  });
  // NFCI has one observation, so its 91-day change cannot be computed. The old
  // model treated that as "no change", which reads calm rather than unknown.
  const model = calculateMacroRegimeModel([short('financialConditions', 0.6), long('highYieldSpread', 3.4, 0.002), long('vix', 16, 0.01)]);
  assert.equal(model.partialDrivers.includes('Financial conditions'), true);
  const driver = model.drivers.find((entry) => entry.key === 'financialConditions');
  assert.equal(Number.isFinite(driver.score), true);
  // 50 - (0.6 * 40) = 26, with no change term added in either direction.
  assert.equal(driver.score, 26);
});

test('percentile prose does not print "2th"', () => {
  const day = (index) => new Date(Date.UTC(2018, 0, 1) + (index * 7 * 86_400_000)).toISOString().slice(0, 10);
  let level = 1_000_000;
  const points = Array.from({ length: 420 }, (_, index) => {
    level *= 1 + (0.004 * (1 + Math.sin(index / 40)));
    return { date: day(index), value: level };
  });
  const result = calculateLiquidityCyclePosition(points);
  assert.equal(/\b\d*[123]th\b/.test(result.read), false, `bad ordinal in: ${result.read}`);
  assert.match(result.read, /percentile of \d+ readings/);
});

test('a change over a window refuses a comparison point far outside it', () => {
  const day = (offset) => new Date(Date.UTC(2025, 0, 1) + (offset * 86_400_000)).toISOString().slice(0, 10);
  // Daily for four months, then an eight-month publication gap, then a few
  // fresh prints. Nothing inside 91 days of the latest print can answer a
  // 91-day question.
  const gapped = [
    ...Array.from({ length: 120 }, (_, index) => ({ date: day(index), value: 100 + (index * 0.1) })),
    ...Array.from({ length: 5 }, (_, index) => ({ date: day(370 + index), value: 180 + index })),
  ];
  assert.equal(measureChangeOverDays(gapped, 91), null);

  // The same series without the gap answers normally.
  const continuous = Array.from({ length: 200 }, (_, index) => ({ date: day(index), value: 100 + (index * 0.1) }));
  const measured = measureChangeOverDays(continuous, 91);
  assert.equal(measured.spanDays, 91);
  assert.equal(measured.fromDate, day(108));
  assert.equal(Math.abs(measured.absolute - 9.1) < 1e-9, true);
});

test('a monthly series is allowed to land off target, a gap is not', () => {
  const monthly = Array.from({ length: 24 }, (_, index) => ({
    date: new Date(Date.UTC(2024, index, 15)).toISOString().slice(0, 10),
    value: 100 * (1.004 ** index),
  }));
  const measured = measureChangeOverDays(monthly, 91);
  assert.ok(measured, 'a monthly series must still publish a quarterly change');
  // Three monthly steps back from the 15th is 90-92 days depending on the month.
  assert.equal(measured.spanDays >= 89 && measured.spanDays <= 93, true, `span was ${measured.spanDays}`);

  const quarterly = Array.from({ length: 8 }, (_, index) => ({
    date: new Date(Date.UTC(2024, index * 3, 15)).toISOString().slice(0, 10),
    value: 100 + index,
  }));
  // A quarterly series answering a 28-day question would have to reach a full
  // quarter back, which is not a 28-day change under a different name.
  assert.equal(measureChangeOverDays(quarterly, 28), null);
  // It answers a question at its own resolution normally.
  assert.ok(measureChangeOverDays(quarterly, 182));
});

test('the liquidity model refuses a driver whose window cannot be measured', () => {
  const day = (offset) => new Date(Date.UTC(2025, 0, 1) + (offset * 86_400_000)).toISOString().slice(0, 10);
  const full = (key, valueAt, multiplier = 1) => ({
    key,
    multiplier,
    history: Array.from({ length: 400 }, (_, index) => ({ date: day(index), value: valueAt(index) })),
  });
  const gappedM2 = {
    key: 'usM2',
    multiplier: 1,
    history: [
      ...Array.from({ length: 120 }, (_, index) => ({ date: day(index), value: 100 + (index * 0.1) })),
      ...Array.from({ length: 5 }, (_, index) => ({ date: day(370 + index), value: 180 + index })),
    ],
  };
  const model = calculateUsLiquidityModel([
    full('fedBalanceSheet', (index) => 7_000_000 + (index * 100)),
    full('treasuryGeneralAccount', () => 800_000),
    full('reverseRepo', () => 2_000),
    gappedM2,
    full('dxy', () => 110),
  ]);
  // Before the bound, this published a 251-day M2 change as a 91-day one, which
  // saturated the impulse and read as Expansion off a data outage.
  assert.equal(model.status, 'unavailable');
  assert.deepEqual(model.missing, ['US M2 growth']);
});

test('a flat balance sheet is not reported as an expanding one', () => {
  const flat = (key, value) => ({
    key,
    multiplier: 1,
    history: Array.from({ length: 120 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 3, 1) + (index * 86_400_000)).toISOString().slice(0, 10),
      value,
    })),
  });
  const model = calculateLiquidityRunway([flat('fedBalanceSheet', 7_000_000), flat('reverseRepo', 400_000)]);
  assert.equal(model.state, 'Balance sheet flat');
  assert.match(model.read, /has not moved/);
  assert.equal(model.runwayMonths, null, 'a flat facility has no exhaustion date');
});

test('liquidity transmission drops observations past the end of the asset history', () => {
  const weekly = Array.from({ length: 120 }, (_, index) => ({
    date: new Date(Date.UTC(2024, 0, 3) + (index * 7 * 86_400_000)).toISOString().slice(0, 10),
    value: 6_000_000 + (index * 8_000),
  }));
  // The asset feed stops halfway through. Carrying its last close forward would
  // add sixty flat bars and report far more observations than exist.
  const asset = Array.from({ length: 60 * 7 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2024, 0, 3) + (index * 86_400_000)).toISOString(),
    value: 100 + (index * 0.05),
  }));
  const model = buildLiquidityTransmission(weekly, asset, 'Test asset');
  if (model.status === 'calculated') {
    assert.ok(model.observations <= 60, `observations ${model.observations} exceeds the asset history`);
  } else {
    assert.match(model.reason, /aligned|overlapping/);
  }

  // With a complete asset history the same pair publishes normally.
  const full = Array.from({ length: 120 * 7 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2024, 0, 3) + (index * 86_400_000)).toISOString(),
    value: 100 + (index * 0.05),
  }));
  const complete = buildLiquidityTransmission(weekly, full, 'Test asset');
  assert.equal(complete.status, 'calculated');
  assert.equal(complete.observations > 60, true);
});

test('correlation windows are labelled by the cadence the pair actually shares', () => {
  const day = (offset) => new Date(Date.UTC(2024, 0, 1) + (offset * 86_400_000)).toISOString().slice(0, 10);
  const daily = Array.from({ length: 400 }, (_, index) => ({ date: day(index), value: 100 + Math.sin(index / 5) }));
  const dailyPair = calculateChangeCorrelations(daily, daily.map((point) => ({ ...point, value: point.value * 1.5 })));
  assert.equal(dailyPair.daily, true);
  assert.equal(dailyPair.windowLabels['20D'], '20 sessions');

  // A weekly series shares only its own dates, so twenty observations span
  // twenty weeks — the "20D" key alone reads as twenty sessions.
  const weekly = Array.from({ length: 120 }, (_, index) => ({ date: day(index * 7), value: 100 + Math.cos(index / 4) }));
  const weeklyPair = calculateChangeCorrelations(weekly, daily);
  assert.equal(weeklyPair.daily, false);
  assert.equal(weeklyPair.cadenceDays, 7);
  assert.match(weeklyPair.windowLabels['20D'], /about 20 weeks/);
  assert.match(weeklyPair.windowLabels['60D'], /about 60 weeks/);
});

test('the narrative refuses to report movement between two runs of the same vintage', () => {
  const output = (score, asOf) => ({ effective_at: asOf, output: { version: 'us-liquidity-v1', asOf, score, regime: 'Expansion' } });
  // Ingestion runs faster than FRED publishes, so consecutive runs routinely
  // read the same observations. Any score difference there is an artefact.
  const sameVintage = buildLiquidityNarrative([output(72, '2026-05-20'), output(69, '2026-05-20')], []);
  assert.equal(sameVintage.status, 'stable');
  assert.deepEqual(sameVintage.entries, []);
  assert.match(sameVintage.note, /same data vintage/);

  const moved = buildLiquidityNarrative([output(72, '2026-05-27'), output(69, '2026-05-20')], []);
  assert.equal(moved.status, 'updated');
  assert.match(moved.entries[0].text, /up 3 points to 72\/100 since the 2026-05-20 vintage/);
});

test('the narrative refuses to compare across a model version change', () => {
  const result = buildLiquidityNarrative([
    { effective_at: '2026-05-27', output: { version: 'us-liquidity-v2', asOf: '2026-05-27', score: 80, regime: 'Expansion' } },
    { effective_at: '2026-05-20', output: { version: 'us-liquidity-v1', asOf: '2026-05-20', score: 55, regime: 'Neutral' } },
  ], []);
  assert.equal(result.status, 'stable');
  assert.deepEqual(result.entries, []);
  assert.match(result.note, /model version changed/);
});

test('the global pool publishes its effective resolution, not just its print cadence', () => {
  const day = (offset) => new Date(Date.UTC(2024, 0, 3) + (offset * 86_400_000)).toISOString().slice(0, 10);
  const weekly = (key, start, step, multiplier = 1) => ({
    key,
    multiplier,
    history: Array.from({ length: 120 }, (_, index) => ({ date: day(index * 7), value: start + (index * step) })),
  });
  const monthlyLeg = (key, start, step) => ({
    key,
    multiplier: 1,
    history: Array.from({ length: 28 }, (_, index) => ({ date: day(index * 30), value: start + (index * step) })),
  });
  const daily = (key, start, step) => ({
    key,
    multiplier: 1,
    history: Array.from({ length: 840 }, (_, index) => ({ date: day(index), value: start + (index * step) })),
  });

  const model = calculateGlobalLiquidityModel([
    weekly('fedBalanceSheet', 7_000_000, 6_000),
    weekly('treasuryGeneralAccount', 800_000, -900),
    weekly('reverseRepo', 2_000, -6, 1000),
    daily('usM2', 20_000, 4),
    weekly('ecbBalanceSheet', 6_200_000, 4_000),
    // The BoJ leg publishes monthly, which is the binding resolution.
    monthlyLeg('bojBalanceSheet', 750_000, 3_000),
    daily('eurUsd', 1.08, 0.0001),
    daily('yenPerUsd', 148, 0.004),
    daily('dxy', 110, -0.01),
  ]);
  assert.equal(model.status, 'calculated');
  assert.equal(model.resolution.slowestLeg.key, 'boj');
  assert.equal(model.resolution.effectiveCadenceDays >= 28, true, `effective cadence ${model.resolution.effectiveCadenceDays}`);
  assert.equal(model.resolution.printCadenceDays < model.resolution.effectiveCadenceDays, true, 'the pool prints faster than its slowest leg moves');
  assert.match(model.resolution.read, /carried forward rather than re-measured/);
});

test('a shallow history cannot swing the trend weight the way a deep one can', () => {
  // Same latest bar, same visible price action: a shallow dip under the
  // 20-day inside a long uptrend. The only difference is how much history
  // sits behind it, which is not information about the trend.
  const bars = [];
  let value = 100;
  for (let index = 0; index < 300; index += 1) {
    value *= 1.0025;
    bars.push({ timestamp: new Date(Date.UTC(2020, 0, 1) + (index * 86_400_000)).toISOString(), value });
  }
  for (let index = 0; index < 6; index += 1) {
    value *= 0.9955;
    bars.push({ timestamp: new Date(Date.UTC(2020, 0, 1) + ((300 + index) * 86_400_000)).toISOString(), value });
  }

  const shallow = calculateTechnicalSnapshot(bars.slice(-30));
  const deep = calculateTechnicalSnapshot(bars);

  assert.equal(shallow.latest, deep.latest);
  assert.equal(shallow.components.trendAveragesUsed, 1);
  assert.equal(deep.components.trendAveragesUsed, 3);
  assert.equal(shallow.components.trendCoverage, 33);
  assert.equal(deep.components.trendCoverage, 100);

  // Both are below the 20-day, so both lean bearish on trend - but the
  // shallow one, which can only check the 20-day, must not lean as hard as
  // the deep one that checked three averages.
  assert.ok(shallow.components.trend > deep.components.trend - 40);
  assert.ok(Math.abs(shallow.score - deep.score) < 12, `scores drifted by ${Math.abs(shallow.score - deep.score)}`);
  assert.equal(shallow.regime, deep.regime);
});

test('volatility that cannot be measured is withheld rather than published as zero', () => {
  // A spread series crossing zero: log returns need positive prices at both
  // ends, so nothing is measurable here.
  const bars = [];
  for (let index = 0; index < 40; index += 1) {
    bars.push({
      timestamp: new Date(Date.UTC(2020, 0, 1) + (index * 86_400_000)).toISOString(),
      value: -0.5 + (Math.sin(index / 5) * 0.2),
    });
  }
  const snapshot = calculateTechnicalSnapshot(bars);

  assert.equal(snapshot.indicators.annualizedVolatility20d, null);
  // Unknown scores neutral. Awarding the calm score its maximum would have
  // read as the quietest possible tape.
  assert.equal(snapshot.components.volatilityQuality, 50);
});
