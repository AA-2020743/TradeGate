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

test('partial breadth does not contribute full-strength parent signals', () => {
  const regime = calculateEquityRegime({
    technical: technicalFixture(),
    liquidity: { score: 70, version: 'liquidity-test' },
    breadth: { status: 'partial', score: 100, source: 'test' },
  });
  assert.equal(regime.coverage, 64);
  const top = calculateTopRisk({
    technical: technicalFixture(),
    breadth: { status: 'partial', topRisk: 100, source: 'test' },
    sentiment: { euphoria: 100, source: 'test' },
  });
  assert.equal(top.status, 'unavailable');
});

test('top and bottom models do not publish from technical and liquidity alone', () => {
  assert.equal(calculateTopRisk({ technical: technicalFixture(), liquidity: { score: 40 } }).status, 'unavailable');
  const bottom = calculateBottomSignal({ technical: technicalFixture(), liquidity: { score: 60 } });
  assert.equal(bottom.status, 'unavailable');
  assert.equal(bottom.bearMarketRallyRisk, null);
});

test('top risk publishes when breadth and independent confirmations cover the threshold', () => {
  const model = calculateTopRisk({
    technical: technicalFixture(),
    breadth: { status: 'calculated', topRisk: 80, source: 'test' },
    sentiment: { euphoria: 90, source: 'test' },
  });
  assert.equal(model.status, 'calculated');
  assert.ok(model.score >= 50);
});

test('bottom model does not claim normal rally risk without a long trend', () => {
  const model = calculateBottomSignal({
    technical: technicalFixture({ indicators: { rsi14: 35, sma200: null, annualizedVolatility20d: 12, macd: { histogram: 1 } } }),
    breadth: { status: 'calculated', bottomScore: 75, source: 'test' },
    sentiment: { pessimism: 80, source: 'test' },
  });
  assert.equal(model.status, 'calculated');
  assert.equal(model.bearMarketRallyRisk, null);
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
  assert.equal(breadth.coverage, 100);
  assert.ok(breadth.percentAbove.dma50 > 50);
  assert.ok(Number.isFinite(breadth.mcClellan.oscillator));
  assert.ok(breadth.unavailable.includes('Advance/Decline Volume'));
});

test('breadth reports unavailable when constituent coverage is too small', () => {
  const breadth = calculateBreadth([{ symbol: 'A', points: [] }]);
  assert.equal(breadth.status, 'unavailable');
  assert.equal(breadth.minimumConstituents, 20);
});

test('breadth keeps unavailable long-horizon metrics out of short-history denominators', () => {
  const constituents = Array.from({ length: 30 }, (_, constituentIndex) => ({
    symbol: `S${constituentIndex}`,
    points: Array.from({ length: 60 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      value: 100 + index + (constituentIndex / 100),
    })),
  }));
  const breadth = calculateBreadth(constituents);
  assert.equal(breadth.status, 'partial');
  assert.equal(breadth.percentAbove.dma50, 100);
  assert.equal(breadth.percentAbove.dma200, null);
  assert.equal(breadth.newHighs, null);
  assert.equal(breadth.score, 100);
  assert.ok(breadth.unavailable.includes('% above 200DMA'));
});

test('breadth requires expected-universe coverage for every horizon', () => {
  const endingAt = new Date('2026-08-20T00:00:00.000Z').getTime();
  const history = (length, step) => Array.from({ length }, (_, index) => ({
    timestamp: new Date(endingAt - ((length - index - 1) * 86_400_000)).toISOString(),
    value: 100 + (index * step),
  }));
  const constituents = Array.from({ length: 70 }, (_, index) => ({
    symbol: `M${index}`,
    points: history(index === 0 ? 260 : 60, 0.1),
  }));
  const breadth = calculateBreadth(constituents, { expectedConstituents: 100 });
  assert.equal(breadth.status, 'partial');
  assert.equal(breadth.minimumConstituents, 70);
  assert.equal(breadth.metricCoverage.dma200, 1);
  assert.equal(breadth.percentAbove.dma200, null);
  assert.equal(breadth.scoreCoverage, 55);
});

test('breadth remains partial below calculated-universe coverage', () => {
  const constituents = Array.from({ length: 25 }, (_, constituentIndex) => ({
    symbol: `U${constituentIndex}`,
    points: Array.from({ length: 260 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
      value: 100 + index + (constituentIndex / 100),
    })),
  }));
  const breadth = calculateBreadth(constituents, { expectedConstituents: 30 });
  assert.equal(breadth.scoreCoverage, 100);
  assert.equal(breadth.coverage, 83);
  assert.equal(breadth.status, 'partial');
});

test('breadth excludes constituents missing the synchronized latest date', () => {
  const endingAt = new Date('2026-08-20T00:00:00.000Z').getTime();
  const history = (end, step) => Array.from({ length: 60 }, (_, index) => ({
    timestamp: new Date(end - ((59 - index) * 86_400_000)).toISOString(),
    value: 200 + (index * step),
  }));
  const constituents = Array.from({ length: 30 }, (_, index) => ({
    symbol: `T${index}`,
    points: index < 21 ? history(endingAt, -1) : history(endingAt - 86_400_000, 1),
  }));
  const breadth = calculateBreadth(constituents);
  assert.equal(breadth.asOf, '2026-08-20');
  assert.equal(breadth.constituents, 21);
  assert.equal(breadth.coverage, 70);
  assert.equal(breadth.percentAbove.dma20, 0);
});

test('breadth compares duplicate-date closes with the prior distinct session', () => {
  const constituents = Array.from({ length: 30 }, (_, constituentIndex) => {
    const points = Array.from({ length: 60 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      value: 100 + index + (constituentIndex / 100),
    }));
    points.push({ timestamp: points.at(-1).timestamp, value: points.at(-2).value });
    return { symbol: `D${constituentIndex}`, points };
  });
  const breadth = calculateBreadth(constituents);
  assert.equal(breadth.advanceDecline.advances, 0);
  assert.equal(breadth.advanceDecline.declines, 0);
});

test('breadth thrust includes unchanged constituents in participation', () => {
  const constituents = Array.from({ length: 30 }, (_, constituentIndex) => ({
    symbol: `P${constituentIndex}`,
    points: Array.from({ length: 60 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      value: constituentIndex === 0 ? 100 + index : 100,
    })),
  }));
  const breadth = calculateBreadth(constituents);
  assert.ok(breadth.breadthThrust > 3 && breadth.breadthThrust < 4);
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
