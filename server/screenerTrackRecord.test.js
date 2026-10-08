import test from 'node:test';
import assert from 'node:assert/strict';
import { alignToAxis, calculateScreenerTrackRecord, featuresAt } from './screenerTrackRecord.js';

function tradingDays(count, start = Date.UTC(2021, 0, 4)) {
  const days = [];
  for (let time = start; days.length < count; time += 86_400_000) {
    const day = new Date(time).getUTCDay();
    if (day !== 0 && day !== 6) days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

function randomSource(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648 - 0.5;
  };
}

// A universe of `count` stocks over `sessions` days. With `persistence`, each
// stock keeps its own drift, so past momentum and trend predict what follows;
// without it every stock is noise around the index.
function universe({ count = 150, sessions = 1260, persistence = true, seed = 7 }) {
  const random = randomSource(seed);
  const axis = tradingDays(sessions);
  let index = 100;
  const benchmark = axis.map((date) => {
    index *= 1 + 0.0003 + 0.008 * random();
    return { date, value: index };
  });
  const histories = new Map();
  for (let stock = 0; stock < count; stock += 1) {
    const drift = persistence ? ((stock / count) - 0.5) * 0.002 : 0;
    let price = 50;
    histories.set(`S${stock}`, axis.map((date, day) => {
      const market = day ? benchmark[day].value / benchmark[day - 1].value - 1 : 0;
      price *= 1 + market + drift + 0.02 * random();
      return { date, value: price };
    }));
  }
  return { histories, benchmark };
}

test('with persistent drifts the top fifth beats the bottom fifth, in order, out of sample too', () => {
  const result = calculateScreenerTrackRecord(universe({ persistence: true }));
  assert.equal(result.status, 'calculated', result.reason);
  assert.ok(result.replayDates >= 40, `${result.replayDates} replay dates`);
  const horizon = result.horizons.find((entry) => entry.days === 90);
  const top = horizon.states[0].heldOut.stats.median;
  const bottom = horizon.states.at(-1).heldOut.stats.median;
  assert.ok(top > bottom, `top ${top} vs bottom ${bottom}`);
  assert.ok(horizon.heldOut.ordering >= 0.6, `ordering ${horizon.heldOut.ordering}`);
  assert.match(result.read, /stocks in the top fifth of the score went on to a median/);
  assert.match(result.read, /ranked (mostly )?in the order the score assumes/);
});

test('with no persistent edge the spread is near zero and the fifths do not line up', () => {
  const result = calculateScreenerTrackRecord(universe({ persistence: false, seed: 11 }));
  assert.equal(result.status, 'calculated', result.reason);
  const horizon = result.horizons.find((entry) => entry.days === 30);
  const spread = horizon.states[0].development.stats.median - horizon.states.at(-1).development.stats.median;
  assert.ok(Math.abs(spread) < 1.5, `spread ${spread}`);
  assert.ok(Math.abs(horizon.development.ordering ?? 0) < 0.8, `ordering ${horizon.development.ordering}`);
});

test('the score at a date uses only closes up to that date', () => {
  const values = Array.from({ length: 300 }, (_unused, index) => 100 + index * 0.1);
  const before = featuresAt(values, 250);
  const altered = values.map((value, index) => (index > 250 ? value * 50 : value));
  assert.deepEqual(featuresAt(altered, 250), before, 'changing the future changes nothing');
  assert.ok(Math.abs(before.mom20 - ((125 / 123 - 1) * 100)) < 1e-9);
  assert.equal(featuresAt(values, 150), null, 'too little history for a 200-day average');
});

test('a missing day stays missing on the axis rather than shifting later closes earlier', () => {
  const axis = ['2026-01-05', '2026-01-06', '2026-01-07'];
  assert.deepEqual(alignToAxis([{ date: '2026-01-05', value: 10 }, { date: '2026-01-07', value: 12 }], axis), [10, null, 12]);
});

test('too short a history refuses with a reason', () => {
  const short = universe({ count: 120, sessions: 300 });
  const result = calculateScreenerTrackRecord(short);
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /two years of benchmark closes/);
});
