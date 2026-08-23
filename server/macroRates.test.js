import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDataSurprise,
  calculateLiquidityPayoff,
  calculateNominalDecomposition,
  calculateRateDivergence,
  calculateReserveScarcity,
  calculateTermPremium,
  changeOver,
  seriesPoints,
} from './macroRates.js';

const DAY = 86_400_000;
const BASE = Date.UTC(2020, 0, 1);
const day = (index) => new Date(BASE + (index * DAY)).toISOString().slice(0, 10);

function daily(key, valueAt, { count = 2600, multiplier = 1 } = {}) {
  return { key, multiplier, history: Array.from({ length: count }, (_, index) => ({ date: day(index), value: valueAt(index) })) };
}

function monthly(key, valueAt, { count = 80, multiplier = 1 } = {}) {
  return {
    key,
    multiplier,
    history: Array.from({ length: count }, (_, index) => ({ date: new Date(Date.UTC(2020, index, 15)).toISOString().slice(0, 10), value: valueAt(index) })),
  };
}

test('changeOver refuses a window the series cannot answer', () => {
  const quarterly = Array.from({ length: 12 }, (_, index) => ({ date: new Date(Date.UTC(2022, index * 3, 15)).toISOString().slice(0, 10), value: 100 + index }));
  assert.equal(changeOver(quarterly, 28), null);
  assert.ok(changeOver(quarterly, 182));
  assert.equal(seriesPoints([{ key: 'x', multiplier: 100, history: [{ date: '2024-01-01', value: 2 }] }], 'x')[0].value, 200);
});

test('a nominal move driven by real yields is attributed to real yields', () => {
  // Nominal up 50bp over the quarter, all of it in the real leg.
  const model = calculateNominalDecomposition([
    daily('us10yYield', (index) => (index < 2509 ? 4 : 4 + ((index - 2509) * 0.0055))),
    daily('realYield10y', (index) => (index < 2509 ? 1.8 : 1.8 + ((index - 2509) * 0.0055))),
    daily('breakeven10y', () => 2.2),
  ]);
  assert.equal(model.status, 'calculated');
  const quarter = model.windows.find((entry) => entry.days === 91);
  assert.equal(quarter.driver, 'real yields');
  assert.equal(quarter.realSharePercent, 100);
  assert.equal(Math.abs(quarter.breakevenBasisPoints) < 1, true);
  assert.match(model.read, /real yields did the work/);
});

test('a nominal move driven by breakevens is attributed to inflation compensation', () => {
  const model = calculateNominalDecomposition([
    daily('us10yYield', (index) => (index < 2509 ? 4 : 4 + ((index - 2509) * 0.0055))),
    daily('realYield10y', () => 1.8),
    daily('breakeven10y', (index) => (index < 2509 ? 2.2 : 2.2 + ((index - 2509) * 0.0055))),
  ]);
  const quarter = model.windows.find((entry) => entry.days === 91);
  assert.equal(quarter.driver, 'inflation compensation');
  assert.match(model.read, /inflation compensation did the work/);
});

test('the nominal residual is published rather than folded into a leg', () => {
  // The three series genuinely do not reconcile: nominal moves 50bp while the
  // two components move 30bp between them.
  const model = calculateNominalDecomposition([
    daily('us10yYield', (index) => (index < 2509 ? 4 : 4 + ((index - 2509) * 0.0055))),
    daily('realYield10y', (index) => (index < 2509 ? 1.8 : 1.8 + ((index - 2509) * 0.0022))),
    daily('breakeven10y', (index) => (index < 2509 ? 2.2 : 2.2 + ((index - 2509) * 0.0011))),
  ]);
  const quarter = model.windows.find((entry) => entry.days === 91);
  assert.equal(Math.abs(quarter.residualBasisPoints) > 5, true, `residual was ${quarter.residualBasisPoints}`);
  assert.match(model.read, /residual remains/);
});

test('the nominal decomposition names the leg it is missing', () => {
  const model = calculateNominalDecomposition([daily('us10yYield', () => 4), daily('realYield10y', () => 1.8)]);
  assert.equal(model.status, 'unavailable');
  assert.deepEqual(model.missing, ['FRED T10YIE 10-year breakeven']);
});

test('the term premium separates a premium-driven move from an expectations-driven one', () => {
  const premiumDriven = calculateTermPremium([
    daily('termPremium10y', (index) => (index < 2509 ? 0.1 : 0.1 + ((index - 2509) * 0.0055))),
    daily('us10yYield', (index) => (index < 2509 ? 4 : 4 + ((index - 2509) * 0.0055))),
  ]);
  const quarter = premiumDriven.windows.find((entry) => entry.days === 91);
  assert.equal(quarter.driver, 'term premium');
  assert.equal(quarter.premiumSharePercent, 100);

  const expectationsDriven = calculateTermPremium([
    daily('termPremium10y', () => 0.1),
    daily('us10yYield', (index) => (index < 2509 ? 4 : 4 + ((index - 2509) * 0.0055))),
  ]);
  assert.equal(expectationsDriven.windows.find((entry) => entry.days === 91).driver, 'rate expectations');
});

