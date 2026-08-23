import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateGrowthNowcast,
  calculateInflationNowcast,
  calculateLiquidityCalendar,
  calculateRatePath,
  calculateRegimeTransitions,
  calculateYieldCurveModel,
  pointDaysBefore,
  seriesPoints,
} from './macroModels.js';

const DAY = 86_400_000;
const BASE = Date.UTC(2019, 0, 1);
const day = (index) => new Date(BASE + (index * DAY)).toISOString().slice(0, 10);

function series(key, valueAt, { count = 2600, multiplier = 1, everyDays = 1 } = {}) {
  return {
    key,
    multiplier,
    history: Array.from({ length: count }, (_, index) => ({ date: day(index * everyDays), value: valueAt(index) })),
  };
}

test('seriesPoints applies the multiplier and sorts by date', () => {
  const points = seriesPoints([{ key: 'x', multiplier: 1000, history: [{ date: '2024-01-02', value: 2 }, { date: '2024-01-01', value: 1 }, { date: '2024-01-03', value: null }] }], 'x');
  assert.deepEqual(points, [{ date: '2024-01-01', value: 1000 }, { date: '2024-01-02', value: 2000 }]);
  assert.deepEqual(seriesPoints([], 'missing'), []);
});

test('the curve model reports an inversion and how long it has run', () => {
  // Ten-year below the two-year for the last 300 sessions.
  const model = calculateYieldCurveModel([
    series('us10yYield', (index) => (index < 2300 ? 3 : 3)),
    series('us2yYield', (index) => (index < 2300 ? 2 : 3.8)),
    series('us3mYield', (index) => (index < 2300 ? 1.5 : 4.1)),
  ]);
  const tenTwo = model.spreads.find((spread) => spread.key === 'tenTwo');
  assert.equal(model.state, 'Inverted');
  assert.equal(tenTwo.inverted, true);
  assert.equal(tenTwo.sessionsInverted, 300);
  assert.equal(tenTwo.spread < 0, true);
});

test('the curve model treats an inversion that recovered and returned as two episodes', () => {
  const model = calculateYieldCurveModel([
    series('us10yYield', () => 3),
    // Inverted, then positive for a stretch, then inverted again for 100 days.
    series('us2yYield', (index) => (index < 1000 ? 3.5 : index < 2500 ? 2.5 : 3.6)),
    series('us3mYield', () => 2),
  ]);
  const tenTwo = model.spreads.find((spread) => spread.key === 'tenTwo');
  assert.equal(tenTwo.sessionsInverted, 100, 'only the current run counts, not both episodes');
  assert.equal(tenTwo.trough.value < 0, true);
});

test('the curve model separates a fresh un-inversion from a long-normal curve', () => {
  const fresh = calculateYieldCurveModel([
    series('us10yYield', () => 3),
    series('us2yYield', (index) => (index < 2560 ? 3.4 : 2.6)),
    series('us3mYield', () => 2.2),
  ]);
  assert.equal(fresh.state, 'Recently un-inverted');
  const tenTwo = fresh.spreads.find((spread) => spread.key === 'tenTwo');
  assert.equal(tenTwo.unInverted, true);
  assert.equal(tenTwo.sessionsSinceUnInversion <= 130, true);
  assert.match(fresh.read, /un-inversion itself is the nearer signal/);

  const alwaysNormal = calculateYieldCurveModel([
    series('us10yYield', () => 3.5),
    series('us2yYield', () => 2),
    series('us3mYield', () => 1.5),
  ]);
  assert.equal(alwaysNormal.spreads.find((spread) => spread.key === 'tenTwo').unInverted, false);
  assert.equal(alwaysNormal.state !== 'Recently un-inverted', true);
});

