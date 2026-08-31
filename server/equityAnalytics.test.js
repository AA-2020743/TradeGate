import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBasketRotation, calculateBreadthConcentration, calculateExpectedMove, calculateBottomSignal, calculateBreadth, calculateBreadthDivergence, calculateCaptureProfile, calculateDrawdownProfile, calculateEquityRegime, calculateMacroSensitivities, calculateRevisionBreadth, calculateSectorBreadthProxy, calculateSectorDispersion, calculateSectorRotation, calculateTopRisk, calculateVolatilityTermStructure, rrgQuadrant } from './equityAnalytics.js';

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

test('partial breadth is used but marks the parent signal provisional', () => {
  // Breadth on a narrower universe is still evidence. Discarding it entirely
  // took the whole model down with it, because breadth is a mandatory leg -
  // a worse outcome than a disclosed provisional read.
  const regime = calculateEquityRegime({
    technical: technicalFixture(),
    liquidity: { score: 70, version: 'liquidity-test' },
    breadth: { status: 'partial', score: 100, source: 'test' },
  });
  assert.equal(regime.coverage, 82);
  assert.equal(regime.status, 'provisional');
  assert.equal(regime.breadthPartial, true);

  const top = calculateTopRisk({
    technical: technicalFixture(),
    breadth: { status: 'partial', topRisk: 100, source: 'test' },
    sentiment: { euphoria: 100, source: 'test' },
  });
  assert.equal(top.status, 'provisional');
  assert.equal(top.breadthPartial, true);
  assert.equal(Number.isFinite(top.score), true);
});

test('breadth carrying no score at all is still discarded', () => {
  const top = calculateTopRisk({
    technical: technicalFixture(),
    breadth: { status: 'partial', topRisk: null, score: null, bottomScore: null, source: 'test' },
    sentiment: { euphoria: 100, source: 'test' },
  });
  assert.equal(top.status, 'unavailable');
  assert.equal(top.breadthPartial, false);
});

test('fully calculated breadth leaves the parent signal calculated', () => {
  const regime = calculateEquityRegime({
    technical: technicalFixture(),
    liquidity: { score: 70, version: 'liquidity-test' },
    breadth: { status: 'calculated', score: 100, source: 'test' },
  });
  assert.equal(regime.status, 'calculated');
  assert.equal(regime.breadthPartial, false);
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
test('sector rotation carries group labels for subsectors', () => {
  const points = (step) => Array.from({ length: 260 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    value: 100 + (index * step) + Math.sin(index / 8),
  }));
  const rotation = calculateSectorRotation([
    { symbol: 'XLK', name: 'Technology', points: points(0.5) },
    { symbol: 'SOXX', name: 'Semiconductors', group: 'Technology', points: points(0.6) },
  ], points(0.25));
  assert.equal(rotation.status, 'calculated');
  assert.equal(rotation.sectors[0].group, 'Technology');
});

test('macro sensitivities correlate ETF changes against FRED histories', () => {
  const etfPoints = Array.from({ length: 120 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
    value: 100 + index + Math.sin(index / 4),
  }));
  const dollarHistory = etfPoints.map((point) => ({ date: point.date, value: 100 - ((point.value - 100) * 0.2) }));
  const empty = calculateMacroSensitivities(etfPoints, { dollar: dollarHistory, realYield: [], vix: [], credit: [] });
  assert.ok(empty.dollar < 0);
  assert.equal(empty.realYield, null);
  assert.equal(empty.vix, null);
  assert.equal(empty.credit, null);
});
test('basket rotation computes synchronized basket spreads', () => {
  const points = (step, drift = 0) => Array.from({ length: 120 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    value: 100 + (index * step) + (drift * Math.sin(index / 6)),
  }));
  const histories = new Map([
    ['QQQ', points(0.5)],
    ['DIA', points(0.1)],
    ['XLY', points(0.4)],
    ['XLP', points(0.05)],
  ]);
  const styles = calculateBasketRotation([
    { key: 'growthValue', leftName: 'Growth', rightName: 'Value', leftSymbols: ['QQQ'], rightSymbols: ['DIA'], leftLeader: 'Growth', rightLeader: 'Value' },
    { key: 'cyclicalDefensive', leftName: 'Cyclicals', rightName: 'Defensives', leftSymbols: ['XLY', 'MISSING'], rightSymbols: ['XLP'], leftLeader: 'Cyclicals', rightLeader: 'Defensives' },
  ], histories);
  assert.equal(styles.version, 'style-rotation-v1');
  assert.equal(styles.status, 'calculated');
  const growthValue = styles.pairs.find((pair) => pair.key === 'growthValue');
  assert.equal(growthValue.status, 'calculated');
  assert.ok(growthValue.spread60 > 15);
  assert.equal(growthValue.leader, 'Growth');
  const cyclical = styles.pairs.find((pair) => pair.key === 'cyclicalDefensive');
  assert.equal(cyclical.status, 'unavailable');
  assert.deepEqual(cyclical.missing, ['MISSING']);
});

// A benchmark that compounds steadily, and sectors whose excess return is
// steered by a per-session multiplier so a known quadrant path can be built.
function benchmarkSeries(length = 260) {
  return Array.from({ length }, (_, index) => ({
    timestamp: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    value: 100 * (1.0003 ** index),
  }));
}

function sectorFrom(benchmark, excessPerSession) {
  let value = 100;
  return benchmark.map((point, index) => {
    if (index > 0) {
      const benchmarkReturn = point.value / benchmark[index - 1].value;
      value *= benchmarkReturn * (1 + excessPerSession(index));
    }
    return { timestamp: point.timestamp, value };
  });
}

test('the quadrant rule reads level from 60 sessions and build from 20', () => {
  assert.equal(rrgQuadrant(2, 5), 'Leading');
  assert.equal(rrgQuadrant(-2, 5), 'Weakening');
  assert.equal(rrgQuadrant(2, -5), 'Improving');
  assert.equal(rrgQuadrant(-2, -5), 'Lagging');
  assert.equal(rrgQuadrant(null, 5), null);
  assert.equal(rrgQuadrant(2, Number.NaN), null);
});

test('a sector rotating into leadership is distinguished from one holding it', () => {
  const benchmark = benchmarkSeries();
  // Trails all year, then turns up sharply over the closing sessions.
  const turningUp = sectorFrom(benchmark, (index) => (index > 245 ? 0.006 : -0.0012));
  const alwaysAhead = sectorFrom(benchmark, () => 0.0012);
  const rotation = calculateSectorRotation([
    { symbol: 'TURN', name: 'Turning up', points: turningUp },
    { symbol: 'HOLD', name: 'Steady leader', points: alwaysAhead },
  ], benchmark);

  const turn = rotation.sectors.find((sector) => sector.symbol === 'TURN');
  assert.equal(turn.quadrant, 'Leading');
  assert.equal(turn.rotation.moved, true);
  assert.equal(turn.rotation.previousQuadrant, 'Lagging');
  assert.equal(turn.rotation.path, 'Lagging → Leading');
  assert.equal(turn.rotation.direction, 'Strengthening');
  assert.ok(turn.rotation.relativeShift > 0);

  const hold = rotation.sectors.find((sector) => sector.symbol === 'HOLD');
  assert.equal(hold.rotation.moved, false);
  assert.equal(hold.rotation.path, 'Holding Leading');
});

