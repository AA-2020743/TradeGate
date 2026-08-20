import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBottomSignal, calculateBreadth, calculateEquityRegime, calculateSectorRotation, calculateTopRisk } from './equityAnalytics.js';

function technicalFixture(overrides = {}) {
  return {
    asOf: '2026-08-20T00:00:00.000Z',
    latest: 120,
    score: 76,
    components: { trend: 100, momentum: 72, volatilityQuality: 88 },
    indicators: { rsi14: 64, sma200: 100, annualizedVolatility20d: 12, macd: { histogram: 1 } },
    ...overrides,
  };
}

test('regime model is provisional when only market and liquidity inputs exist', () => {
  const model = calculateEquityRegime({ technical: technicalFixture(), liquidity: { score: 70, version: 'liquidity-test' } });
  assert.equal(model.version, 'equity-regime-v1');
  assert.equal(model.status, 'provisional');
  assert.equal(model.regime, 'Low-volatility expansion');
  assert.equal(model.coverage, 64);
  assert.equal(model.settings.holdingPeriod, '30-90 sessions');
});

test('regime model refuses to classify without mandatory technical inputs', () => {
  const model = calculateEquityRegime({ liquidity: { score: 70 } });
  assert.equal(model.status, 'unavailable');
  assert.equal(model.score, null);
  assert.equal(model.regime, null);
});

test('top and bottom models do not publish from technical and liquidity alone', () => {
  assert.equal(calculateTopRisk({ technical: technicalFixture(), liquidity: { score: 40 } }).status, 'unavailable');
  assert.equal(calculateBottomSignal({ technical: technicalFixture(), liquidity: { score: 60 } }).status, 'unavailable');
});

test('top risk publishes when breadth and independent confirmations cover the threshold', () => {
  const model = calculateTopRisk({
    technical: technicalFixture(),
    breadth: { topRisk: 80, source: 'test' },
    sentiment: { euphoria: 90, source: 'test' },
  });
  assert.equal(model.status, 'calculated');
  assert.ok(model.score >= 50);
});

test('breadth calculates participation from constituent histories', () => {
  const constituents = Array.from({ length: 30 }, (_, constituentIndex) => ({
    symbol: `C${constituentIndex}`,
    points: Array.from({ length: 260 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
      value: 100 + (index * (constituentIndex < 24 ? 0.2 : -0.05)) + Math.sin(index / 7),
    })),
  }));
  const breadth = calculateBreadth(constituents);
  assert.equal(breadth.status, 'calculated');
  assert.equal(breadth.constituents, 30);
  assert.ok(breadth.percentAbove.dma50 > 50);
  assert.ok(Number.isFinite(breadth.mcClellan.oscillator));
  assert.ok(breadth.unavailable.includes('Advance/Decline Volume'));
});

test('breadth reports unavailable when constituent coverage is too small', () => {
  const breadth = calculateBreadth([{ symbol: 'A', points: [] }]);
  assert.equal(breadth.status, 'unavailable');
  assert.equal(breadth.minimumConstituents, 20);
});

test('sector rotation ranks relative strength without fabricating missing sectors', () => {
  const points = (step) => Array.from({ length: 260 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    value: 100 + (index * step) + Math.sin(index / 8),
  }));
  const rotation = calculateSectorRotation([
    { symbol: 'XLK', name: 'Technology', points: points(0.5) },
    { symbol: 'XLU', name: 'Utilities', points: points(0.1) },
    { symbol: 'XLE', name: 'Energy', points: [] },
  ], points(0.25));
  assert.equal(rotation.status, 'partial');
  assert.equal(rotation.sectors.length, 2);
  assert.equal(rotation.sectors[0].symbol, 'XLK');
  assert.equal(rotation.sectors[0].rank, 1);
  assert.deepEqual(rotation.missing, ['1 sector histories']);
});
