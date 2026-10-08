import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLICATION_LAG_DAYS,
  addDays,
  calculateVerdictRecord,
  closesAsOf,
  forwardReturn,
  macroLegsAsOf,
  prepareSeriesList,
  replayVerdicts,
  seriesListAsOf,
  replayDates,
} from './verdictTrackRecord.js';
import { calculateGlobalLiquidityModel } from './analytics.js';

let seed = 5;
const noise = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed / 2147483648) - 0.5; };
const START = Date.UTC(2014, 0, 1);
const YEARS = 8;

function dated(stepDays, valueAt, { weekdays = false } = {}) {
  const points = [];
  for (let day = 0; day < YEARS * 365; day += stepDays) {
    const date = new Date(START + (day * 86_400_000));
    if (weekdays && (date.getUTCDay() === 0 || date.getUTCDay() === 6)) continue;
    points.push({ date: date.toISOString().slice(0, 10), value: valueAt(day) });
  }
  return points;
}
const monthly = (valueAt) => dated(1, valueAt).filter((point) => point.date.endsWith('-01'));
const series = (key, history, multiplier = 1) => ({ key, id: key, name: key, multiplier, history });
const wave = (day, period, amplitude) => amplitude * Math.sin((2 * Math.PI * day) / period);

// A liquidity cycle the dollar and gold respond to, with noise, so the
// replayed verdict has something to find and something to miss.
const macroSeries = () => [
  series('fedBalanceSheet', dated(7, (day) => 6_000_000 + (day * 400) + wave(day, 900, 600_000))),
  series('treasuryGeneralAccount', dated(7, (day) => 700_000 + wave(day, 365, 150_000))),
  series('reverseRepo', dated(1, (day) => Math.max(5, 800 + wave(day, 700, 700)), { weekdays: true }), 1000),
  series('usM2', monthly((day) => 15_000 + (day * 2) + wave(day, 900, 400)), 1000),
  series('dxy', dated(1, (day) => 110 - wave(day, 900, 8) + (noise() * 0.6), { weekdays: true })),
  series('realYield10y', dated(1, (day) => 1 - wave(day, 900, 1) + (noise() * 0.05), { weekdays: true })),
  series('us2yYield', dated(1, (day) => 2.5 - wave(day, 900, 1.5) + (noise() * 0.05), { weekdays: true })),
  series('us10yYield', dated(1, (day) => 3 - wave(day, 900, 1) + (noise() * 0.05), { weekdays: true })),
  series('financialConditions', dated(7, (day) => -0.4 - wave(day, 900, 0.3))),
  series('vix', dated(1, (day) => 18 - wave(day, 900, 5) + (noise() * 2), { weekdays: true })),
  series('ecbBalanceSheet', dated(7, (day) => 5_000_000 + wave(day, 900, 500_000))),
  series('bojBalanceSheet', monthly((day) => 6_000_000 + (day * 300) + wave(day, 900, 300_000))),
  series('eurUsd', dated(1, (day) => 1.1 + wave(day, 900, 0.06) + (noise() * 0.005), { weekdays: true })),
  series('yenPerUsd', dated(1, (day) => 120 - wave(day, 900, 8) + (noise() * 0.5), { weekdays: true })),
  series('germany10y', monthly((day) => 1 + wave(day, 900, 0.5))),
  series('japan10y', monthly((day) => 0.2 + wave(day, 900, 0.1))),
  series('uk10y', monthly((day) => 2 + wave(day, 900, 0.6))),
];
const gold = dated(1, (day) => 1300 * Math.exp(day / 3000) * (1 + wave(day + 90, 900, 0.12)) * (1 + (noise() * 0.01)), { weekdays: true });
const bitcoin = dated(1, (day) => 600 * Math.exp(day / 900) * (1 + wave(day + 90, 900, 0.35)) * (1 + (noise() * 0.03)));

test('a series is cut off at what had been published, observation date plus its lag', () => {
  const prepared = prepareSeriesList(macroSeries());
  const asOf = '2018-03-15';
  const list = seriesListAsOf(prepared, asOf);
  const m2 = list.find((item) => item.key === 'usM2');
  // M2 for February is published in late March; on the 15th, January's is the latest known.
  assert.equal(m2.date, '2018-01-01');
  assert.equal(addDays(m2.date, PUBLICATION_LAG_DAYS.usM2) <= asOf, true);
  const dollar = list.find((item) => item.key === 'dxy');
  assert.ok(dollar.date < asOf && dollar.date >= '2018-03-12', dollar.date);
  for (const item of list) assert.ok(item.history.every((point) => point.date <= asOf), item.key);
});

test('a model run on the cut list matches the model run on a list truncated by hand', () => {
  const full = macroSeries();
  const prepared = prepareSeriesList(full);
  const asOf = '2019-06-05';
  const lagOf = (key) => PUBLICATION_LAG_DAYS[key] ?? 1;
  const manual = full.map((item) => ({ ...item, history: item.history.filter((point) => addDays(point.date, lagOf(item.key)) <= asOf) }));
  assert.equal(calculateGlobalLiquidityModel(seriesListAsOf(prepared, asOf)).score, calculateGlobalLiquidityModel(manual).score);
});

