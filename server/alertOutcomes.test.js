import test from 'node:test';
import assert from 'node:assert/strict';
import { baseRate, claimFor, prepareHistory, scoreAlertOutcomes } from './alertOutcomes.js';

const START = Date.parse('2022-01-01T00:00:00Z');
const DAY = 86_400_000;
const dateAt = (day) => new Date(START + day * DAY).toISOString().slice(0, 10);
const series = (days, valueAt) => Array.from({ length: days }, (_unused, day) => ({ date: dateAt(day), value: valueAt(day) }));
const alertAt = (modelId, key, day, hour = 15) => ({ modelId, key, text: `${key} fired`, detectedAt: new Date(START + day * DAY + hour * 3_600_000).toISOString() });

test('each alert kind maps to the claim it makes, and unknown ones are not guessed', () => {
  assert.deepEqual(claimFor({ modelId: 'macro-alerts-v1', key: 'curve-uninverted' }), { group: 'macro:curve-uninverted', label: 'Curve un-inverted', asset: 'SPY', claim: 'risk-off' });
  assert.equal(claimFor({ modelId: 'macro-alerts-v1', key: 'curve-uninverted:resolved' }).claim, 'eventful');
  assert.equal(claimFor({ modelId: 'macro-alerts-v1', key: 'models-divided' }).claim, 'eventful');
  assert.deepEqual(claimFor({ modelId: 'screener-v1', key: 'NVDA' }), { group: 'screener-breakout', label: 'Screener breakouts', asset: 'NVDA', claim: 'outperform' });
  assert.equal(claimFor({ modelId: 'bitcoin-cycle', key: 'bitcoin-cycle:phase' }).asset, 'BTC-USD');
  assert.equal(claimFor({ modelId: 'macro-alerts-v1', key: 'something-new' }), null);
  assert.equal(claimFor({ modelId: 'screener-v1', key: 'not a symbol' }), null);
  assert.equal(claimFor({ modelId: 'mystery' }), null);
});

test('history is de-duplicated per day and sorted, and the base rate is the asset’s own', () => {
  const prepared = prepareHistory([{ date: '2024-01-03', value: 3 }, { timestamp: '2024-01-01T21:00:00Z', value: 1 }, { date: '2024-01-03', value: 4 }, { date: '2024-01-02', value: -1 }]);
  assert.deepEqual(prepared.map((point) => point.value), [1, 4]);
  // A steady 0.1% a day: every 30-day forward return is the same.
  const steady = prepareHistory(series(400, (day) => 100 * 1.001 ** day));
  const base = baseRate(steady, 30);
  assert.ok(Math.abs(base.median - (1.001 ** 30 - 1)) < 1e-9);
  assert.equal(baseRate(prepareHistory(series(50, () => 1)), 30), null, 'too little history publishes no base rate');
});

// SPY rises 0.1% a day, except for six 40-day declines of 0.3% a day. A
// warning raised just before each decline was right; one raised in a calm
// stretch was wrong.
const DECLINES = [100, 250, 400, 550, 700, 850];
function spyWithDeclines(days) {
  let value = 100;
  return series(days, (day) => {
    if (day > 0) value *= DECLINES.some((start) => day > start && day <= start + 40) ? 0.997 : 1.001;
    return value;
  });
}

test('risk-off warnings before declines are right, and the base rate is SPY’s own drift', () => {
  const histories = new Map([['SPY', spyWithDeclines(1100)]]);
  const alerts = [
    ...DECLINES.map((day) => alertAt('macro-alerts-v1', 'reserves-tightening', day - 1)),
    alertAt('macro-alerts-v1', 'reserves-tightening', 1000),
  ];
  const result = scoreAlertOutcomes({ alerts, histories, horizons: [30] });
  assert.equal(result.status, 'calculated');
  const group = result.groups.find((entry) => entry.id === 'macro:reserves-tightening');
  const stats = group.horizons[0];
  assert.equal(stats.matured, 7);
  assert.equal(stats.effective, 7);
  assert.equal(stats.status, 'thin');
  assert.equal(stats.rightRate, 86, 'six of seven warnings preceded a decline');
  assert.ok(stats.medianRelativePercent < 0);
  const calm = result.recent.find((entry) => entry.detectedAt.startsWith(dateAt(1000)));
  assert.equal(calm.outcomes[0].right, false);
  // Six of seven is 1.9 standard errors from a coin flip on seven independent
  // outcomes: suggestive, not distinguishable, and the read must not say more.
  assert.equal(stats.versusChance, 'within');
  assert.match(result.read, /none of the 1 kind of alert with a rate is distinguishable from a coin flip yet: right rates run 86-86%/);
});

test('the entry is the first close after the detection day, never the session it fired in', () => {
  // Flat at 100 through the detection day, 150 from the next day on: an entry
  // on the detection day would book a 50% gain the alert could not capture.
  const histories = new Map([['SPY', series(500, (day) => (day <= 200 ? 100 : 150))]]);
  const result = scoreAlertOutcomes({ alerts: [alertAt('market-heatmap', 'x', 200)], histories, horizons: [30] });
  assert.equal(result.recent[0].outcomes[0].returnPercent, 0);
});