test('the curve model publishes what it can when one short leg is missing', () => {
  const model = calculateYieldCurveModel([series('us10yYield', () => 3.5), series('us2yYield', () => 2)]);
  assert.equal(model.status, 'provisional');
  assert.equal(model.spreads.find((spread) => spread.key === 'tenThreeMonth').status, 'unavailable');
  assert.match(model.spreads.find((spread) => spread.key === 'tenThreeMonth').reason, /3-month history is required/);
});

test('the curve model refuses a set with no long leg at all', () => {
  const model = calculateYieldCurveModel([series('us2yYield', () => 2)]);
  assert.equal(model.status, 'unavailable');
  assert.deepEqual(model.spreads, []);
});

test('inflation compares market pricing against what is actually printing', () => {
  const monthly = (key, valueAt) => series(key, valueAt, { count: 80, everyDays: 30 });
  const model = calculateInflationNowcast([
    series('breakeven5y', () => 2.4),
    series('breakeven10y', () => 2.3),
    series('forwardInflation5y5y', () => 2.2),
    // CPI running at about 5% year over year.
    monthly('cpi', (index) => 300 * (1.004 ** index)),
  ]);
  assert.equal(model.realized.status, 'calculated');
  assert.equal(model.realized.yearOverYearPercent > 4, true);
  assert.equal(model.gapVsRealized < 0, true);
  assert.equal(model.state, 'Market prices inflation well below what is printing');
  assert.match(model.read, /point gap/);
});

test('inflation publishes the CPI release lag rather than implying the leg is current', () => {
  const stale = {
    key: 'cpi',
    multiplier: 1,
    history: Array.from({ length: 40 }, (_, index) => ({
      date: new Date(Date.now() - ((40 - index) * 30 * DAY)).toISOString().slice(0, 10),
      value: 300 * (1.002 ** index),
    })),
  };
  const model = calculateInflationNowcast([series('breakeven10y', () => 2.3), stale]);
  assert.equal(model.realized.lagDays >= 25, true);
  assert.equal(Number.isFinite(model.gapVsRealized), true);
});

test('inflation still publishes market pricing with no CPI at all', () => {
  const model = calculateInflationNowcast([series('breakeven10y', () => 2.3), series('breakeven5y', () => 2.5)]);
  assert.equal(model.status, 'provisional');
  assert.equal(model.realized.status, 'unavailable');
  assert.equal(model.gapVsRealized, null);
  assert.match(model.read, /realized CPI rate is required/);
});

test('inflation refuses a set with no market leg', () => {
  const model = calculateInflationNowcast([series('cpi', (index) => 300 + index, { count: 40, everyDays: 30 })]);
  assert.equal(model.status, 'unavailable');
  assert.equal(model.realized, null);
});

test('the rate path counts cuts when the two-year sits below the bill', () => {
  const model = calculateRatePath([
    series('us3mYield', () => 5.3, { count: 300 }),
    series('us2yYield', () => 4.3, { count: 300 }),
    series('us10yYield', () => 4.1, { count: 300 }),
  ]);
  assert.equal(model.direction, 'cuts');
  assert.equal(model.impliedMovesRounded, -4, `100bp below the bill is four 25bp cuts, got ${model.impliedMoves}`);
  assert.equal(model.gapBasisPoints, -100);
  assert.match(model.read, /not read from fed funds futures/);
});

test('the rate path counts hikes and reports no material change inside the band', () => {
  const hiking = calculateRatePath([
    series('us3mYield', () => 3, { count: 300 }),
    series('us2yYield', () => 3.75, { count: 300 }),
  ]);
  assert.equal(hiking.direction, 'hikes');
  assert.equal(hiking.impliedMovesRounded, 3);

  const flat = calculateRatePath([
    series('us3mYield', () => 4, { count: 300 }),
    series('us2yYield', () => 4.05, { count: 300 }),
  ]);
  assert.equal(flat.direction, 'no material change');
});

test('the rate path refuses to infer without both ends of the front curve', () => {
  const model = calculateRatePath([series('us2yYield', () => 4, { count: 300 })]);
  assert.equal(model.status, 'unavailable');
  assert.match(model.reason, /2-year and 3-month/);
});

