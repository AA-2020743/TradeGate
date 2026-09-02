import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCUMULATION_TIERS,
  allocateAcrossAssets,
  backtestAccumulation,
  calculateAccumulationSchedule,
  prepareAccumulationSeries,
  riskAt,
  riskAtPrice,
} from './accumulation.js';

/** Deterministic noise: the tests must not be able to pass or fail by luck. */
function noise(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return (state / 2147483648) - 0.5;
  };
}

function series(count, valueAt, { weekdaysOnly = true, start = Date.UTC(2015, 0, 1) } = {}) {
  const points = [];
  for (let offset = 0; points.length < count; offset += 1) {
    const date = new Date(start + (offset * 86_400_000));
    if (weekdaysOnly && (date.getUTCDay() === 0 || date.getUTCDay() === 6)) continue;
    points.push({ date: date.toISOString().slice(0, 10), value: valueAt(points.length) });
  }
  return points;
}

const cyclical = (phase = 0, seed = 7) => {
  const jitter = noise(seed);
  return series(2600, (index) => 100 * Math.exp((index / 2600) * 1.4) * (1 + (0.45 * Math.sin((index + phase) / 180))) * (1 + (0.02 * jitter())));
};

test('the tier ladder spends the same as a flat schedule on an evenly spread risk distribution', () => {
  // Otherwise the schedule beats flat dollar-cost averaging by deploying more
  // money, and every comparison below measures the budget rather than the rule.
  const total = ACCUMULATION_TIERS.reduce((sum, tier) => sum + tier.multiple, 0);
  assert.equal(total / ACCUMULATION_TIERS.length, 1);
  assert.ok(ACCUMULATION_TIERS.every((tier) => tier.multiple > 0), 'no tier stops buying');
  const multiples = ACCUMULATION_TIERS.map((tier) => tier.multiple);
  assert.deepEqual(multiples, [...multiples].sort((left, right) => right - left), 'cheaper tiers buy more');
});

test('a window stated in years means the same number of years on a five-day and a seven-day market', () => {
  const weekday = prepareAccumulationSeries(series(1200, (index) => 100 + index));
  const daily = prepareAccumulationSeries(series(1200, (index) => 100 + index, { weekdaysOnly: false }));
  assert.equal(weekday.status, 'ready');
  assert.equal(daily.status, 'ready');
  assert.ok(Math.abs(weekday.sessionsPerYear - 261) <= 3, `weekday market resolved to ${weekday.sessionsPerYear} sessions a year`);
  assert.equal(daily.sessionsPerYear, 365);
  // The median gap on a weekday market is one day, so a model that ranked by
  // median spacing would give both markets a 365-session "year".
  assert.ok(weekday.sessions.trend < daily.sessions.trend);
});

test('a schedule refuses rather than ranking against a history with no spread', () => {
  const flat = calculateAccumulationSchedule({ key: 'flat', name: 'Flat', points: series(1500, () => 100) });
  assert.equal(flat.status, 'unavailable');
  assert.match(flat.reason, /components/i);
});

test('a thin history says how much it needs instead of publishing a tier', () => {
  const thin = calculateAccumulationSchedule({ key: 'thin', name: 'Thin', points: series(120, (index) => 100 + index) });
  assert.equal(thin.status, 'unavailable');
  assert.equal(thin.observations, 120);
  assert.match(thin.reason, /250 usable closes/);
});

test('the backtest never uses a price that had not happened yet', () => {
  // The proof is truncation: scoring a session must give the same answer
  // whether or not the rest of the history exists after it.
  const points = cyclical();
  const full = prepareAccumulationSeries(points);
  const cut = 2000;
  const truncated = prepareAccumulationSeries(points.slice(0, cut + 1));
  const fromFull = riskAt(full, cut);
  const fromTruncated = riskAt(truncated, cut);
  assert.equal(fromFull.status, 'calculated');
  assert.equal(fromFull.risk, fromTruncated.risk);
  assert.equal(fromFull.tier.key, fromTruncated.tier.key);
});

test('the published tier and the tier its own backtest scored come from the same code', () => {
  const points = cyclical();
  const schedule = calculateAccumulationSchedule({ key: 'spx', name: 'S&P 500', points });
  const prepared = prepareAccumulationSeries(points);
  const direct = riskAt(prepared, prepared.values.length - 1);
  assert.equal(schedule.risk, direct.risk);
  assert.equal(schedule.multiple, direct.tier.multiple);
  assert.equal(schedule.contribution, schedule.baselineContribution * schedule.multiple);
});

