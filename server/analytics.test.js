import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCrossMarketRelationship, calculateRsi, calculateTechnicalSnapshot, calculateUsLiquidityModel, pearsonCorrelation } from './analytics.js';

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