test('the liquidity calendar places the next quarter-end and reads TGA seasonality', () => {
  const now = new Date(Date.UTC(2024, 1, 10));
  // A TGA that rebuilds every spring across several years.
  const tga = {
    key: 'treasuryGeneralAccount',
    multiplier: 1,
    history: Array.from({ length: 2000 }, (_, index) => {
      const date = new Date(Date.UTC(2019, 0, 1) + (index * DAY));
      const seasonal = Math.sin(((date.getUTCMonth() + 1) / 12) * Math.PI * 2) * 200_000;
      return { date: date.toISOString().slice(0, 10), value: 700_000 + seasonal };
    }),
  };
  const model = calculateLiquidityCalendar([
    tga,
    series('reverseRepo', (index) => 2000 - (index * 0.5), { count: 400, multiplier: 1000 }),
    series('fedBalanceSheet', (index) => 8_000_000 - (index * 300), { count: 300 }),
  ], { now });
  assert.equal(model.status, 'calculated');
  assert.equal(model.quarterEnd.date, '2024-03-31');
  assert.equal(model.quarterEnd.daysAway, 50);
  assert.equal(Number.isFinite(model.tgaSeasonalChangeUsdMillions), true);
  const seasonal = model.events.find((event) => event.key === 'tgaSeasonal');
  assert.equal(seasonal.samples >= 2, true);
  assert.match(seasonal.note, /not an announced financing schedule/);
});

test('the liquidity calendar projects reverse-repo exhaustion from the drain', () => {
  const now = new Date(Date.UTC(2024, 5, 1));
  const model = calculateLiquidityCalendar([
    { key: 'treasuryGeneralAccount', multiplier: 1, history: Array.from({ length: 1500 }, (_, index) => ({ date: new Date(Date.UTC(2020, 0, 1) + (index * DAY)).toISOString().slice(0, 10), value: 700_000 + (Math.sin(index / 60) * 100_000) })) },
    { key: 'reverseRepo', multiplier: 1000, history: Array.from({ length: 400 }, (_, index) => ({ date: new Date(Date.UTC(2023, 0, 1) + (index * DAY)).toISOString().slice(0, 10), value: 1500 - (index * 3) })) },
  ], { now });
  const exhaustion = model.events.find((event) => event.key === 'rrpExhaustion');
  assert.ok(exhaustion, 'a draining facility should project an exhaustion date');
  assert.equal(exhaustion.daysAway > 0, true);
  assert.equal(model.monthsOfCushion > 0, true);
  assert.match(exhaustion.note, /Straight-line/);
});

test('a rising reverse-repo balance projects no exhaustion at all', () => {
  const now = new Date(Date.UTC(2024, 5, 1));
  const model = calculateLiquidityCalendar([
    { key: 'treasuryGeneralAccount', multiplier: 1, history: Array.from({ length: 1500 }, (_, index) => ({ date: new Date(Date.UTC(2020, 0, 1) + (index * DAY)).toISOString().slice(0, 10), value: 700_000 })) },
    { key: 'reverseRepo', multiplier: 1000, history: Array.from({ length: 400 }, (_, index) => ({ date: new Date(Date.UTC(2023, 0, 1) + (index * DAY)).toISOString().slice(0, 10), value: 1000 + (index * 2) })) },
  ], { now });
  assert.equal(model.events.some((event) => event.key === 'rrpExhaustion'), false);
  assert.equal(model.monthsOfCushion, null);
});

test('the liquidity calendar refuses a TGA history too short to read seasonality', () => {
  const model = calculateLiquidityCalendar([series('treasuryGeneralAccount', () => 700_000, { count: 200 })]);
  assert.equal(model.status, 'unavailable');
  assert.match(model.reason, /at least a year of TGA history/);
});

