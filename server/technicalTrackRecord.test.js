import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTechnicalSnapshot } from './analytics.js';
import { TECHNICAL_COMPONENTS, componentBand, describeTechnicalComponents, ownHistoryBands, describeTechnicalRecord, pooledComponentRecords, technicalTrackRecord } from './technicalTrackRecord.js';

function series(count, valueAt) {
  const out = [];
  for (let offset = 0; out.length < count; offset += 1) {
    const date = new Date(Date.UTC(2015, 0, 1) + (offset * 86_400_000));
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    out.push({ date: date.toISOString().slice(0, 10), value: valueAt(out.length) });
  }
  return out;
}
let seed = 7;
const noise = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed / 2147483648) - 0.5; };
const cycle = series(2600, (index) => 100 * Math.exp((index / 2600) * 1.4) * (1 + (0.3 * Math.sin(index / 120))) * (1 + (0.02 * noise())));

test('every weekly regime is scored only from closes available that week', () => {
  // Truncation proof: the regime scored at a past week must not change when
  // the history after it is removed.
  const full = technicalTrackRecord({ points: cycle });
  const cut = cycle.slice(0, 1800);
  const truncated = technicalTrackRecord({ points: cut });
  const byDate = (record) => new Map(record.observations.map((observation) => [observation.date, observation.label]));
  const fullLabels = byDate(full);
  let compared = 0;
  for (const [date, label] of byDate(truncated)) {
    assert.equal(fullLabels.get(date), label, `regime on ${date} changed when later data was removed`);
    compared += 1;
  }
  assert.ok(compared > 100);
});

test('the current regime is measured the same way as the history', () => {
  const record = technicalTrackRecord({ points: cycle });
  const window = cycle.slice(-record.observations.length > 0 ? -Math.round(420 * ((cycle.length - 1) / ((Date.parse(cycle.at(-1).date) - Date.parse(cycle[0].date)) / 86_400_000))) : 0);
  const direct = calculateTechnicalSnapshot(window.map((point) => ({ timestamp: `${point.date}T00:00:00.000Z`, value: point.value })));
  assert.equal(record.current.regime, direct.regime);
  assert.equal(record.current.score, direct.score);
});

test('a trend-following score on a cyclical series ranks its regimes as assumed', () => {
  const record = technicalTrackRecord({ points: cycle });
  const ninety = record.horizons.find((horizon) => horizon.days === 90);
  const constructive = ninety.states.find((state) => state.key === 'Constructive').development.stats;
  const guarded = ninety.states.find((state) => state.key === 'Guarded').development.stats;
  assert.ok(constructive.median > guarded.median, `${constructive.median} vs ${guarded.median}`);
  assert.ok(ninety.development.ordering > 0);
});

test('the read speaks about the horizon it chose and never prints a missing number', () => {
  const record = technicalTrackRecord({ points: cycle });
  const { text, days } = describeTechnicalRecord(record, 'Test', record.current.regime);
  assert.ok([30, 90, 180].includes(days));
  assert.match(text, new RegExp(`over ${days} days`));
  assert.doesNotMatch(text, /undefined|NaN|null/);
  assert.match(text, /not what will\.$/);
});

test('a short history refuses', () => {
  const record = technicalTrackRecord({ points: cycle.slice(0, 300) });
  assert.equal(record.status, 'unavailable');
  assert.match(record.reason, /500 daily closes/);
});

test('components are banded with the regime\'s own cutoffs', () => {
  assert.equal(componentBand(65), 'high');
  assert.equal(componentBand(64), 'middle');
  assert.equal(componentBand(36), 'middle');
  assert.equal(componentBand(35), 'low');
  assert.equal(componentBand(null), null);
  assert.equal(componentBand(Number.NaN), null);
});

test('the component list matches the score\'s own weights', () => {
  // technical-v1 blends trend 40%, momentum 35%, RSI 20% and volatility 5%;
  // a component left out would leave part of the score unexplained.
  const snapshot = calculateTechnicalSnapshot(cycle.slice(0, 500).map((point) => ({ timestamp: `${point.date}T00:00:00.000Z`, value: point.value })));
  for (const component of TECHNICAL_COMPONENTS) assert.ok(Number.isFinite(snapshot.components[component.key]), component.key);
  assert.equal(TECHNICAL_COMPONENTS.reduce((total, component) => total + component.weight, 0), 100);
});