test('the schedule buys more units per dollar than a flat one in a market that mean-reverts', () => {
  const schedule = calculateAccumulationSchedule({ key: 'cycle', name: 'Cyclical', points: cyclical() });
  const { backtest } = schedule;
  assert.equal(backtest.status, 'calculated');
  assert.ok(backtest.costAdvantagePercent < 0, `expected a lower cost per unit, got ${backtest.costAdvantagePercent}%`);
  // And it did it without simply spending more: the capital ratio is the check
  // that makes the cost comparison mean anything.
  assert.ok(Math.abs(backtest.capitalRatio - 1) < 0.15, `capital ratio drifted to ${backtest.capitalRatio}`);
  const shares = backtest.timeInTier.reduce((sum, tier) => sum + tier.sharePercent, 0);
  assert.ok(Math.abs(shares - 100) < 0.5, `time-in-tier shares sum to ${shares}`);
});

test('the schedule barely beats a flat one in a market that only trends, and says so with the number', () => {
  const jitter = noise(11);
  const trending = series(2600, (index) => 100 * Math.exp((index / 2600) * 1.2) * (1 + (0.03 * jitter())));
  const { backtest } = calculateAccumulationSchedule({ key: 'trend', name: 'Trending', points: trending });
  assert.equal(backtest.status, 'calculated');
  // The honest result: buying dips is worth almost nothing when there are no
  // dips. A model that reported a large edge here would be fitting noise.
  assert.ok(Math.abs(backtest.costAdvantagePercent) < 5, `expected a small edge, got ${backtest.costAdvantagePercent}%`);
});

test('a deeply discounted asset draws the heaviest tier and a stretched one the lightest', () => {
  const cheap = calculateAccumulationSchedule({ key: 'cheap', name: 'Cheap', points: cyclical(520, 3) });
  const rich = calculateAccumulationSchedule({ key: 'rich', name: 'Rich', points: cyclical(0, 3) });
  assert.equal(cheap.status, 'calculated');
  assert.equal(rich.status, 'calculated');
  assert.ok(cheap.risk < rich.risk, `${cheap.risk} should be below ${rich.risk}`);
  assert.ok(cheap.multiple > rich.multiple);
});

test('the distance to the next tier is the distance that actually crosses it', () => {
  const schedule = calculateAccumulationSchedule({ key: 'cycle', name: 'Cyclical', points: cyclical() });
  const heavier = schedule.boundaries.toHeavier;
  if (heavier) {
    const tier = ACCUMULATION_TIERS.find((entry) => entry.label === heavier.tier);
    assert.ok(schedule.risk - heavier.points <= tier.max, 'the stated fall does not reach the tier it names');
    assert.ok((schedule.risk - heavier.points) + 1 > tier.max, 'the stated fall overshoots the tier it names');
  }
});

test('an allocation across assets in one tier splits evenly instead of naming an arbitrary leader', () => {
  const schedules = ['A', 'B', 'C'].map((name) => calculateAccumulationSchedule({ key: name, name, points: cyclical(0, 3) }));
  const allocation = allocateAcrossAssets(schedules);
  assert.equal(allocation.status, 'calculated');
  assert.equal(allocation.even, true);
  assert.match(allocation.read, /evenly/);
  assert.ok(!/sends .* to A at/.test(allocation.read), 'an even split must not crown a leader');
});

test('an allocation tilts toward the asset cheapest against its own history', () => {
  const cheap = calculateAccumulationSchedule({ key: 'cheap', name: 'Cheap', points: cyclical(520, 3) });
  const rich = calculateAccumulationSchedule({ key: 'rich', name: 'Rich', points: cyclical(0, 3) });
  const allocation = allocateAcrossAssets([rich, cheap], { budget: 1000 });
  assert.equal(allocation.status, 'calculated');
  assert.equal(allocation.entries[0].key, 'cheap');
  const total = allocation.entries.reduce((sum, entry) => sum + entry.amount, 0);
  assert.ok(Math.abs(total - 1000) < 1, `allocated amounts sum to ${total}`);
});

test('an allocation with one usable asset refuses instead of allocating everything to it', () => {
  const one = calculateAccumulationSchedule({ key: 'one', name: 'One', points: cyclical() });
  const missing = calculateAccumulationSchedule({ key: 'two', name: 'Two', points: series(50, () => 10) });
  const allocation = allocateAcrossAssets([one, missing]);
  assert.equal(allocation.status, 'unavailable');
  assert.match(allocation.reason, /two assets/);
});

test('a backtest with too few completed purchases refuses rather than reporting one path as a result', () => {
  const jitter = noise(5);
  const short = series(1100, (index) => 100 + (index * 0.05) + (30 * Math.sin(index / 90)) + jitter());
  const prepared = prepareAccumulationSeries(short);
  const result = backtestAccumulation(prepared, { cadenceSessions: 60 });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /20 scheduled purchases/);
});