test('a sector rolling out of leadership reports the transition and fading shift', () => {
  const benchmark = benchmarkSeries();
  // Led all year, then gives ground back — still ahead over 60 sessions,
  // already behind over 20.
  const rollingOver = sectorFrom(benchmark, (index) => (index > 245 ? -0.003 : 0.0015));
  const rotation = calculateSectorRotation([{ symbol: 'ROLL', name: 'Rolling over', points: rollingOver }], benchmark);
  const roll = rotation.sectors[0];
  assert.equal(roll.rotation.previousQuadrant, 'Leading');
  assert.equal(roll.quadrant, 'Weakening');
  assert.equal(roll.rotation.path, 'Leading → Weakening');
  assert.equal(roll.rotation.direction, 'Fading');
  assert.ok(roll.rotation.relativeShift < 0);
});

test('the workspace names which sectors entered and left leadership', () => {
  const benchmark = benchmarkSeries();
  const rotation = calculateSectorRotation([
    { symbol: 'TURN', name: 'Turning up', points: sectorFrom(benchmark, (index) => (index > 245 ? 0.006 : -0.0012)) },
    { symbol: 'ROLL', name: 'Rolling over', points: sectorFrom(benchmark, (index) => (index > 245 ? -0.003 : 0.0015)) },
    { symbol: 'HOLD', name: 'Steady leader', points: sectorFrom(benchmark, () => 0.0012) },
  ], benchmark);
  assert.equal(rotation.rotationLookbackSessions, 20);
  assert.deepEqual(rotation.enteringLeadership, ['TURN']);
  assert.deepEqual(rotation.leavingLeadership, ['ROLL']);
});

test('a history too short for the lookback withholds the trajectory', () => {
  const benchmark = benchmarkSeries(70);
  const rotation = calculateSectorRotation([
    { symbol: 'SHORT', name: 'Short history', points: sectorFrom(benchmark, () => 0.001) },
  ], benchmark);
  assert.equal(rotation.sectors.length, 1);
  assert.equal(rotation.sectors[0].quadrant, 'Leading');
  assert.equal(rotation.sectors[0].rotation, null);
  assert.deepEqual(rotation.enteringLeadership, []);
});

const rising = (length, step) => Array.from({ length }, (_, index) => 100 + (index * step));

test('a rally the advance/decline line stops confirming is a negative divergence', () => {
  // Price keeps climbing; the A/D line peaks two-thirds of the way through.
  const price = rising(60, 1);
  const breadth = Array.from({ length: 60 }, (_, index) => (index < 40 ? index * 2 : 80 - ((index - 40) * 3)));
  const result = calculateBreadthDivergence(breadth, price);
  assert.equal(result.state, 'Negative divergence');
  assert.equal(result.divergent, true);
  assert.equal(result.pricePercentile, 100);
  assert.ok(result.gap >= 20);
  assert.match(result.read, /fewer names are carrying the advance/);
});

test('a rally participation keeps up with is reported as confirmed', () => {
  const result = calculateBreadthDivergence(rising(60, 2), rising(60, 1));
  assert.equal(result.state, 'Breadth confirms the high');
  assert.equal(result.divergent, false);
  assert.equal(result.gap, 0);
});

test('a decline fewer names are joining is a positive divergence', () => {
  const price = rising(60, -1);
  const breadth = Array.from({ length: 60 }, (_, index) => (index < 40 ? -index * 2 : -80 + ((index - 40) * 3)));
  const result = calculateBreadthDivergence(breadth, price);
  assert.equal(result.state, 'Positive divergence');
  assert.equal(result.divergent, true);
  assert.ok(result.pricePercentile <= 5);
  assert.ok(result.gap <= -20);
  assert.match(result.read, /fewer names are making the new lows/);
});

test('a broad decline is reported as confirmed rather than divergent', () => {
  const result = calculateBreadthDivergence(rising(60, -2), rising(60, -1));
  assert.equal(result.state, 'Breadth confirms the low');
  assert.equal(result.divergent, false);
});

test('a mid-range index carries no divergence message', () => {
  const price = Array.from({ length: 60 }, (_, index) => 100 + Math.sin(index / 5) * 10);
  const breadth = Array.from({ length: 60 }, (_, index) => index * 2);
  const result = calculateBreadthDivergence(breadth, price);
  assert.equal(result.state, 'No divergence signal');
  assert.equal(result.divergent, false);
  assert.match(result.read, /mid-range/);
});

test('divergence withholds a reading without enough aligned sessions', () => {
  const short = calculateBreadthDivergence(rising(30, 1), rising(30, 1));
  assert.equal(short.status, 'unavailable');
  assert.equal(short.observations, 30);
  assert.match(short.reason, /40 aligned sessions/);
  assert.equal(calculateBreadthDivergence([], []).status, 'unavailable');
  assert.equal(calculateBreadthDivergence(null, null).status, 'unavailable');
});

test('divergence aligns on the shorter of the two series and ignores gaps', () => {
  const result = calculateBreadthDivergence(rising(200, 1), rising(45, 1));
  assert.equal(result.observations, 45);
  assert.equal(result.status, 'calculated');
  const withHoles = calculateBreadthDivergence([...rising(50, 1), Number.NaN, null], rising(50, 1));
  assert.equal(withHoles.observations, 50);
});

test('percentile readings are written with the right ordinal suffix', () => {
  const readFor = (priceStep, breadthValues) => calculateBreadthDivergence(breadthValues, rising(60, priceStep)).read;
  // 1st, 2nd, 3rd and the 11th-13th exceptions must not read "1th" or "11st".
  const samples = [
    readFor(-1, Array.from({ length: 60 }, (_, index) => (index < 40 ? -index * 2 : -80 + ((index - 40) * 3)))),
    readFor(1, Array.from({ length: 60 }, (_, index) => (index < 40 ? index * 2 : 80 - ((index - 40) * 3)))),
  ];
  for (const read of samples) {
    assert.doesNotMatch(read, /\b\d*1th|\b\d*2th|\b\d*3th\b/);
    assert.doesNotMatch(read, /1[123](st|nd|rd)\b/);
    assert.match(read, /\d+(st|nd|rd|th) percentile|\d+(st|nd|rd|th)\b/);
  }
  assert.match(readFor(1, rising(60, 2)), /100th percentile/);
});

test('macro sensitivities keep their numeric shape for existing readers', () => {
  const etf = Array.from({ length: 200 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
    value: 100 + index + Math.sin(index / 4),
  }));
  const dollar = etf.map((point) => ({ date: point.date, value: 100 - ((point.value - 100) * 0.2) }));
  const result = calculateMacroSensitivities(etf, { dollar, realYield: [], vix: [], credit: [] });
  assert.ok(result.dollar < 0);
  assert.equal(result.realYield, null);
  assert.equal(result.dollar, result.detail.dollar.correlation);
});

test('a daily driver reports its window in sessions', () => {
  const etf = Array.from({ length: 200 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
    value: 100 + index + Math.sin(index / 5),
  }));
  const vix = etf.map((point, index) => ({ date: point.date, value: 20 + Math.cos(index / 6) * 4 }));
  const detail = calculateMacroSensitivities(etf, { dollar: [], realYield: [], vix, credit: [] }).detail.vix;
  assert.equal(detail.status, 'calculated');
  assert.equal(detail.daily, true);
  assert.equal(detail.cadenceDays, 1);
  assert.equal(detail.windowLabel, '60 sessions');
  assert.ok(detail.observations >= 60);
});

