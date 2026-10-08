import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateVixTermRecord, vixTermState } from './vixTermRecord.js';

function tradingDays(count) {
  const out = [];
  for (let time = Date.UTC(2010, 0, 4); out.length < count; time += 86_400_000) {
    const day = new Date(time).getUTCDay();
    if (day !== 0 && day !== 6) out.push(new Date(time).toISOString().slice(0, 10));
  }
  return out;
}

function noise(seed) {
  let state = seed;
  return () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648 - 0.5; };
}

// Calm stretches with a sell-off every 200 sessions. VIX inverts late in the
// sell-off and stays inverted into the start of what follows it, as it tends
// to; `rebound` sets what follows.
function market({ sessions = 3200, rebound = 0.005, seed = 3 } = {}) {
  const random = noise(seed);
  const axis = tradingDays(sessions);
  let level = 100;
  const vix = []; const vix3m = []; const spy = [];
  axis.forEach((date, index) => {
    const phase = index % 200;
    const selling = phase >= 100 && phase < 110;
    const after = phase >= 110 && phase < 170;
    const inverted = phase >= 106 && phase < 120;
    level *= 1 + (selling ? -0.02 : after ? rebound : 0.0004) + 0.006 * random();
    const far = 20 + 2 * random();
    vix3m.push({ date, value: far });
    vix.push({ date, value: inverted ? far * 1.12 : far * (0.8 + 0.04 * random()) });
    spy.push({ date, value: level });
  });
  return { vix, vix3m, spy };
}

test('states use the dashboard thresholds', () => {
  assert.equal(vixTermState(0.85), 'contango');
  assert.equal(vixTermState(0.95), 'flat');
  assert.equal(vixTermState(1), 'backwardation');
  assert.equal(vixTermState(NaN), null);
});

test('when sell-offs are followed by rebounds, backwardation is followed by better returns, and the worst falls are measured beside them', () => {
  const result = calculateVixTermRecord(market({ rebound: 0.005 }));
  assert.equal(result.status, 'calculated', result.reason);
  assert.equal(result.state, 'contango');
  const back = result.returns.horizons.find((entry) => entry.days === 30).states.find((state) => state.key === 'backwardation');
  const all = result.returns.horizons.find((entry) => entry.days === 30).development.all.median;
  // At 90 days the overlapping windows leave fewer than four independent readings.
  assert.equal(result.returns.horizons.find((entry) => entry.days === 90).states.find((state) => state.key === 'backwardation').development.stats.status, 'insufficient');
  assert.ok(back.development.stats.median > all, `${back.development.stats.median} vs ${all}`);
  const fall = result.drawdowns.horizons.find((entry) => entry.days === 30).states.find((state) => state.key === 'backwardation');
  assert.ok(fall.development.stats.median <= 0, 'a worst fall is never a gain');
  assert.match(result.read, /with a median worst fall of -?[\d.]+% against -?[\d.]+%/);
  assert.match(result.read, /^VIX at [\d.]+ against [\d.]+ for VIX3M puts the ratio at 0\.\d+/);
  assert.match(result.read, /sessions in backwardation were followed over 30 days by a median \+[\d.]+% for SPY/);
  assert.match(result.read, /stress pricing was followed by recovery more often than by further losses/);
  assert.ok(result.timeInState.backwardation > 5 && result.timeInState.backwardation < 10, `${result.timeInState.backwardation}`);
});

test('when sell-offs keep going, the read says stress was followed by weaker returns', () => {
  const result = calculateVixTermRecord(market({ rebound: -0.005 }));
  assert.match(result.read, /stress pricing was followed by weaker returns than an ordinary session/);
});

test('too short a shared history refuses with a reason', () => {
  const result = calculateVixTermRecord(market({ sessions: 500 }));
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /share 500 sessions; 750 are needed/);
});