test('regime transitions recompute the score historically and log each change', () => {
  const count = 1400;
  const conditions = series('financialConditions', (index) => (index < 700 ? -0.6 : 0.9), { count });
  const spread = series('highYieldSpread', (index) => (index < 700 ? 3.1 : 7.5), { count });
  const vix = series('vix', (index) => (index < 700 ? 13 : 32), { count });
  const benchmark = Array.from({ length: count }, (_, index) => ({ date: day(index), value: 100 + (index < 700 ? index * 0.05 : 35 - ((index - 700) * 0.02)) }));

  const model = calculateRegimeTransitions([conditions, spread, vix], benchmark);
  assert.equal(model.status, 'calculated');
  assert.equal(model.transitions.length >= 1, true);
  const shift = model.transitions.at(-1);
  assert.equal(shift.from !== shift.to, true);
  assert.equal(Number.isFinite(shift.forward21), true);
  assert.equal(model.current.regime, 'Contraction / risk-off');
  assert.match(model.methodology, /hindsight study rather than a backtest/);
});

test('regime transitions publish dates without a benchmark and say so', () => {
  const count = 1400;
  const model = calculateRegimeTransitions([
    series('financialConditions', (index) => (index < 700 ? -0.6 : 0.9), { count }),
    series('highYieldSpread', (index) => (index < 700 ? 3.1 : 7.5), { count }),
    series('vix', (index) => (index < 700 ? 13 : 32), { count }),
  ], []);
  assert.equal(model.status, 'provisional');
  assert.match(model.reason, /Forward returns need a benchmark/);
  assert.equal(model.transitions.every((entry) => entry.forward21 === null), true);
});

test('regime transitions report dwell time for the current regime', () => {
  const count = 1400;
  const model = calculateRegimeTransitions([
    series('financialConditions', () => -0.5, { count }),
    series('highYieldSpread', () => 3.2, { count }),
    series('vix', () => 14, { count }),
  ], []);
  assert.deepEqual(model.transitions, [], 'a constant tape never changes regime');
  assert.equal(model.current.runDays > 1000, true);
  assert.equal(model.dwellDays[model.current.regime].episodes, 1);
});

test('regime transitions refuse a history too short to recompute', () => {
  const model = calculateRegimeTransitions([
    series('financialConditions', () => -0.5, { count: 100 }),
    series('highYieldSpread', () => 3.2, { count: 100 }),
  ], []);
  assert.equal(model.status, 'unavailable');
  assert.match(model.reason, /years of overlapping history/);
});

test('the growth nowcast separates an accelerating tape from a contracting one', () => {
  const points = (step, count = 200) => Array.from({ length: count }, (_, index) => ({ date: day(index), value: 100 * ((1 + step) ** index) }));
  const strong = calculateGrowthNowcast({
    copper: points(0.003),
    gold: points(0.0005),
    cyclicals: [points(0.004), points(0.0035)],
    defensives: [points(0.0005), points(0.0004)],
    emerging: points(0.004),
    developed: points(0.002),
    curveSpread: 0.8,
    breakeven: 0.3,
  });
  const weak = calculateGrowthNowcast({
    copper: points(-0.002),
    gold: points(0.002),
    cyclicals: [points(-0.003), points(-0.0025)],
    defensives: [points(0.001), points(0.0012)],
    emerging: points(-0.003),
    developed: points(0.001),
    curveSpread: -0.9,
    breakeven: -0.4,
  });
  assert.equal(strong.status, 'calculated');
  assert.equal(strong.score > weak.score, true);
  assert.equal(['Accelerating', 'Firm'].includes(strong.state), true, `strong was ${strong.state}`);
  assert.equal(['Contracting', 'Softening'].includes(weak.state), true, `weak was ${weak.state}`);
});