test('alerts that overlap in time count once, and too few independent ones publish no rate', () => {
  const histories = new Map([['SPY', spyWithDeclines(1100)]]);
  const burst = Array.from({ length: 12 }, (_unused, index) => alertAt('macro-alerts-v1', 'curve-inverted', 300 + index));
  const result = scoreAlertOutcomes({ alerts: burst, histories, horizons: [30] });
  const stats = result.groups[0].horizons[0];
  assert.equal(stats.matured, 12);
  assert.equal(stats.effective, 1);
  assert.equal(stats.status, 'insufficient');
  assert.equal(stats.rightRate, undefined);
  assert.equal(result.status, 'provisional');
  assert.match(result.read, /no kind of alert has enough non-overlapping outcomes/);
});

test('a breakout is scored on its excess over SPY, against the stock’s usual excess', () => {
  const spy = series(900, (day) => 100 * 1.0005 ** day);
  // The stock tracks SPY at +0.05% a day extra, except after each breakout
  // date, where it runs 0.4% a day ahead for 30 days.
  const breakouts = [200, 320, 440, 560, 680];
  let stock = 50;
  const stockPoints = series(900, (day) => {
    if (day > 0) stock *= 1.0005 * (breakouts.some((start) => day > start && day <= start + 30) ? 1.004 : 1.0005);
    return stock;
  });
  const histories = new Map([['SPY', spy], ['ABC', stockPoints]]);
  const result = scoreAlertOutcomes({ alerts: breakouts.map((day) => alertAt('screener-v1', 'ABC', day - 1)), histories, horizons: [30] });
  const stats = result.groups[0].horizons[0];
  assert.equal(result.groups[0].claim, 'outperform');
  assert.equal(stats.effective, 5);
  assert.equal(stats.rightRate, 100);
  assert.ok(stats.medianRelativePercent > 5, `${stats.medianRelativePercent}`);
});

test('an informational alert is right when a larger-than-usual move followed, in either direction', () => {
  // Calm drift with four sharp 30-day swings, two up and two down.
  const swings = [{ start: 200, rate: 1.01 }, { start: 400, rate: 0.99 }, { start: 600, rate: 1.01 }, { start: 800, rate: 0.99 }];
  let value = 100;
  const btc = series(1000, (day) => {
    if (day > 0) value *= swings.find((swing) => day > swing.start && day <= swing.start + 30)?.rate ?? 1.0003;
    return value;
  });
  const result = scoreAlertOutcomes({ alerts: swings.map((swing) => alertAt('bitcoin-cycle', 'phase', swing.start - 1)), histories: new Map([['BTC-USD', btc]]), horizons: [30] });
  const stats = result.groups[0].horizons[0];
  assert.equal(stats.rightRate, 100);
  assert.ok(stats.medianMove > 3);
});

test('alerts too recent for a horizon are pending, missing histories are not scored as misses', () => {
  const histories = new Map([['SPY', series(400, (day) => 100 + day)]]);
  const result = scoreAlertOutcomes({
    alerts: [alertAt('macro-alerts-v1', 'quarter-end', 390), alertAt('screener-v1', 'ZZZ', 100), alertAt('unknown-model', 'x', 100)],
    histories,
    horizons: [30],
  });
  const quarter = result.groups.find((group) => group.id === 'macro:quarter-end').horizons[0];
  assert.equal(quarter.pending, 1);
  assert.equal(quarter.matured, 0);
  const screener = result.groups.find((group) => group.id === 'screener-breakout').horizons[0];
  assert.equal(screener.missing, 1);
  assert.deepEqual(result.unscored, [{ modelId: 'unknown-model', count: 1 }]);
  assert.equal(result.scoredAlerts, 2);
});

test('with no stored alerts the record is unavailable and says why', () => {
  const result = scoreAlertOutcomes({ alerts: [], histories: new Map() });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /No alerts are stored/);
});

test('the read names only kinds that clear chance, including ones reliably wrong, never just the best', () => {
  // Twenty 40-day declines, 60 days apart. Warnings before each are right;
  // "un-inverted" alerts placed after each decline ends (in the rebound) are
  // reliably wrong; a third kind fires at random-ish calm points.
  const starts = Array.from({ length: 20 }, (_unused, index) => 100 + index * 60);
  let value = 100;
  const spy = series(1400, (day) => {
    if (day > 0) value *= starts.some((start) => day > start && day <= start + 40) ? 0.997 : 1.002;
    return value;
  });
  const alerts = [
    ...starts.map((start) => alertAt('macro-alerts-v1', 'reserves-tightening', start - 1)),
    ...starts.map((start) => alertAt('macro-alerts-v1', 'curve-uninverted', start + 40)),
    ...starts.slice(0, 6).map((start, index) => alertAt('macro-alerts-v1', 'rrp-exhaustion', start + (index % 2 ? 41 : -1))),
  ];
  const result = scoreAlertOutcomes({ alerts, histories: new Map([['SPY', spy]]), horizons: [30] });
  const byId = Object.fromEntries(result.groups.map((group) => [group.id, group.horizons[0]]));
  assert.equal(byId['macro:reserves-tightening'].versusChance, 'above');
  assert.equal(byId['macro:curve-uninverted'].versusChance, 'below');
  assert.equal(byId['macro:rrp-exhaustion'].versusChance, 'within');
  assert.match(result.read, /\u201cReserves tightening\u201d at 100% over 20 independent is right more often than chance allows/);
  assert.match(result.read, /\u201cCurve un-inverted\u201d at 0% over 20 independent is wrong more often than chance allows/);
  assert.match(result.read, /The other kind is within chance\./);
});