test('a weekly driver says so instead of claiming sixty days', () => {
  // A weekly driver needs sixty weeks of overlap, so the ETF history has to
  // stretch well past a year for the window to fill at all.
  const etf = Array.from({ length: 520 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
    value: 100 + index + Math.sin(index / 5),
  }));
  // NFCI-style weekly cadence: only every seventh date is published.
  const weekly = etf.filter((_, index) => index % 7 === 0).map((point, index) => ({ date: point.date, value: -0.3 + Math.sin(index / 3) * 0.2 }));
  const detail = calculateMacroSensitivities(etf, { dollar: [], realYield: [], vix: [], credit: weekly }).detail.credit;
  assert.equal(detail.status, 'calculated');
  assert.equal(detail.daily, false);
  assert.equal(detail.cadenceDays, 7);
  assert.match(detail.windowLabel, /60 observations, about \d+ weeks/);
  // Sixty weekly observations is well over a year, not sixty days.
  assert.equal(detail.windowLabel, '60 observations, about 60 weeks');
});

test('a weekly driver short of sixty weeks is withheld rather than published thin', () => {
  const etf = Array.from({ length: 400 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
    value: 100 + index,
  }));
  const weekly = etf.filter((_, index) => index % 7 === 0).map((point, index) => ({ date: point.date, value: index % 5 }));
  const detail = calculateMacroSensitivities(etf, { dollar: [], realYield: [], vix: [], credit: weekly }).detail.credit;
  assert.equal(detail.status, 'unavailable');
  assert.equal(detail.cadenceDays, 7);
  assert.ok(detail.observations < 60);
});

test('a driver without enough aligned changes is unavailable and says why', () => {
  const etf = Array.from({ length: 200 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
    value: 100 + index,
  }));
  const sparse = etf.slice(0, 30).map((point) => ({ date: point.date, value: 1 }));
  const detail = calculateMacroSensitivities(etf, { dollar: sparse, realYield: [], vix: [], credit: [] }).detail;
  assert.equal(detail.dollar.status, 'unavailable');
  assert.equal(detail.dollar.correlation, null);
  assert.equal(detail.dollar.windowLabel, null);
  assert.match(detail.dollar.reason, /Fewer than 60 aligned changes/);
  assert.equal(detail.realYield.reason, 'No driver history.');
});

const riskBreadth = { status: 'calculated', topRisk: 50, bottomScore: 50, source: 'stub' };
const riskSentiment = { euphoria: 50, pessimism: 50, source: 'stub' };
const technicalLeg = (model) => model.drivers.find((driver) => driver.key === 'technical').score;

test('a missing 200-day average or MACD no longer reads as calm', () => {
  const overbought = { asOf: '2026-08-20', latest: 120, indicators: { rsi14: 78, sma200: 100, macd: { histogram: -1 } } };
  const withoutMacd = { asOf: '2026-08-20', latest: 120, indicators: { rsi14: 78, sma200: 100 } };
  const full = calculateTopRisk({ technical: overbought, breadth: riskBreadth, sentiment: riskSentiment });
  const partial = calculateTopRisk({ technical: withoutMacd, breadth: riskBreadth, sentiment: riskSentiment });
  // The same overbought tape must not read as less risky merely for missing a leg.
  assert.ok(technicalLeg(partial) >= technicalLeg(full), `${technicalLeg(partial)} < ${technicalLeg(full)}`);
});

test('one technical indicator alone cannot carry a risk read', () => {
  const rsiOnly = { asOf: '2026-08-20', latest: 120, indicators: { rsi14: 78 } };
  const risk = calculateTopRisk({ technical: rsiOnly, breadth: riskBreadth, sentiment: riskSentiment });
  assert.equal(technicalLeg(risk), null);
  assert.equal(risk.status, 'unavailable');
  assert.equal(risk.score, null);
  assert.ok(risk.missing.includes('Technical deterioration'));
});

test('the bottom signal drops absent legs instead of scoring them unwashed', () => {
  const washedOut = { asOf: '2026-08-20', latest: 80, indicators: { rsi14: 22, sma200: 100, macd: { histogram: 1 } } };
  const withoutMacd = { asOf: '2026-08-20', latest: 80, indicators: { rsi14: 22, sma200: 100 } };
  const full = calculateBottomSignal({ technical: washedOut, breadth: riskBreadth, sentiment: riskSentiment });
  const partial = calculateBottomSignal({ technical: withoutMacd, breadth: riskBreadth, sentiment: riskSentiment });
  assert.ok(technicalLeg(partial) >= technicalLeg(full), `${technicalLeg(partial)} < ${technicalLeg(full)}`);

  const rsiOnly = calculateBottomSignal({ technical: { asOf: '2026-08-20', latest: 80, indicators: { rsi14: 22 } }, breadth: riskBreadth, sentiment: riskSentiment });
  assert.equal(technicalLeg(rsiOnly), null);
  assert.equal(rsiOnly.status, 'unavailable');
});

test('a zero or missing price does not turn the discount leg into a division artefact', () => {
  for (const latest of [0, null, undefined, Number.NaN]) {
    const model = calculateBottomSignal({
      technical: { asOf: '2026-08-20', latest, indicators: { rsi14: 22, sma200: 100, macd: { histogram: 1 } } },
      breadth: riskBreadth,
      sentiment: riskSentiment,
    });
    const leg = technicalLeg(model);
    assert.ok(leg === null || Number.isFinite(leg), `leg was ${leg} for latest ${latest}`);
  }
});

test('two of three legs is enough, and both risk models agree on that threshold', () => {
  const twoLegs = { asOf: '2026-08-20', latest: 120, indicators: { rsi14: 70, macd: { histogram: -1 } } };
  assert.ok(Number.isFinite(technicalLeg(calculateTopRisk({ technical: twoLegs, breadth: riskBreadth, sentiment: riskSentiment }))));
  assert.ok(Number.isFinite(technicalLeg(calculateBottomSignal({ technical: twoLegs, breadth: riskBreadth, sentiment: riskSentiment }))));
});

// Two baskets over 120 sessions, driven by per-session compounding rates.
const basketPair = { key: 'style', leftSymbols: ['L'], rightSymbols: ['R'], leftName: 'Growth', rightName: 'Value', leftLeader: 'Growth', rightLeader: 'Value' };
const basketDates = Array.from({ length: 120 }, (_, index) => new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10));
const basketSeries = (valueAt) => basketDates.map((date, index) => ({ date, value: valueAt(index) }));
const rotationFor = (leftAt, rightAt) => calculateBasketRotation([basketPair], new Map([
  ['L', basketSeries(leftAt)], ['R', basketSeries(rightAt)],
])).pairs[0];

test('a basket ahead over 60 sessions but behind over 20 is reported as changing hands', () => {
  // Growth compounds all year; Value is flat then rises over the last 20.
  const pair = rotationFor((index) => 100 * (1.0009 ** index), (index) => 100 * (index > 99 ? 1.0017 ** (index - 99) : 1));
  assert.ok(pair.spread60 > 1, `spread60 ${pair.spread60}`);
  assert.ok(pair.spread20 < -1, `spread20 ${pair.spread20}`);
  assert.equal(pair.rotating, true);
  assert.equal(pair.established, 'Growth');
  assert.equal(pair.emerging, 'Value');
  assert.equal(pair.regime, 'Growth leading, Value taking over');
  assert.match(pair.read, /changing hands/);
});

