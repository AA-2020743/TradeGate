import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCrossMarketRelationship, calculateMacroRegimeModel, calculateRsi, calculateTechnicalSnapshot, calculateUsdStrengthModel, calculateUsLiquidityModel, pearsonCorrelation } from './analytics.js';

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
  assert.ok(model.missing.includes('10Y real-yield impulse'));
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
  assert.equal(model.coverage, 100);
  assert.equal(model.regime, 'Expansion / risk-on');
  assert.equal(model.settings.riskBudget, 'High');
});

test('macro regime refuses a single-sleeve classification', () => {
  const model = calculateMacroRegimeModel([], { score: 70, version: 'liquidity-test' });
  assert.equal(model.status, 'unavailable');
  assert.equal(model.regime, null);
});
