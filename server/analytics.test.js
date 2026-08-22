import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAtomFeed, buildHeatmapRow, buildLiquidityNarrative, buildLiquidityTransmission, buildWorkspaceNarrative, calculateChangeCorrelations, calculateDollarScenarios, calculateDollarTransmissionRead, calculateLeadLag, calculatePositioningModel, calculateCrossMarketRelationship, calculateGlobalLiquidityModel, calculateMacroRegimeModel, calculateRsi, calculateScreenerScores, calculateSeriesLeadLag, calculateTechnicalSnapshot, calculateTrendQuality, classifyHeadlineSentiment, calculateUsdStrengthModel, calculateUsLiquidityModel, escapeXml, pearsonCorrelation } from './analytics.js';

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