test('both windows agreeing names a single leader with no handoff', () => {
  const pair = rotationFor((index) => 100 * (1.0012 ** index), () => 100);
  assert.equal(pair.rotating, false);
  assert.equal(pair.emerging, null);
  assert.equal(pair.regime, 'Growth leading');
  assert.equal(pair.leader, 'Growth');
  assert.match(pair.read, /both windows pointing the same way/);
});

test('two baskets moving together are balanced rather than given a leader', () => {
  const pair = rotationFor((index) => 100 * (1.0008 ** index), (index) => 100 * (1.0008 ** index));
  assert.equal(pair.regime, 'Balanced');
  assert.equal(pair.leader, null);
  assert.equal(pair.established, null);
  assert.match(pair.read, /Neither basket leads/);
});

test('a decisive recent move with a flat longer window names the recent leader', () => {
  // Nothing separates them over 60 sessions; Value pulls ahead over the last 20.
  const pair = rotationFor(() => 100, (index) => 100 * (index > 99 ? 1.0012 ** (index - 99) : 1));
  assert.ok(Math.abs(pair.spread20) >= 1);
  assert.equal(pair.rotating, false);
  assert.equal(pair.leader, 'Value');
  assert.equal(pair.regime, 'Value leading');
});

test('a basket missing a member publishes nothing rather than a partial spread', () => {
  const out = calculateBasketRotation([basketPair], new Map([['L', basketSeries((index) => 100 + index)]]));
  assert.equal(out.pairs[0].status, 'unavailable');
  assert.equal(out.status, 'unavailable');
});

function dailySeries(length, valueAt, startYear = 2024) {
  return Array.from({ length }, (_, index) => ({
    timestamp: new Date(Date.UTC(startYear, 0, index + 1)).toISOString(),
    value: valueAt(index),
  }));
}

test('the participation proxy never computes a 200-day line from fewer than 200 closes', () => {
  const short = Array.from({ length: 6 }, (_, sector) => ({
    symbol: `S${sector}`,
    points: dailySeries(90, (index) => 100 + index + sector).map((point) => ({ date: point.timestamp.slice(0, 10), value: point.value })),
  }));
  const proxy = calculateSectorBreadthProxy(short);
  assert.equal(proxy.version, 'sector-breadth-proxy-v2');
  assert.equal(proxy.status, 'provisional');
  assert.equal(proxy.pctAbove50, 100);
  assert.equal(proxy.pctAbove200, null, 'a 90-close average must not be published as the 200-day line');
  assert.equal(proxy.eligible.above200, 0);
  assert.match(proxy.missing[0], /lack 200 sessions/);
});

test('the participation proxy publishes the long-cycle line once the history supports it', () => {
  const long = Array.from({ length: 6 }, (_, sector) => ({
    symbol: `L${sector}`,
    points: dailySeries(300, (index) => 100 + index + sector).map((point) => ({ date: point.timestamp.slice(0, 10), value: point.value })),
  }));
  const proxy = calculateSectorBreadthProxy(long);
  assert.equal(proxy.status, 'calculated');
  assert.equal(proxy.pctAbove200, 100);
  assert.equal(proxy.eligible.above200, 6);
  assert.deepEqual(proxy.missing, []);
});

test('a metric is a share of the ETFs that could answer it, not of the whole universe', () => {
  const mixed = [
    ...Array.from({ length: 3 }, (_, sector) => ({
      symbol: `A${sector}`,
      points: dailySeries(300, (index) => 100 + index).map((point) => ({ date: point.timestamp.slice(0, 10), value: point.value })),
    })),
    ...Array.from({ length: 3 }, (_, sector) => ({
      symbol: `B${sector}`,
      points: dailySeries(80, (index) => 100 + index).map((point) => ({ date: point.timestamp.slice(0, 10), value: point.value })),
    })),
  ];
  const proxy = calculateSectorBreadthProxy(mixed);
  assert.equal(proxy.universeSize, 6);
  assert.equal(proxy.eligible.above200, 3);
  // All three that can answer are above their 200-day line: 100%, not 50%.
  assert.equal(proxy.pctAbove200, 100);
});

test('the proxy refuses a universe with no usable history at all', () => {
  assert.equal(calculateSectorBreadthProxy([]).status, 'unavailable');
  assert.equal(calculateSectorBreadthProxy([{ symbol: 'X', points: [] }]).status, 'unavailable');
});

test('the advance/decline line in the summary is the same line the chart draws', () => {
  const constituents = Array.from({ length: 30 }, (_, constituentIndex) => ({
    symbol: `AD${constituentIndex}`,
    points: dailySeries(400, (index) => 100 + (index * (constituentIndex < 20 ? 0.2 : -0.05)) + Math.sin(index / 6), 2023),
  }));
  const breadth = calculateBreadth(constituents);
  assert.equal(breadth.history.length, 252);
  assert.equal(breadth.advanceDecline.line, breadth.history.at(-1).advanceDeclineLine);
});

test('sector dispersion separates one macro trade from a stock-pickers tape', () => {
  const common = Array.from({ length: 400 }, (_, index) => Math.sin(index / 3) * 2);
  const together = Array.from({ length: 8 }, (_, sector) => ({
    symbol: `T${sector}`,
    name: `Together ${sector}`,
    points: dailySeries(400, (index) => 100 * (1 + (common.slice(0, index + 1).reduce((total, value) => total + value, 0) / 100)) + (sector / 50), 2023),
  }));
  const apart = Array.from({ length: 8 }, (_, sector) => ({
    symbol: `I${sector}`,
    name: `Independent ${sector}`,
    points: dailySeries(400, (index) => 100 + (Math.sin((index / 3) + (sector * 1.7)) * 4) + (index * 0.02), 2023),
  }));
  const benchmark = dailySeries(400, (index) => 100 + (index * 0.05), 2023);

  const correlated = calculateSectorDispersion(together, benchmark);
  const independent = calculateSectorDispersion(apart, benchmark);
  assert.equal(correlated.correlation > independent.correlation, true, `${correlated.correlation} should exceed ${independent.correlation}`);
  assert.equal(correlated.sectors, 8);
  assert.equal(Number.isFinite(correlated.dispersion), true);
});

test('sector dispersion ranks correlation against its own history rather than a fixed level', () => {
  const sectors = Array.from({ length: 8 }, (_, sector) => ({
    symbol: `R${sector}`,
    name: `Sector ${sector}`,
    points: dailySeries(500, (index) => 100 + (Math.sin((index / 4) + (sector * 0.9)) * 3) + (index * 0.03), 2022),
  }));
  const result = calculateSectorDispersion(sectors, dailySeries(500, (index) => 100 + (index * 0.03), 2022));
  assert.equal(result.status, 'calculated');
  assert.equal(result.rankedAgainst >= 40, true);
  assert.equal(result.correlationPercentile >= 0 && result.correlationPercentile <= 100, true);
  assert.match(result.methodology, /ranked against its own/);
});