test('macro legs on a date never change when later data is added', () => {
  const full = macroSeries();
  const cut = full.map((item) => ({ ...item, history: item.history.filter((point) => point.date <= '2019-12-31') }));
  for (const date of ['2017-05-03', '2018-11-21', '2019-09-04']) {
    const fromFull = macroLegsAsOf(prepareSeriesList(full), date);
    const fromCut = macroLegsAsOf(prepareSeriesList(cut), date);
    assert.equal(fromFull.usdStrength?.score, fromCut.usdStrength?.score, date);
    assert.equal(fromFull.globalLiquidity?.score, fromCut.globalLiquidity?.score, date);
  }
});

test('trimming each series to six years leaves every score the verdicts read unchanged', () => {
  const prepared = prepareSeriesList(macroSeries());
  for (const date of ['2020-02-05', '2021-07-14']) {
    const trimmed = macroLegsAsOf(prepared, date);
    const whole = macroLegsAsOf(prepared, date, { trailingDays: null });
    assert.equal(trimmed.globalLiquidity.score, whole.globalLiquidity.score, date);
    assert.equal(trimmed.globalLiquidity.regime, whole.globalLiquidity.regime, date);
    // The dollar's moving averages and MACD settle within months; a point of
    // rounding is the most six years against eight can move it.
    assert.ok(Math.abs(trimmed.usdStrength.score - whole.usdStrength.score) <= 1, `${date}: ${trimmed.usdStrength.score} vs ${whole.usdStrength.score}`);
  }
});

test('forward returns read the last close on or before each end, and stop where the history does', () => {
  const points = [
    { date: '2020-01-01', value: 100 },
    { date: '2020-01-03', value: 110 },
    { date: '2020-02-03', value: 121 },
  ];
  assert.equal(Math.round(forwardReturn(points, '2020-01-02', 30) * 100) / 100, 10);
  assert.equal(forwardReturn(points, '2020-01-10', 30), null);
  // After date minus the lookback, through the date itself.
  assert.deepEqual(closesAsOf(points, '2020-01-03', 2).map((point) => point.date), ['2020-01-03']);
  assert.deepEqual(closesAsOf(points, '2020-01-03', 3).map((point) => point.date), ['2020-01-01', '2020-01-03']);
  assert.deepEqual(replayDates('2020-01-01', '2020-01-20', 7), ['2020-01-01', '2020-01-08', '2020-01-15']);
  assert.deepEqual(replayDates('2020-01-01', '2020-01-20'), ['2020-01-01', '2020-01-15']);
});

test('the replayed verdicts are scored on the dates their inputs allow', { timeout: 120_000 }, async () => {
  // The replay yields while it works: a timer set now fires before it finishes.
  let ticked = false;
  setTimeout(() => { ticked = true; }, 0);
  const records = await replayVerdicts({ seriesList: macroSeries(), closes: { gold, bitcoin } });
  assert.equal(ticked, true);
  for (const key of ['metals', 'crypto']) {
    const record = records[key];
    assert.equal(record.status, 'calculated', `${key}: ${record.reason}`);
    // The bitcoin technicals count only once fully backed - about four years
    // of closes for the long moving averages - as they do live.
    assert.ok(record.readings > (key === 'crypto' ? 90 : 150), `${key}: ${record.readings}`);
    assert.equal(record.stepDays, 14);
    assert.deepEqual(record.record.horizons.map((horizon) => horizon.days), [30, 90, 180]);
    assert.equal(record.timeInCall.reduce((total, entry) => total + entry.readings, 0), record.readings);
    assert.match(record.read, /not what will\./);
    assert.doesNotMatch(record.read, /undefined|NaN|null/);
    assert.ok(record.legs.length >= 3, key);
    // Legs are counted at the replay's own step and read at the record's own
    // horizon: every leg has enough independent windows to rank in some block.
    assert.ok(record.legs.every((leg) => leg.summary?.days === record.record.readHorizonDays), JSON.stringify(record.legs.map((leg) => leg.summary)));
    assert.match(record.read, new RegExp(`over ${record.record.readHorizonDays} days`));
  }
  assert.deepEqual(records.crypto.omitted, ['Perpetual funding (inverted)', 'Stablecoin supply']);
  assert.match(records.crypto.methodology, /left out/);
  // Eight years of gold readings give every leg enough independent windows to
  // rank; the bitcoin replay starts four years in, once its technicals are
  // fully backed, and is too short here for that.
  assert.ok(records.metals.legs.every((leg) => leg.summary.verdict !== 'thin'), JSON.stringify(records.metals.legs.map((leg) => leg.summary)));
  // The gold verdict's legs are the three the live builder reads, at their live weights.
  assert.deepEqual(records.metals.legs.map((leg) => [leg.key, leg.weight]), [['technicals', 50], ['dollar', 30], ['globalLiquidity', 20]]);
});

test('too few replayable dates refuses rather than reporting a thin record', () => {
  const samples = Array.from({ length: 40 }, (_, index) => ({ date: addDays('2020-01-01', index * 7), call: 'Neutral', score: 50, signals: {}, signalNames: {} }));
  const record = calculateVerdictRecord({ key: 'metals', samples, closes: gold });
  assert.equal(record.status, 'unavailable');
  assert.match(record.reason, /52/);
  assert.equal(calculateVerdictRecord({ key: 'nope', samples, closes: gold }).status, 'unavailable');
});