test('each component is replayed on the regime\'s weeks, the own-history ones after a year of them', () => {
  const record = technicalTrackRecord({ points: cycle });
  for (const component of TECHNICAL_COMPONENTS) {
    const list = record.componentObservations[component.key];
    const expected = component.banding === 'fixed' ? record.observations : record.observations.slice(52);
    assert.deepEqual(list.map((observation) => observation.date), expected.map((observation) => observation.date), component.key);
    assert.ok(list.every((observation) => ['high', 'middle', 'low'].includes(observation.label)), component.key);
    // Same weeks, same forward returns: only the label differs.
    assert.deepEqual(list.map((observation) => observation.returns), expected.map((observation) => observation.returns), component.key);
  }
});

test('own-history bands use only earlier readings', () => {
  const readings = Array.from({ length: 200 }, (_, index) => 50 + (30 * Math.sin(index / 9)) + (index % 7));
  const full = ownHistoryBands(readings, 52);
  const cut = ownHistoryBands(readings.slice(0, 120), 52);
  assert.deepEqual(full.slice(0, 120), cut);
  assert.ok(full.slice(0, 52).every((band) => band === null));
  assert.ok(full.slice(52).every((band) => ['high', 'middle', 'low'].includes(band)));
});

test('own-history bands split ties evenly rather than pushing them to one end', () => {
  // A component pinned at 100 for half its history: a new 100 sits mid-pack
  // among the earlier 100s, so it is not automatically "high".
  const pinned = [...Array.from({ length: 30 }, () => 100), ...Array.from({ length: 30 }, (_, index) => index)];
  assert.equal(ownHistoryBands([...pinned, 100], 52).at(-1), 'high');
  const allPinned = Array.from({ length: 60 }, () => 100);
  assert.equal(ownHistoryBands([...allPinned, 100], 52).at(-1), 'middle');
  assert.equal(ownHistoryBands([1, 2, 3, 4, 5, 6], 3).slice(3).join(','), 'high,high,high');
  assert.equal(ownHistoryBands([6, 5, 4, 3, 2, 1], 3).slice(3).join(','), 'low,low,low');
});

test('pooled component records summarize each component in the score\'s order', () => {
  const record = technicalTrackRecord({ points: cycle });
  const components = pooledComponentRecords(record.componentObservations, { days: 90 });
  assert.deepEqual(components.map((component) => component.key), TECHNICAL_COMPONENTS.map((component) => component.key));
  for (const component of components) {
    assert.equal(component.record.status, 'calculated', component.key);
    assert.ok([30, 90, 180].includes(component.summary.days), String(component.summary.days));
    assert.ok(['held', 'held-recent', 'faded', 'reversed', 'no-order', 'untested', 'thin'].includes(component.summary.verdict), component.summary.verdict);
  }
  // On a cyclical series the trend legs lead; trend alignment ranks as the
  // score assumes before the cutoff.
  const trend = components.find((component) => component.key === 'trend');
  assert.ok(trend.summary.developmentOrdering > 0, String(trend.summary.developmentOrdering));
  const read = describeTechnicalComponents(components, 90);
  assert.match(read, /^Ranked on its own over 90 days, trend alignment /);
  assert.match(read, /; RSI /);
  assert.match(read, /; and volatility quality [^;]+\.$/);
  assert.doesNotMatch(read, /undefined|NaN|null/);
});

test('a component with no observations reports itself unavailable, not as a verdict', () => {
  const components = pooledComponentRecords({}, { days: 90 });
  assert.equal(components.length, TECHNICAL_COMPONENTS.length);
  assert.ok(components.every((component) => component.summary === null && component.record.status === 'unavailable'));
  assert.match(describeTechnicalComponents(components, 90), /could not be replayed\.$/);
});