test('a negative term premium is called out as such', () => {
  const model = calculateTermPremium([daily('termPremium10y', () => -0.4), daily('us10yYield', () => 4)]);
  assert.equal(model.negative, true);
  assert.match(model.read, /still negative/);
  assert.match(model.methodology, /model estimate, not an observable price/);
});

test('the term premium publishes without the nominal leg but cannot split the move', () => {
  const model = calculateTermPremium([daily('termPremium10y', (index) => 0.1 + (index * 0.0001))]);
  assert.equal(model.status, 'provisional');
  assert.equal(model.windows.find((entry) => entry.days === 91).expectationsBasisPoints, null);
  assert.match(model.windows.find((entry) => entry.days === 91).reason, /nominal 10-year is required/);
});

test('the term premium refuses without its own series', () => {
  const model = calculateTermPremium([daily('us10yYield', () => 4)]);
  assert.equal(model.status, 'unavailable');
  assert.deepEqual(model.missing, ['FRED THREEFYTP10']);
});

test('rate divergence measures the US advantage on the foreign series own dates', () => {
  const model = calculateRateDivergence([
    daily('us10yYield', () => 4.2),
    monthly('germany10y', () => 2.4),
    monthly('japan10y', () => 1.1),
    monthly('uk10y', () => 4.0),
  ]);
  assert.equal(model.status, 'calculated');
  const germany = model.markets.find((market) => market.key === 'germany10y');
  assert.equal(germany.spreadPercent, 1.8, 'US 4.2 minus Germany 2.4');
  assert.equal(germany.cadenceDays >= 28 && germany.cadenceDays <= 31, true, `cadence ${germany.cadenceDays}`);
  assert.equal(model.averageSpreadPercent > 0, true);
  assert.match(model.methodology, /repeated twenty times/);
});

test('rate divergence reads a widening advantage as dollar-supportive', () => {
  const widening = calculateRateDivergence([
    daily('us10yYield', (index) => 2.6 + (index * 0.0008)),
    monthly('germany10y', () => 2.4),
    monthly('japan10y', () => 1.1),
    monthly('uk10y', () => 4.0),
  ]);
  const narrowing = calculateRateDivergence([
    daily('us10yYield', (index) => 5.5 - (index * 0.0008)),
    monthly('germany10y', () => 2.4),
    monthly('japan10y', () => 1.1),
    monthly('uk10y', () => 4.0),
  ]);
  assert.equal(widening.state, 'US yield advantage widening');
  assert.equal(narrowing.state, 'US yield advantage narrowing');
  assert.equal(widening.score > narrowing.score, true);
});

test('rate divergence publishes what it has and names what it lacks', () => {
  const model = calculateRateDivergence([daily('us10yYield', () => 4.2), monthly('germany10y', () => 2.4)]);
  assert.equal(model.status, 'provisional');
  assert.equal(model.markets.find((market) => market.key === 'japan10y').status, 'unavailable');
  assert.match(model.markets.find((market) => market.key === 'japan10y').reason, /Japan long rate/);
  assert.equal(calculateRateDivergence([monthly('germany10y', () => 2.4)]).status, 'unavailable');
});

test('data surprise scores releases against their own trend and says it is not a forecast index', () => {
  const model = calculateDataSurprise([
    monthly('payrolls', (index) => 150 + (index < 60 ? 0 : 90), { count: 72 }),
    monthly('claims', (index) => 220 - (index < 60 ? 0 : 40), { count: 72 }),
  ], { indicators: [{ key: 'payrolls', name: 'Payrolls' }, { key: 'claims', name: 'Jobless claims', inverse: true }] });
  assert.equal(model.status, 'calculated');
  assert.equal(model.composite > 0, true, 'both indicators are running hot');
  assert.equal(model.state, 'Data running above its own trend');
  assert.match(model.methodology, /not a forecast-surprise index/);
});

test('data surprise inverts an indicator where a higher reading is worse', () => {
  const worse = calculateDataSurprise([
    monthly('claims', (index) => 220 + (index < 60 ? 0 : 60), { count: 72 }),
    monthly('payrolls', () => 150, { count: 72 }),
  ], { indicators: [{ key: 'claims', name: 'Jobless claims', inverse: true }, { key: 'payrolls', name: 'Payrolls' }] });
  const claims = worse.indicators.find((entry) => entry.key === 'claims');
  assert.equal(claims.zScore < 0, true, 'rising claims must score negative');
});

test('data surprise refuses with fewer than two scored indicators', () => {
  const model = calculateDataSurprise([monthly('payrolls', (index) => 150 + index, { count: 72 })], {
    indicators: [{ key: 'payrolls', name: 'Payrolls' }, { key: 'missing', name: 'Absent series' }],
  });
  assert.equal(model.status, 'unavailable');
  assert.equal(model.score, null);
  assert.match(model.indicators.find((entry) => entry.key === 'missing').reason, /observations/);
});

