import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHeatmapRow, buildLiquidityNarrative, buildWorkspaceNarrative, calculateChangeCorrelations, calculatePositioningModel, calculateCrossMarketRelationship, calculateGlobalLiquidityModel, calculateMacroRegimeModel, calculateRsi, calculateTechnicalSnapshot, calculateUsdStrengthModel, calculateUsLiquidityModel, pearsonCorrelation } from './analytics.js';

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
});

test('US liquidity model refuses to publish with a missing mandatory driver', () => {
  const history = Array.from({ length: 30 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, 1 + (index * 7))).toISOString().slice(0, 10),
    value: 100 + index,
  }));
  assert.equal(calculateUsLiquidityModel([
    { key: 'usM2', multiplier: 1, history },
    { key: 'dxy', multiplier: 1, history },
  ]), null);
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
  assert.ok(Number.isFinite(model.cyclePercentile));
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
  assert.equal(calculateGlobalLiquidityModel([
    weekly('fedBalanceSheet', 7_000_000, 20_000),
    weekly('treasuryGeneralAccount', 800_000, -5_000),
    { ...weekly('reverseRepo', 2_000, -15), multiplier: 1000 },
    { ...weekly('usM2', 20_000, 30), multiplier: 1000 },
    weekly('ecbBalanceSheet', 6_200_000, 15_000),
    weekly('bojBalanceSheet', 750_000, 2_000),
    weekly('dxy', 110, -0.15),
  ]), null);
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
  assert.equal(model.coverage, 100);
  assert.ok(model.score > 50);
  assert.equal(model.history.length, 300);
  assert.match(model.proxy, /not the ICE DXY/);
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
