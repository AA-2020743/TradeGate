import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateGoldSilverRecord, ratioState } from './goldSilverRecord.js';

function tradingDays(count) {
  const out = [];
  for (let time = Date.UTC(2005, 0, 3); out.length < count; time += 86_400_000) {
    const day = new Date(time).getUTCDay();
    if (day !== 0 && day !== 6) out.push(new Date(time).toISOString().slice(0, 10));
  }
  return out;
}

function noise(seed) {
  let state = seed;
  return () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648 - 0.5; };
}

// Gold wanders; the log ratio follows `step(previous)`, and silver is gold
// divided by the ratio.
function metals({ sessions = 4000, step, seed = 5 }) {
  const random = noise(seed);
  const axis = tradingDays(sessions);
  let goldLevel = 1000;
  let logRatio = Math.log(70);
  const gold = []; const silver = [];
  axis.forEach((date) => {
    goldLevel *= 1 + 0.01 * random();
    logRatio = step(logRatio, random);
    gold.push({ date, value: goldLevel });
    silver.push({ date, value: goldLevel / Math.exp(logRatio) });
  });
  return { gold, silver };
}

test('labels follow the panel thresholds', () => {
  assert.equal(ratioState(85), 'high');
  assert.equal(ratioState(50), 'middle');
  assert.equal(ratioState(20), 'low');
  assert.equal(ratioState(null), null);
});

test('a mean-reverting ratio reads as reverting: a high ratio is followed by silver catching up', () => {
  // Pulled back toward 70 at 3% of the gap a day.
  const result = calculateGoldSilverRecord(metals({ step: (value, random) => value + 0.03 * (Math.log(70) - value) + 0.02 * random() }));
  assert.equal(result.status, 'calculated', result.reason);
  const horizon = result.record.horizons.find((entry) => entry.days === 30);
  const high = horizon.states.find((state) => state.key === 'high').development.stats.median;
  const low = horizon.states.find((state) => state.key === 'low').development.stats.median;
  assert.ok(high > 0 && low < 0, `${high} ${low}`);
  assert.equal(horizon.development.ordering, 1);
  assert.match(result.read, /both extremes reverted, the lagging metal catching up/);
});

test('a ratio that trends in long legs reads as persisting', () => {
  // 300 sessions up, 300 down: a high reading usually sits mid-trend, with
  // more of the same to come.
  let day = 0;
  const result = calculateGoldSilverRecord(metals({ seed: 9, step: (value, random) => { day += 1; return value + (Math.floor(day / 300) % 2 ? -0.0015 : 0.0015) + 0.004 * random(); } }));
  assert.match(result.read, /both extremes persisted, the leading metal staying ahead/);
});

test('too short a shared history refuses with a reason', () => {
  const result = calculateGoldSilverRecord(metals({ sessions: 900, step: (value) => value }));
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /share 900 sessions; 1500 are needed/);
});