test('sector dispersion reports how many sectors are ahead of the benchmark', () => {
  const sectors = Array.from({ length: 6 }, (_, sector) => ({
    symbol: `B${sector}`,
    name: `Sector ${sector}`,
    // Three sectors climb faster than the benchmark, three slower.
    points: dailySeries(300, (index) => 100 + (index * (sector < 3 ? 0.2 : 0.01)), 2023),
  }));
  const result = calculateSectorDispersion(sectors, dailySeries(300, (index) => 100 + (index * 0.1), 2023));
  assert.equal(result.sectorsBeatingBenchmark, 3);
  assert.equal(result.leadershipBreadth, 50);
  assert.equal(result.leader.symbol.startsWith('B'), true);
  assert.equal(result.laggard.return < result.leader.return, true);
});

test('sector dispersion refuses a universe or a window it cannot measure', () => {
  assert.equal(calculateSectorDispersion([], []).status, 'unavailable');
  const tooShort = Array.from({ length: 8 }, (_, sector) => ({
    symbol: `S${sector}`,
    points: dailySeries(40, (index) => 100 + index),
  }));
  assert.equal(calculateSectorDispersion(tooShort, dailySeries(40, (index) => 100 + index)).status, 'unavailable');
});

test('sector dispersion uses only sessions every sector shares', () => {
  const sectors = Array.from({ length: 6 }, (_, sector) => ({
    symbol: `G${sector}`,
    name: `Sector ${sector}`,
    points: dailySeries(300, (index) => 100 + (index * 0.1) + Math.sin(index / 5 + sector), 2023)
      // One sector is missing a run of sessions in the middle.
      .filter((point, index) => !(sector === 0 && index > 100 && index < 140)),
  }));
  const result = calculateSectorDispersion(sectors, dailySeries(300, (index) => 100 + (index * 0.1), 2023));
  assert.equal(result.observations, 261, 'the 39 sessions one sector lacks must drop out for everyone');
});

test('the drawdown profile places today inside its own drawdown history', () => {
  const points = dailySeries(600, (index) => {
    if (index < 300) return 100 + (index * 0.3);
    if (index < 380) return 190 - ((index - 300) * 0.5);
    return 150 + ((index - 380) * 0.1);
  }, 2022);
  const result = calculateDrawdownProfile(points);
  assert.equal(result.status, 'calculated');
  assert.equal(result.drawdownPercent < 0, true);
  // The peak is the first bar of the decline leg (190), not the last of the
  // advance (189.7), which is what a running-peak measure should find.
  assert.equal(result.peakDate, points[300].timestamp.slice(0, 10));
  assert.equal(result.sessionsSincePeak, 299);
  assert.equal(['Correction', 'Deep correction', 'Bear-market drawdown'].includes(result.state), true);
  assert.equal(result.depthPercentile >= 0 && result.depthPercentile <= 100, true);
});

test('a new high is reported as a new high, not as a zero-depth drawdown', () => {
  const result = calculateDrawdownProfile(dailySeries(400, (index) => 100 + index, 2023));
  assert.equal(result.inDrawdown, false);
  assert.equal(result.drawdownPercent, 0);
  assert.equal(result.state, 'At the highs');
  assert.match(result.read, /new high/);
});

test('an open drawdown is not counted among the completed episodes', () => {
  const points = dailySeries(400, (index) => (index < 200 ? 100 + index : 300 - ((index - 200) * 0.4)), 2023);
  const result = calculateDrawdownProfile(points);
  assert.equal(result.inDrawdown, true);
  assert.equal(result.completedEpisodes, 0);
  assert.equal(result.deepest, null);
});

test('the drawdown profile names the worst completed episode and its recovery', () => {
  const points = dailySeries(700, (index) => {
    if (index < 100) return 100 + index;          // peak 199
    if (index < 200) return 199 - ((index - 100) * 0.6);  // falls to ~139
    if (index < 320) return 139 + ((index - 200) * 0.6);  // recovers past 199
    return 211 + ((index - 320) * 0.05);
  }, 2022);
  const result = calculateDrawdownProfile(points);
  assert.equal(result.completedEpisodes, 1);
  assert.equal(result.deepest.trough < -25, true);
  assert.equal(result.deepest.recoverySessions > 100, true);
  assert.equal(result.slowestRecovery.sessions, result.deepest.recoverySessions);
});

test('the drawdown profile refuses a history too short to rank', () => {
  const result = calculateDrawdownProfile(dailySeries(100, (index) => 100 + index));
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /Needs 250 sessions/);
});

test('capture separates a sector that defends from one that only lags', () => {
  const benchmarkMoves = Array.from({ length: 400 }, (_, index) => (index % 2 ? 1 : -1) * (1 + (Math.sin(index / 9) * 0.4)));
  const build = (up, down) => {
    let level = 100;
    return benchmarkMoves.map((move, index) => {
      level *= 1 + ((move * (move > 0 ? up : down)) / 100);
      return { timestamp: new Date(Date.UTC(2023, 0, index + 1)).toISOString(), value: level };
    });
  };
  let benchmarkLevel = 100;
  const benchmark = benchmarkMoves.map((move, index) => {
    benchmarkLevel *= 1 + (move / 100);
    return { timestamp: new Date(Date.UTC(2023, 0, index + 1)).toISOString(), value: benchmarkLevel };
  });

  const defensive = calculateCaptureProfile(build(0.9, 0.5), benchmark);
  const highBeta = calculateCaptureProfile(build(1.4, 1.4), benchmark);
  assert.equal(defensive.downCapture < 85, true, `down capture was ${defensive.downCapture}`);
  assert.equal(highBeta.behaviour, 'High beta');
  assert.equal(defensive.behaviour === 'Defensive' || defensive.behaviour === 'Defends and participates', true);
  assert.equal(defensive.captureSpread > highBeta.captureSpread, true);
});

test('capture refuses a side of the tape it has too few days for', () => {
  // A benchmark that only ever rises: there are no down days to measure.
  const rising = Array.from({ length: 300 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2023, 0, index + 1)).toISOString(),
    value: 100 * (1.002 ** index),
  }));
  const result = calculateCaptureProfile(rising.map((point) => ({ ...point, value: point.value * 1.1 })), rising);
  assert.equal(result.downCapture, null);
  assert.equal(result.behaviour, null);
  assert.equal(result.status, 'provisional');
  assert.match(result.read, /Fewer than 20 days on one side/);
});

test('capture reports beta split by direction and the spread of its rolling estimates', () => {
  const moves = Array.from({ length: 400 }, (_, index) => (index % 2 ? 1.2 : -1.1) + (Math.sin(index / 7) * 0.5));
  let benchmarkLevel = 100;
  const benchmark = moves.map((move, index) => {
    benchmarkLevel *= 1 + (move / 100);
    return { timestamp: new Date(Date.UTC(2023, 0, index + 1)).toISOString(), value: benchmarkLevel };
  });
  // Beta shifts halfway through: a single full-window number would hide it.
  let level = 100;
  const shifting = moves.map((move, index) => {
    level *= 1 + ((move * (index < 200 ? 0.6 : 1.6)) / 100);
    return { timestamp: new Date(Date.UTC(2023, 0, index + 1)).toISOString(), value: level };
  });
  const result = calculateCaptureProfile(shifting, benchmark);
  assert.equal(Number.isFinite(result.upBeta) && Number.isFinite(result.downBeta), true);
  assert.equal(result.betaRange.high > result.betaRange.low, true);
  assert.equal(result.rollingWindows > 0, true);
  assert.equal(['Drifting', 'Unstable'].includes(result.stability), true, `stability was ${result.stability}`);
});

