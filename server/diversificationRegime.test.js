import test from 'node:test';
import assert from 'node:assert/strict';
import { DIVERSIFICATION_ASSETS, calculateDiversificationRegime, forwardDrawdown, stockBondState } from './diversificationRegime.js';

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

// Six assets; IEF's link to SPY is set per session by `bondLink(index)`.
function market(sessions, bondLink, seed = 2) {
  const random = noise(seed);
  const axis = tradingDays(sessions + 1);
  const returns = Object.fromEntries(DIVERSIFICATION_ASSETS.map((asset) => [asset.symbol, []]));
  for (let index = 0; index < sessions; index += 1) {
    const spy = 0.03 * random();
    returns.SPY.push(spy);
    returns.EFA.push(0.7 * spy + 0.01 * random());
    returns.EEM.push(0.6 * spy + 0.015 * random());
    returns.IEF.push(bondLink(index) * spy + 0.006 * random());
    returns.GLD.push(0.012 * random());
    returns.DBC.push(0.015 * random());
  }
  const histories = new Map(Object.entries(returns).map(([symbol, list]) => {
    let level = 100;
    return [symbol, axis.map((date, index) => { if (index) level *= 1 + list[index - 1]; return { date, value: level }; })];
  }));
  return { histories };
}

test('state thresholds and the forward drawdown read as documented', () => {
  assert.equal(stockBondState(-0.5), 'negative');
  assert.equal(stockBondState(0.1), 'neutral');
  assert.equal(stockBondState(0.4), 'positive');
  assert.ok(Math.abs(forwardDrawdown([100, 110, 99, 120], 0, 3) + 10) < 1e-9);
  assert.equal(forwardDrawdown([100, 101, 102], 0, 2), 0);
});

test('bonds that fall with stocks deepen the 60/40 drawdowns that follow, and the record says so', () => {
  // Hedging for the first half, falling together for the second.
  const result = calculateDiversificationRegime(market(1600, (index) => (index < 800 ? -0.3 : 0.3)));
  assert.equal(result.status, 'calculated', result.reason);
  assert.equal(result.stockBond.state, 'positive');
  assert.ok(result.stockBond.since > '2019-01-01');
  assert.ok(result.effectiveBets.now > 1 && result.effectiveBets.now < 6);
  const horizon = result.record.horizons.find((entry) => entry.days === 90);
  const negative = horizon.states.find((state) => state.key === 'negative').development.stats.median;
  const positive = horizon.states.find((state) => state.key === 'positive');
  const positiveMedian = positive.heldOut.stats.median ?? positive.development.stats.median;
  assert.ok(negative > positiveMedian, `${negative} vs ${positiveMedian}`);
  assert.match(result.read, /^Since \d{4}-\d{2}-\d{2}, stocks and bonds have been falling and rising together: the 63-session correlation is 0\.\d+/);
  assert.match(result.read, /the six asset classes behave like [\d.]+ independent bets/);
});

test('a missing asset or too short a history refuses with a reason', () => {
  const { histories } = market(1000, () => -0.3);
  histories.delete('DBC');
  assert.match(calculateDiversificationRegime({ histories }).reason, /No history for DBC/);
  assert.match(calculateDiversificationRegime(market(500, () => -0.3)).reason, /share 500 sessions; 756 are needed/);
});
