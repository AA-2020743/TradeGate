import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateFxMomentumRecord, outlookState } from './fxMomentumRecord.js';

function tradingDays(count) {
  const out = [];
  for (let time = Date.UTC(2016, 0, 4); out.length < count; time += 86_400_000) {
    const day = new Date(time).getUTCDay();
    if (day !== 0 && day !== 6) out.push(new Date(time).toISOString().slice(0, 10));
  }
  return out;
}

function noise(seed) {
  let state = seed;
  return () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648 - 0.5; };
}

// Five currencies; with `trending`, each drifts one way for 250 sessions and
// then the other, offset from one another.
function spots({ sessions = 2500, trending = true, seed = 3 } = {}) {
  const random = noise(seed);
  const axis = tradingDays(sessions);
  return new Map(['EUR', 'GBP', 'JPY', 'AUD', 'CAD'].map((code, offset) => {
    let level = 1;
    return [code, axis.map((date, index) => {
      const drift = trending ? (Math.floor((index + offset * 90) / 250) % 2 ? 0.0006 : -0.0006) : 0;
      level *= 1 + drift + 0.008 * random();
      return { date, value: level };
    })];
  }));
}

test('labels follow the outlook panel rule', () => {
  assert.equal(outlookState(0.8), 'usdWeak');
  assert.equal(outlookState(-0.8), 'usdStrong');
  assert.equal(outlookState(0.2), 'range');
  assert.equal(outlookState(undefined), null);
});

test('trending currencies read as carrying forward, in and out of sample', () => {
  const result = calculateFxMomentumRecord(spots({ trending: true }));
  assert.equal(result.status, 'calculated', result.reason);
  const horizon = result.record.horizons.find((entry) => entry.days === 30);
  assert.ok(horizon.development.ordering >= 0.6, `${horizon.development.ordering}`);
  assert.match(result.read, /tended to carry forward, as the outlook label implies/);
});

test('random-walk currencies read as carrying little information', () => {
  const result = calculateFxMomentumRecord(spots({ trending: false, seed: 13 }));
  const horizon = result.record.horizons.find((entry) => entry.days === 30);
  const weak = horizon.states.find((state) => state.key === 'usdWeak').development.stats.median;
  const strong = horizon.states.find((state) => state.key === 'usdStrong').development.stats.median;
  assert.ok(Math.abs(weak - strong) < 0.6, `${weak} vs ${strong}`);
  assert.match(result.read, /carried little consistent information about the next month/);
});

test('too few currencies or sessions refuse with a reason', () => {
  const two = new Map([...spots()].slice(0, 2));
  assert.match(calculateFxMomentumRecord(two).reason, /Needs three currencies/);
  assert.match(calculateFxMomentumRecord(spots({ sessions: 600 })).reason, /Needs three currencies with 750 sessions/);
});