test('capture refuses a history that barely overlaps the benchmark', () => {
  const short = Array.from({ length: 30 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2024, 0, index + 1)).toISOString(),
    value: 100 + index,
  }));
  assert.equal(calculateCaptureProfile(short, short).status, 'unavailable');
});

test('the volatility term structure reads a shock as inverted, not as a high-volatility regime', () => {
  const calm = Array.from({ length: 800 }, (_, index) => 100 * (1.0002 ** index) * (1 + (0.002 * Math.sin(index / 3))));
  const shocked = [...calm, ...Array.from({ length: 25 }, (_, index) => calm.at(-1) * (1 + (0.05 * Math.sin(index))))];
  const toPoints = (values) => values.map((value, index) => ({ timestamp: new Date(Date.UTC(2021, 0, index + 1)).toISOString(), value }));

  const quiet = calculateVolatilityTermStructure(toPoints(calm));
  const shock = calculateVolatilityTermStructure(toPoints(shocked));
  assert.equal(shock.slope, 'inverted');
  assert.equal(shock.state, 'Shock in progress');
  assert.equal(quiet.slope !== 'inverted', true, `quiet slope was ${quiet.slope}`);
  assert.equal(shock.ratio > quiet.ratio, true);
});

test('each volatility window is ranked against its own history, not against the others', () => {
  const points = Array.from({ length: 900 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2021, 0, index + 1)).toISOString(),
    value: 100 * (1.0003 ** index) * (1 + (0.01 * Math.sin(index / 11)) + (0.004 * Math.cos(index / 3))),
  }));
  const result = calculateVolatilityTermStructure(points);
  assert.equal(result.terms.length, 3);
  result.terms.forEach((term) => {
    assert.equal(Number.isFinite(term.annualizedPercent), true);
    assert.equal(term.percentile >= 0 && term.percentile <= 100, true);
    assert.equal(term.rankedAgainst > 0, true);
  });
  assert.equal(result.status, 'calculated');
});

test('the volatility term structure refuses a history shorter than its longest window', () => {
  const result = calculateVolatilityTermStructure(Array.from({ length: 200 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2024, 0, index + 1)).toISOString(),
    value: 100 + index,
  })));
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /Needs 254 sessions/);
  assert.deepEqual(result.terms, []);
});

test('sector rotation carries a trail of prior quadrant positions, oldest first', () => {
  const points = (step) => Array.from({ length: 400 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2023, 0, index + 1)).toISOString(),
    value: 100 + (index * step) + (Math.sin(index / 9) * 4),
  }));
  const rotation = calculateSectorRotation([{ symbol: 'XLK', name: 'Technology', points: points(0.5) }], points(0.25));
  const trail = rotation.sectors[0].rotation.trail;
  assert.equal(trail.length, 5);
  assert.deepEqual(trail.map((point) => point.sessionsAgo), [80, 60, 40, 20, 0]);
  assert.equal(trail.at(-1).quadrant, rotation.sectors[0].quadrant);
  assert.equal(rotation.sectors[0].rotation.trailSpansSessions, 80);
  assert.equal(rotation.sectors[0].rotation.quadrantsVisited >= 1, true);
});

test('a trail point the history cannot reach is dropped rather than repeated', () => {
  const points = (step) => Array.from({ length: 130 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2023, 0, index + 1)).toISOString(),
    value: 100 + (index * step) + (Math.sin(index / 9) * 3),
  }));
  const rotation = calculateSectorRotation([{ symbol: 'XLK', name: 'Technology', points: points(0.5) }], points(0.25));
  const trail = rotation.sectors[0].rotation.trail;
  assert.equal(trail.length < 5, true, `trail had ${trail.length} points on 130 sessions`);
  assert.equal(new Set(trail.map((point) => point.date)).size, trail.length, 'no trail point may be repeated');
  assert.equal(trail.at(-1).sessionsAgo, 0);
});

test('the thrust log records each episode once and what the benchmark did next', () => {
  const endingAt = Date.UTC(2024, 0, 1);
  const dates = Array.from({ length: 300 }, (_, index) => new Date(endingAt + (index * 86_400_000)).toISOString());
  // 30 constituents. Sessions 60-110 are broadly negative, then a sharp,
  // sustained thrust: nearly every name advances for 40 sessions.
  const advancingOn = (index) => (index >= 60 && index < 110 ? 4 : index >= 110 && index < 150 ? 29 : 15);
  const constituents = Array.from({ length: 30 }, (_, constituentIndex) => ({
    symbol: `T${constituentIndex}`,
    points: dates.map((timestamp, index) => ({ timestamp, value: 100 + (index * 0.05) + (constituentIndex / 1000) })),
  }));
  constituents.forEach((constituent, constituentIndex) => {
    let level = 100;
    constituent.points = dates.map((timestamp, index) => {
      level *= 1 + ((constituentIndex < advancingOn(index) ? 0.4 : -0.4) / 100);
      return { timestamp, value: level };
    });
  });
  const benchmark = dates.map((timestamp, index) => ({ timestamp, value: 100 + (index * 0.2) }));

  const breadth = calculateBreadth(constituents, { benchmark });
  assert.equal(Array.isArray(breadth.thrustEvents), true);
  assert.equal(breadth.thrustEvents.length >= 1, true, 'the sustained advance should log at least one thrust');
  assert.equal(breadth.thrustEvents.length <= 3, true, `one advance logged ${breadth.thrustEvents.length} events`);
  const event = breadth.thrustEvents[0];
  assert.equal(event.priorRatio < 40, true);
  assert.equal(event.triggerRatio >= 61.5, true);
  assert.equal(event.benchmarkCovered, true);
  assert.equal(Number.isFinite(event.forward20), true);
});

test('a thrust with no benchmark history reports a pending outcome, not a zero', () => {
  const endingAt = Date.UTC(2024, 0, 1);
  const dates = Array.from({ length: 300 }, (_, index) => new Date(endingAt + (index * 86_400_000)).toISOString());
  const advancingOn = (index) => (index >= 60 && index < 110 ? 4 : index >= 110 && index < 150 ? 29 : 15);
  const constituents = Array.from({ length: 30 }, (_, constituentIndex) => {
    let level = 100;
    return {
      symbol: `N${constituentIndex}`,
      points: dates.map((timestamp, index) => {
        level *= 1 + ((constituentIndex < advancingOn(index) ? 0.4 : -0.4) / 100);
        return { timestamp, value: level };
      }),
    };
  });
  const breadth = calculateBreadth(constituents);
  assert.equal(breadth.thrustEvents.length >= 1, true);
  breadth.thrustEvents.forEach((event) => {
    assert.equal(event.benchmarkCovered, false);
    assert.equal(event.forward20, null);
    assert.equal(event.forward60, null);
  });
});

test('a tape that never washes out logs no thrust at all', () => {
  const constituents = Array.from({ length: 30 }, (_, constituentIndex) => ({
    symbol: `S${constituentIndex}`,
    points: Array.from({ length: 200 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2024, 0, index + 1)).toISOString(),
      value: 100 + (index * 0.2) + (constituentIndex / 100),
    })),
  }));
  assert.deepEqual(calculateBreadth(constituents).thrustEvents, []);
});

