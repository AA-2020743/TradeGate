import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBasketRotation, calculateBottomSignal, calculateBreadth, calculateBreadthDivergence, calculateEquityRegime, calculateMacroSensitivities, calculateSectorRotation, calculateTopRisk, rrgQuadrant } from './equityAnalytics.js';

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
