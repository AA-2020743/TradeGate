import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTechnicalSnapshot } from './analytics.js';
import { describeTechnicalRecord, technicalTrackRecord } from './technicalTrackRecord.js';

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