test('every published risk read reconstructs from the components it shows', () => {
  const prepared = prepareAccumulationSeries(cyclical());
  for (const index of [900, 1400, 1900, prepared.values.length - 1]) {
    const read = riskAt(prepared, index);
    if (read?.status !== 'calculated') continue;
    const available = read.components.filter((component) => Number.isFinite(component.percentile));
    const weight = available.reduce((sum, component) => sum + component.weight, 0);
    const rebuilt = Math.round(available.reduce((sum, component) => sum + (component.percentile * component.weight), 0) / weight);
    assert.equal(read.risk, rebuilt, `the risk read at ${index} cannot be rebuilt from its own components`);
  }
});

test('the price ladder is consistent with the risk read it inverts', () => {
  const points = cyclical();
  const prepared = prepareAccumulationSeries(points);
  const schedule = calculateAccumulationSchedule({ key: 'x', name: 'X', points });

  // One quantity, one answer: the risk at today's close must not depend on
  // whether it was read directly or through the price-inversion path.
  assert.equal(riskAtPrice(prepared, schedule.price), schedule.risk);

  const bands = Object.fromEntries(ACCUMULATION_TIERS.map((tier, index) => [
    tier.key,
    { floor: index === 0 ? 0 : ACCUMULATION_TIERS[index - 1].max + 1, ceiling: Number.isFinite(tier.max) ? tier.max : 100 },
  ]));
  for (const step of schedule.priceLadder) {
    if (step.current) {
      assert.equal(step.price, schedule.price);
      continue;
    }
    if (step.price === null) {
      assert.ok(step.reason, `${step.key} is unreachable and must say why`);
      continue;
    }
    // A published price has to actually buy the tier it is printed against,
    // including after being rounded for display.
    const there = riskAtPrice(prepared, step.price);
    assert.ok(there >= bands[step.key].floor && there <= bands[step.key].ceiling,
      `${step.key} names ${step.price} but the read there is ${there}, outside ${bands[step.key].floor}-${bands[step.key].ceiling}`);
  }
});

test('the risk read never falls as price rises', () => {
  // The ladder is found by bisection, which is only valid because the blend of
  // the three components is monotonic in price.
  const prepared = prepareAccumulationSeries(cyclical());
  const spot = prepared.values.at(-1);
  const reads = [0.4, 0.7, 0.9, 1, 1.1, 1.5, 2.5].map((factor) => riskAtPrice(prepared, spot * factor));
  assert.ok(reads.every(Number.isFinite));
  for (let index = 1; index < reads.length; index += 1) {
    assert.ok(reads[index] >= reads[index - 1], `risk fell from ${reads[index - 1]} to ${reads[index]} as price rose`);
  }
});

test('a cheaper asset in a shared tier is not passed over for the one the sort happened to reach first', () => {
  // Six assets across five tiers means ties are the normal case. The read used
  // to name whichever tied asset sorted first, so a panel showing Gold at the
  // 28th percentile announced Bitcoin at the 33rd as the cheapest holding, and
  // the Nasdaq at the 41st as dearer than the S&P at the 54th.
  const at = (key, name, risk, multiple, label) => ({ key, name, risk, multiple, status: 'calculated', tier: { key: label, label, multiple } });
  const allocation = allocateAcrossAssets([
    at('bitcoin', 'Bitcoin', 33, 1.4, 'Discounted'),
    at('gold', 'Gold', 28, 1.4, 'Discounted'),
    at('silver', 'Silver', 36, 1.4, 'Discounted'),
    at('platinum', 'Platinum', 33, 1.4, 'Discounted'),
    at('spx', 'S&P 500', 54, 1, 'Baseline'),
    at('ndx', 'Nasdaq-100', 41, 1, 'Baseline'),
  ]);
  assert.equal(allocation.cheapest.key, 'gold');
  assert.equal(allocation.dearest.key, 'spx');
  assert.match(allocation.read, /Gold is the cheapest/);
  assert.match(allocation.read, /S&P 500 the dearest/);
  assert.ok(!/Bitcoin is the cheapest/.test(allocation.read));
  // Tied assets still share a share, and the order among them is by risk.
  const discounted = allocation.entries.filter((entry) => entry.multiple === 1.4);
  assert.deepEqual(discounted.map((entry) => entry.key), ['gold', 'bitcoin', 'platinum', 'silver']);
});

test('a schedule publishes the limit of ranking an asset against only itself', () => {
  const schedule = calculateAccumulationSchedule({ key: 'x', name: 'X', points: cyclical() });
  assert.match(schedule.limits, /own history/);
  assert.match(schedule.limits, /near its highs/);
});