test('the growth nowcast surfaces disagreement rather than averaging it away', () => {
  const points = (step, count = 200) => Array.from({ length: count }, (_, index) => ({ date: day(index), value: 100 * ((1 + step) ** index) }));
  const conflicted = calculateGrowthNowcast({
    copper: points(0.006),
    gold: points(0.0001),
    cyclicals: [points(-0.004)],
    defensives: [points(0.003)],
    emerging: points(-0.004),
    developed: points(0.003),
    curveSpread: -1.2,
    breakeven: 0.5,
  });
  assert.equal(conflicted.disagreement >= 45, true, `disagreement was ${conflicted.disagreement}`);
  assert.match(conflicted.read, /disagree by/);
});

test('the growth nowcast refuses to publish on fewer than three proxies', () => {
  const points = (step) => Array.from({ length: 200 }, (_, index) => ({ date: day(index), value: 100 * ((1 + step) ** index) }));
  const model = calculateGrowthNowcast({ copper: points(0.003), gold: points(0.001), curveSpread: null, breakeven: null });
  assert.equal(model.status, 'unavailable');
  assert.equal(model.score, null);
  assert.match(model.reason, /Needs 3 of the 5 growth proxies/);
});

test('the growth nowcast names the proxies it could not calculate', () => {
  const points = (step) => Array.from({ length: 200 }, (_, index) => ({ date: day(index), value: 100 * ((1 + step) ** index) }));
  const model = calculateGrowthNowcast({
    copper: points(0.003),
    gold: points(0.001),
    curveSpread: 0.4,
    breakeven: 0.1,
  });
  assert.equal(model.status, 'provisional');
  assert.equal(model.missing.includes('Cyclicals versus defensives'), true);
  assert.equal(model.coverage, 60);
});

test('a future-dated CPI observation is flagged, not rendered as a negative lag', () => {
  const future = {
    key: 'cpi',
    multiplier: 1,
    history: Array.from({ length: 40 }, (_, index) => ({
      date: new Date(Date.now() + ((index + 1) * 30 * DAY)).toISOString().slice(0, 10),
      value: 300 * (1.002 ** index),
    })),
  };
  const model = calculateInflationNowcast([series('breakeven10y', () => 2.3), future]);
  assert.equal(model.realized.futureDated, true);
  assert.equal(model.realized.lagDays, 0, 'a lag can never be negative');
  assert.match(model.read, /ahead of today/);
});

test('a normally lagged CPI observation reports its release lag', () => {
  const lagged = {
    key: 'cpi',
    multiplier: 1,
    history: Array.from({ length: 40 }, (_, index) => ({
      date: new Date(Date.now() - ((40 - index) * 30 * DAY)).toISOString().slice(0, 10),
      value: 300 * (1.002 ** index),
    })),
  };
  const model = calculateInflationNowcast([series('breakeven10y', () => 2.3), lagged]);
  assert.equal(model.realized.futureDated, false);
  assert.equal(model.realized.lagDays > 0, true);
});

test('the calendar defers to the runway model rather than publishing a second cushion', () => {
  const now = new Date(Date.UTC(2024, 5, 1));
  const tga = { key: 'treasuryGeneralAccount', multiplier: 1, history: Array.from({ length: 1500 }, (_, index) => ({ date: new Date(Date.UTC(2020, 0, 1) + (index * DAY)).toISOString().slice(0, 10), value: 700_000 + (Math.sin(index / 60) * 100_000) })) };
  const rrp = { key: 'reverseRepo', multiplier: 1000, history: Array.from({ length: 400 }, (_, index) => ({ date: new Date(Date.UTC(2023, 0, 1) + (index * DAY)).toISOString().slice(0, 10), value: 1500 - (index * 3) })) };

  const alone = calculateLiquidityCalendar([tga, rrp], { now });
  const deferred = calculateLiquidityCalendar([tga, rrp], {
    now,
    runway: { version: 'liquidity-runway-v1', reverseRepoLevel: 300_000, drainPerMonth: 50_000, runwayMonths: 6 },
  });
  assert.equal(deferred.monthsOfCushion, 6, 'the runway model is the single source for the cushion');
  assert.equal(deferred.cushionSource, 'liquidity-runway-v1');
  assert.equal(alone.cushionSource, 'this model');
  assert.equal(alone.monthsOfCushion !== 6, true, 'the two paths genuinely differ, which is why one must win');
  assert.match(deferred.events.find((event) => event.key === 'rrpExhaustion').note, /liquidity-runway-v1/);
});