test('revision breadth separates a broad upgrade from a narrow one', () => {
  const broad = Array.from({ length: 30 }, (_, index) => ({ symbol: `B${index}`, up: 4, down: 1 }));
  const narrow = [
    { symbol: 'MEGA1', up: 40, down: 2 },
    { symbol: 'MEGA2', up: 35, down: 3 },
    ...Array.from({ length: 28 }, (_, index) => ({ symbol: `S${index}`, up: 1, down: 2 })),
  ];
  const broadResult = calculateRevisionBreadth(broad);
  const narrowResult = calculateRevisionBreadth(narrow);
  assert.equal(broadResult.state, 'Broad upgrades');
  assert.equal(broadResult.narrow, false);
  assert.equal(narrowResult.aggregate > 0, true, 'the pooled revisions lean up');
  assert.equal(narrowResult.diffusion < 40, true, 'but most names are being cut');
  assert.equal(narrowResult.narrow, true);
  assert.match(narrowResult.read, /a few heavily covered names/);
});

test('a name with no revisions at all is excluded rather than counted as unchanged', () => {
  const rows = [
    ...Array.from({ length: 25 }, (_, index) => ({ symbol: `C${index}`, up: 3, down: 1 })),
    ...Array.from({ length: 10 }, (_, index) => ({ symbol: `U${index}`, up: 0, down: 0 })),
  ];
  const result = calculateRevisionBreadth(rows);
  assert.equal(result.covered, 25);
  assert.equal(result.universe, 35);
  assert.equal(result.coverage, 71);
  assert.equal(result.status, 'provisional');
  assert.equal(result.diffusion, 100);
});

test('revision breadth refuses a universe too thinly covered to read', () => {
  const result = calculateRevisionBreadth(Array.from({ length: 5 }, (_, index) => ({ symbol: `T${index}`, up: 2, down: 1 })));
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /Needs 20 names/);
  assert.equal(result.covered, 5);
});

test('revision breadth scores on the same 0-100 axis as the other equity drivers', () => {
  const up = calculateRevisionBreadth(Array.from({ length: 30 }, (_, index) => ({ symbol: `U${index}`, up: 9, down: 1 })));
  const down = calculateRevisionBreadth(Array.from({ length: 30 }, (_, index) => ({ symbol: `D${index}`, up: 1, down: 9 })));
  assert.equal(up.score > 70, true);
  assert.equal(down.score < 30, true);
  assert.equal(up.state, 'Broad upgrades');
  assert.equal(down.state, 'Broad downgrades');
});

test('a sector that rallies as the benchmark falls is inverse, not defensive', () => {
  const moves = Array.from({ length: 400 }, (_, index) => ((index % 2 ? 1 : -1) * 1.2) + (Math.sin(index / 8) * 0.3));
  let benchmarkLevel = 100;
  const benchmark = moves.map((move, index) => {
    benchmarkLevel *= 1 + (move / 100);
    return { timestamp: new Date(Date.UTC(2023, 0, index + 1)).toISOString(), value: benchmarkLevel };
  });
  let level = 100;
  const opposed = moves.map((move, index) => {
    level *= 1 - ((move * 1.3) / 100);
    return { timestamp: new Date(Date.UTC(2023, 0, index + 1)).toISOString(), value: level };
  });
  const result = calculateCaptureProfile(opposed, benchmark);
  assert.equal(result.downCapture < 0, true, `down capture was ${result.downCapture}`);
  assert.equal(result.inverse, true);
  assert.equal(result.behaviour, 'Inverse to the benchmark');
  assert.match(result.read, /moves against the benchmark/);
});

test('the volatility ratio survives a long window that rounds to zero', () => {
  // A market so quiet every window rounds to 0.0% for display. The term
  // structure must still come from the measured values.
  const points = Array.from({ length: 800 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2021, 0, index + 1)).toISOString(),
    value: 100 * (1 + (0.0000004 * Math.sin(index / 3))),
  }));
  const result = calculateVolatilityTermStructure(points);
  assert.equal(result.terms.every((term) => term.annualizedPercent === 0), true, 'every displayed window should round to zero');
  assert.equal(Number.isFinite(result.ratio), true, 'the ratio must not be lost to the rounding');
  assert.equal(result.slope !== null, true);
});

test('the drawdown narrative names the recovery length it published', () => {
  // A completed episode, then a fresh decline so the narrative takes the
  // in-drawdown branch that mentions the worst completed episode.
  const points = dailySeries(700, (index) => {
    if (index < 200) return 100 + (index * 0.4);           // advance to 180
    if (index < 300) return 180 - ((index - 200) * 0.5);   // fall to 130
    if (index < 460) return 130 + ((index - 300) * 0.35);  // recover past 180
    return 186 - ((index - 460) * 0.2);                    // fresh decline
  }, 2021);
  const result = calculateDrawdownProfile(points);

  assert.equal(result.status, 'calculated');
  assert.ok(result.deepest, 'an episode should have completed');
  assert.ok(Number.isFinite(result.deepest.recoverySessions));
  // The episode objects carry the count as `sessions` and only the published
  // shape renames it to `recoverySessions`; the narrative used to read the
  // published name off the raw episode and printed "undefined sessions".
  assert.match(result.read, new RegExp(`took ${result.deepest.recoverySessions} sessions? to recover`));
  assert.doesNotMatch(result.read, /undefined/);
});

test('a one-session count reads as a session, not as sessions', () => {
  const points = dailySeries(400, (index) => (index === 399 ? 240 : 100 + (index * 0.35)), 2022);
  const result = calculateDrawdownProfile(points);
  // Whatever the branch, no rendered count should read "1 sessions".
  assert.doesNotMatch(result.read, /\b1 sessions\b/);
});

test('a market with no range declines a divergence read instead of calling a low', () => {
  // Left unguarded a null percentile failed ">= 80" and passed "<= 20", so an
  // index that had gone nowhere reported "Breadth confirms the low" - a
  // bearish state manufactured from the absence of data, described as the
  // "nullth percentile".
  const flatIndex = Array.from({ length: 80 }, () => 100);
  const flatBreadth = Array.from({ length: 80 }, () => 5_000);
  const result = calculateBreadthDivergence(flatIndex, flatBreadth);

  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /no range/);
  assert.equal(result.state, undefined);
  assert.equal(result.divergent, undefined);
});

test('a market with real range still produces a divergence read', () => {
  const price = Array.from({ length: 80 }, (_, index) => 100 + (Math.sin(index / 9) * 5) + (index * 0.2));
  const breadth = Array.from({ length: 80 }, (_, index) => 5_000 + (Math.sin(index / 11) * 80) + (index * 2));
  const result = calculateBreadthDivergence(price, breadth);

  assert.equal(result.status, 'calculated');
  assert.ok(Number.isFinite(result.pricePercentile));
  assert.doesNotMatch(result.read, /null|undefined|—th/);
});

// A deterministic generator, so a calibration test is reproducible rather than
// occasionally unlucky.
function seededReturns() {
  let seed = 12_345;
  const uniform = () => { seed = ((seed * 1_103_515_245) + 12_345) & 0x7fffffff; return seed / 0x7fffffff; };
  const gaussian = () => Math.sqrt(-2 * Math.log(Math.max(uniform(), 1e-12))) * Math.cos(2 * Math.PI * uniform());
  const studentT = (degrees) => {
    let sum = 0;
    for (let index = 0; index < degrees; index += 1) { const draw = gaussian(); sum += draw * draw; }
    return gaussian() / Math.sqrt(sum / degrees);
  };
  return { gaussian, studentT };
}

