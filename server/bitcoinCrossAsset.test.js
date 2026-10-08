import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBitcoinCrossAsset, classifyRegime, correlation, correlationRange } from './bitcoinCrossAsset.js';

function tradingDays(count) {
  const out = [];
  for (let time = Date.UTC(2017, 0, 2); out.length < count; time += 86_400_000) {
    const day = new Date(time).getUTCDay();
    if (day !== 0 && day !== 6) out.push(new Date(time).toISOString().slice(0, 10));
  }
  return out;
}

function noise(seed) {
  let state = seed;
  return () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648 - 0.5; };
}

function levels(axis, returns) {
  let level = 100;
  return axis.map((date, index) => { if (index) level *= 1 + returns[index - 1] / 100; return { date, value: level }; });
}

// QQQ and GLD are independent noise; bitcoin follows `mix(index, qqq, gld, own)`.
function market(sessions, mix, seed = 1) {
  const random = noise(seed);
  const axis = tradingDays(sessions + 1);
  const qqq = axis.slice(1).map(() => 6 * random());
  const gld = axis.slice(1).map(() => 2 * random());
  const btc = qqq.map((value, index) => mix(index, value, gld[index], 8 * random()));
  return { nasdaq: levels(axis, qqq), gold: levels(axis, gld), bitcoin: levels(axis, btc) };
}

test('correlation, its Fisher range and the regime labels behave as documented', () => {
  assert.equal(correlation([1, 2, 3], [2, 4, 6]), 1);
  const [low, high] = correlationRange(0.5, 90);
  assert.ok(low > 0.32 && low < 0.34 && high > 0.63 && high < 0.65, `${low} ${high}`);
  assert.equal(classifyRegime(0.55, 0.1), 'risk');
  assert.equal(classifyRegime(0.1, 0.45), 'gold');
  assert.equal(classifyRegime(0.05, 0.1), 'own');
  assert.equal(classifyRegime(0.3, 0.1), 'mixed');
});

test('bitcoin moving as twice the Nasdaq reads as a risk asset with a beta near two', () => {
  const result = calculateBitcoinCrossAsset(market(800, (_index, qqq, _gld, own) => 2 * qqq + 0.4 * own));
  assert.equal(result.status, 'calculated', result.reason);
  assert.equal(result.regime, 'risk');
  assert.ok(result.correlations.nasdaq.short > 0.8);
  assert.ok(Math.abs(result.betaToNasdaq.year - 2) < 0.25, `${result.betaToNasdaq.year}`);
  assert.ok(result.stress.byRegime.find((entry) => entry.key === 'risk').medianBitcoin < -2);
  assert.match(result.read, /^Over the last 90 sessions bitcoin traded as a risk asset: correlation 0\.\d+ with the Nasdaq-100/);
  assert.match(result.read, /its beta to QQQ over the year is [\d.]+ \([\d.]+ on the Nasdaq’s down days, [\d.]+ on its up days\)/);
});

test('a switch from the Nasdaq to gold is dated, and stress days are judged by the regime before them', () => {
  const result = calculateBitcoinCrossAsset(market(900, (index, qqq, gld, own) => (index < 600 ? 2 * qqq + 0.3 * own : 3 * gld + 0.3 * own), 4));
  assert.equal(result.regime, 'gold');
  assert.ok(result.regimeSince > result.history[0].date);
  const risk = result.stress.byRegime.find((entry) => entry.key === 'risk');
  assert.ok(risk.days > 0 && risk.fellShare > 80, JSON.stringify(risk));
  assert.equal(result.stress.otherRegimes.days, result.stress.all.days - result.stress.byRegime.find((entry) => entry.key === 'gold').days);
  const shares = result.timeInRegime.reduce((total, entry) => total + entry.sharePercent, 0);
  assert.ok(Math.abs(shares - 100) <= 2, `${shares}`);
});

test('a stress day is judged by the regime of the session before it, not one its own move created', () => {
  // Independent all along, then one final session where both crash together:
  // the 90-session correlation including that day reads as a risk asset, but
  // the stress day itself must carry the label from the session before.
  const input = market(800, (index, qqq, _gld, own) => (index === 799 ? -80 : qqq <= -2 ? own * 0.1 : own), 9);
  const lastDate = input.nasdaq.at(-1).date;
  input.nasdaq.at(-1).value = input.nasdaq.at(-2).value * 0.9;
  const result = calculateBitcoinCrossAsset(input);
  assert.notEqual(result.regime, 'own', 'the final crash moves the current label');
  const last = result.stress.latest[0];
  assert.equal(last.date, lastDate);
  assert.equal(last.regime, 'own');
});

test('too short a shared history refuses with a reason', () => {
  const result = calculateBitcoinCrossAsset(market(300, (_index, qqq) => qqq));
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /share 300 sessions; 504 are needed/);
});