test('a windowed change refuses a series coarser than the window it is asked for', () => {
  const quarterly = Array.from({ length: 12 }, (_, index) => ({
    date: new Date(Date.UTC(2022, index * 3, 15)).toISOString().slice(0, 10),
    value: 100 + index,
  }));
  assert.equal(pointDaysBefore(quarterly, '2024-09-15', 28), null);
  assert.ok(pointDaysBefore(quarterly, '2024-09-15', 182));
});

test('the CPI year-over-year leg refuses a gap standing in for a year', () => {
  const gapped = [
    ...Array.from({ length: 24 }, (_, index) => ({ date: new Date(Date.UTC(2020, index, 15)).toISOString().slice(0, 10), value: 260 + index })),
    { date: '2026-01-15', value: 320 },
  ];
  const model = calculateInflationNowcast([series('breakeven10y', () => 2.3), { key: 'cpi', multiplier: 1, history: gapped }]);
  assert.equal(model.realized.status, 'unavailable');
  assert.match(model.realized.reason, /a year before the latest/);
});

test('regime transitions run as hindsight without vintages and say so', () => {
  const count = 1400;
  const model = calculateRegimeTransitions([
    series('financialConditions', (index) => (index < 700 ? -0.6 : 0.9), { count }),
    series('highYieldSpread', (index) => (index < 700 ? 3.1 : 7.5), { count }),
    series('vix', (index) => (index < 700 ? 13 : 32), { count }),
  ], []);
  assert.equal(model.vintage, 'current');
  assert.deepEqual(model.pointInTimeKeys, []);
  assert.match(model.methodology, /hindsight study rather than a backtest/);
  assert.match(model.methodology, /FRED API key/);
});

test('point-in-time vintages turn the study into a backtest and never use a later revision', () => {
  const count = 1400;
  const plain = [
    series('financialConditions', (index) => (index < 700 ? -0.6 : 0.9), { count }),
    series('highYieldSpread', (index) => (index < 700 ? 3.1 : 7.5), { count }),
    series('vix', (index) => (index < 700 ? 13 : 32), { count }),
  ];
  // The NFCI observation for each date was first published a week later and
  // then revised sharply a year after that. A backtest must use the first
  // print at the time and never the revision.
  const vintages = {
    financialConditions: plain[0].history.flatMap((point) => {
      const first = { date: point.date, value: point.value, realtimeStart: new Date(new Date(point.date).getTime() + (7 * DAY)).toISOString().slice(0, 10) };
      const revised = { date: point.date, value: point.value + 4, realtimeStart: new Date(new Date(point.date).getTime() + (365 * DAY)).toISOString().slice(0, 10) };
      return [first, revised];
    }),
  };
  const backtest = calculateRegimeTransitions(plain, [], { vintages });
  assert.equal(backtest.vintage, 'point-in-time');
  assert.deepEqual(backtest.pointInTimeKeys, ['financialConditions']);
  assert.match(backtest.methodology, /genuine backtest rather than hindsight/);

  // The +4 revision would drive every score to the floor. If it were leaking in
  // at scoring time, the whole history would read Contraction.
  const hindsight = calculateRegimeTransitions(plain, []);
  assert.equal(backtest.samples > 20, true);
  assert.equal(backtest.current.regime, hindsight.current.regime, 'the latest score is unaffected by an old revision');
  assert.equal(backtest.transitions.length >= 1, true);
});