test('the liquidity payoff buckets impulses and reports what followed each', () => {
  // Liquidity that alternates between strong and weak quarters, with the asset
  // rising after the strong ones.
  const weeks = 260;
  const liquidity = [];
  let level = 6_000_000;
  for (let index = 0; index < weeks; index += 1) {
    level *= 1 + (index % 26 < 13 ? 0.004 : -0.001);
    liquidity.push({ date: day(index * 7), value: level });
  }
  const asset = Array.from({ length: weeks * 7 }, (_, index) => {
    const phase = Math.floor(index / 7) % 26;
    return { date: day(index), value: 100 * (1 + (index * 0.0002) + (phase < 13 ? 0.02 : -0.01)) };
  });
  const model = calculateLiquidityPayoff(liquidity, asset);
  assert.equal(model.status, 'calculated');
  assert.equal(model.buckets.length, 3);
  model.buckets.forEach((bucket) => {
    assert.equal(bucket.observations >= 8, true);
    assert.equal(Number.isFinite(bucket.averageForwardPercent), true);
  });
  assert.match(model.methodology, /not independent/);
  assert.match(model.methodology, /Nothing here is out of sample/);
});

test('the liquidity payoff drops samples whose forward window has not closed', () => {
  const weeks = 200;
  const liquidity = Array.from({ length: weeks }, (_, index) => ({ date: day(index * 7), value: 6_000_000 * (1.002 ** index) }));
  // The asset history stops well before the liquidity history does.
  const asset = Array.from({ length: 900 }, (_, index) => ({ date: day(index), value: 100 + (index * 0.02) }));
  const model = calculateLiquidityPayoff(liquidity, asset);
  if (model.status === 'calculated') {
    assert.equal(model.samples < weeks, true, 'samples past the asset history must be dropped');
    assert.equal(new Date(model.asOf) <= new Date(asset.at(-1).date), true);
  } else {
    assert.match(model.reason, /closed forward window/);
  }
});

test('the liquidity payoff refuses histories too short to bucket', () => {
  const model = calculateLiquidityPayoff(
    Array.from({ length: 20 }, (_, index) => ({ date: day(index * 7), value: 6_000_000 })),
    Array.from({ length: 300 }, (_, index) => ({ date: day(index), value: 100 })),
  );
  assert.equal(model.status, 'unavailable');
  assert.deepEqual(model.buckets, []);
});

test('reserve scarcity reads SOFR above the reserve rate as tightening', () => {
  const scarce = calculateReserveScarcity([
    daily('sofr', (index) => 5.33 + (index > 2500 ? 0.0012 * (index - 2500) : 0)),
    daily('iorb', () => 5.33),
  ]);
  assert.equal(['Reserves tightening', 'Reserves scarce'].includes(scarce.state), true, `state was ${scarce.state}`);
  assert.equal(scarce.spreadBasisPoints > 5, true);
  assert.equal(scarce.daysAboveThreshold > 0, true);

  const ample = calculateReserveScarcity([daily('sofr', () => 5.31), daily('iorb', () => 5.33)]);
  assert.equal(ample.state, 'Reserves abundant');
  assert.equal(ample.spreadBasisPoints < 0, true);
});

test('reserve scarcity names the missing leg and the facility it cannot see', () => {
  const model = calculateReserveScarcity([daily('sofr', () => 5.33)]);
  assert.equal(model.status, 'unavailable');
  assert.deepEqual(model.missing, ['FRED IORB']);
  const full = calculateReserveScarcity([daily('sofr', () => 5.33), daily('iorb', () => 5.33)]);
  assert.match(full.methodology, /Standing Repo Facility take-up/);
});

test('a distribution with no real spread is not ranked by float dust', () => {
  // Four perfectly linear series score an identical surprise every release. The
  // old rank returned 100th, 31st and 22nd percentiles for identical values.
  const model = calculateDataSurprise([
    monthly('a', (index) => 100 + index, { count: 72 }),
    monthly('b', (index) => 200 + (index * 2), { count: 72 }),
  ], { indicators: [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }] });
  const [first, second] = model.indicators;
  assert.equal(first.zScore, second.zScore, 'the fixtures score identically by construction');
  assert.equal(first.percentile, null);
  assert.equal(second.percentile, null);
});

test('a distribution with real spread still ranks', () => {
  const model = calculateDataSurprise([
    monthly('a', (index) => 100 + (index * 2) + (Math.sin(index / 3) * 8), { count: 72 }),
    monthly('b', (index) => 200 + index + (Math.cos(index / 4) * 6), { count: 72 }),
  ], { indicators: [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }] });
  model.indicators.forEach((indicator) => {
    assert.equal(Number.isFinite(indicator.percentile), true, `${indicator.key} could not be ranked`);
  });
});