function priceSeries(generate, count = 3_000) {
  let value = 100;
  return Array.from({ length: count }, (_, index) => {
    value *= Math.exp(generate() * 0.01);
    return { date: new Date(Date.UTC(2010, 0, 1) + (index * 86_400_000)).toISOString().slice(0, 10), value };
  });
}

test('the expected-move band recovers the hit rate it claims on normal returns', () => {
  const { gaussian } = seededReturns();
  const result = calculateExpectedMove(priceSeries(gaussian));

  assert.equal(result.status, 'calculated');
  // A one-sigma Gaussian band holds 68.3% of the time in theory. Estimation
  // error in sigma and a finite number of windows pull it a little below, so
  // this checks the machinery lands in the right neighbourhood rather than on
  // a point value it has no right to hit exactly.
  for (const horizon of result.horizons) {
    assert.ok(horizon.heldPercent > 55 && horizon.heldPercent < 80, `${horizon.horizon}d held ${horizon.heldPercent}%`);
  }
  // Normal returns have no excess kurtosis.
  assert.ok(Math.abs(result.excessKurtosis) < 1, `excess kurtosis ${result.excessKurtosis}`);
});

test('fat tails make the band hold more often, and fail by more when it fails', () => {
  const { studentT } = seededReturns();
  const fat = calculateExpectedMove(priceSeries(() => studentT(3)));
  const { gaussian } = seededReturns();
  const normal = calculateExpectedMove(priceSeries(gaussian));

  // The intuition that fat tails break a one-sigma band more often is wrong: a
  // leptokurtic distribution piles mass at the centre as well as in the tails,
  // and it is the shoulders that thin out. The band's real weakness is the
  // size of what escapes it.
  assert.ok(fat.excessKurtosis > 3, `expected fat tails, got ${fat.excessKurtosis}`);
  assert.ok(fat.horizons[0].heldPercent > normal.horizons[0].heldPercent);
  assert.ok(fat.horizons[0].worstBreachSigmas > normal.horizons[0].worstBreachSigmas);
});

test('the expected-move band tests itself on independent windows only', () => {
  const { gaussian } = seededReturns();
  const result = calculateExpectedMove(priceSeries(gaussian, 3_000));
  for (const horizon of result.horizons) {
    // Non-overlapping windows: at most (observations - lookback) / horizon of
    // them. Overlapping ones would report many times this and look settled on
    // evidence they do not have.
    const ceiling = Math.ceil((3_000 - result.estimationWindow) / horizon.horizon);
    assert.ok(horizon.testedWindows <= ceiling, `${horizon.horizon}d claimed ${horizon.testedWindows} windows, ceiling ${ceiling}`);
    // Every tested window either held or was breached; nothing is unaccounted for.
    const heldWindows = horizon.testedWindows - horizon.breachedWindows;
    assert.equal(Math.round((heldWindows / horizon.testedWindows) * 1_000) / 10, horizon.heldPercent);
  }
});

test('the expected-move band refuses a history too short to test itself', () => {
  const { gaussian } = seededReturns();
  const result = calculateExpectedMove(priceSeries(gaussian, 200));
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /252 sessions/);
});

test('a trending market breaks the drift-free band more often, and the calibration shows it', () => {
  const { gaussian } = seededReturns();
  // Same volatility, but with a persistent drift the band does not model.
  let value = 100;
  const trending = Array.from({ length: 3_000 }, (_, index) => {
    value *= Math.exp((gaussian() * 0.01) + 0.004);
    return { date: new Date(Date.UTC(2010, 0, 1) + (index * 86_400_000)).toISOString().slice(0, 10), value };
  });
  const drifting = calculateExpectedMove(trending);

  const { gaussian: flat } = seededReturns();
  let level = 100;
  const driftless = Array.from({ length: 3_000 }, (_, index) => {
    level *= Math.exp(flat() * 0.01);
    return { date: new Date(Date.UTC(2010, 0, 1) + (index * 86_400_000)).toISOString().slice(0, 10), value: level };
  });
  const steady = calculateExpectedMove(driftless);

  // The band is centred on spot with no drift term, so a trending series
  // escapes it more often. The model must not hide that behind the same
  // hit rate.
  const longest = (model) => model.horizons.at(-1);
  assert.ok(longest(drifting).heldPercent < longest(steady).heldPercent,
    `trending held ${longest(drifting).heldPercent}%, driftless held ${longest(steady).heldPercent}%`);
  assert.match(drifting.methodology, /no drift term/);
});

test('concentration measures the index against its average member, with the right sign', () => {
  const sessions = 400;
  const cap = Array.from({ length: sessions }, (_, index) => 100 * Math.exp(index * 0.0006));
  const narrow = Array.from({ length: sessions }, (_, index) => 100 * Math.exp(index * 0.00015));
  const broad = Array.from({ length: sessions }, (_, index) => 100 * Math.exp(index * 0.0011));

  const narrowing = calculateBreadthConcentration(narrow, cap);
  const broadening = calculateBreadthConcentration(broad, cap);

  // Positive spread means the index outran its average member, which is
  // leadership concentrating into the largest holdings.
  assert.equal(narrowing.state, 'Narrowing');
  assert.ok(narrowing.windows.every((window) => window.spreadPoints > 0));
  assert.equal(broadening.state, 'Broadening');
  assert.ok(broadening.windows.every((window) => window.spreadPoints < 0));
});

test('concentration flags an index at its high while the average member is not', () => {
  // The case the model exists for: nothing about the index level shows this.
  const sessions = 400;
  const cap = Array.from({ length: sessions }, (_, index) => 100 * Math.exp(index * 0.0007));
  const sick = Array.from({ length: sessions }, (_, index) => (index < 300
    ? 100 * Math.exp(index * 0.0012)
    : 100 * Math.exp(300 * 0.0012) * (1 - ((index - 300) * 0.0013))));

  const result = calculateBreadthConcentration(sick, cap);
  assert.equal(result.maskedWeakness, true);
  assert.ok(result.capDrawdownPercent > -1, 'the index is at its high');
  assert.ok(result.equalDrawdownPercent < -10, 'the average member is not');
  assert.match(result.read, /not showing what most of the market is doing/);
});

test('concentration reports neither side leading inside the noise band', () => {
  const sessions = 400;
  const cap = Array.from({ length: sessions }, (_, index) => 100 * Math.exp(index * 0.0006));
  const almostIdentical = Array.from({ length: sessions }, (_, index) => 100 * Math.exp(index * 0.00061));

  const result = calculateBreadthConcentration(almostIdentical, cap);
  const medium = result.windows.find((window) => window.key === 'medium');
  assert.equal(medium.leader, 'neither');
  assert.equal(result.state, 'Balanced');
  assert.match(result.read, /inside the noise band/);
});

test('concentration refuses a history too short, and reports an alignment mismatch', () => {
  const short = Array.from({ length: 15 }, (_, index) => 100 + index);
  assert.equal(calculateBreadthConcentration(short, short).status, 'unavailable');

  // Closes are paired by position, so a length mismatch means different
  // sessions were paired. The size of it is published rather than hidden.
  const long = Array.from({ length: 300 }, (_, index) => 100 * Math.exp(index * 0.0005));
  const missingBars = long.slice(7);
  const result = calculateBreadthConcentration(missingBars, long);
  assert.equal(result.alignmentDroppedSessions, 7);
  assert.equal(result.observations, 293);
});
