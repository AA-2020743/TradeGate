import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePortfolioRisk, yahooTickerFor } from './portfolioRisk.js';

function days(count) {
  const out = [];
  for (let time = Date.UTC(2025, 0, 6); out.length < count; time += 86_400_000) {
    const day = new Date(time).getUTCDay();
    if (day !== 0 && day !== 6) out.push(new Date(time).toISOString().slice(0, 10));
  }
  return out;
}

function noise(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648 - 0.5;
  };
}

// Builds a price path from a list of daily returns.
function path(axis, returns) {
  let level = 100;
  return axis.map((date, index) => {
    if (index) level *= 1 + returns[index - 1];
    return { date, value: level };
  });
}

const axis = days(260);
const draws = (seed, scale = 0.02) => { const random = noise(seed); return axis.slice(1).map(() => scale * random()); };
const benchmarkReturns = draws(1, 0.01);
const benchmark = path(axis, benchmarkReturns);

test('two names that move as one plus an unrelated third behave like 1.8 independent bets', () => {
  const shared = draws(2);
  const result = calculatePortfolioRisk({ histories: new Map([['AAA', path(axis, shared)], ['BBB', path(axis, shared)], ['CCC', path(axis, draws(3))]]), benchmark });
  assert.equal(result.status, 'calculated', result.reason);
  // Correlation matrix [[1,1,~0],[1,1,~0],[~0,~0,1]]: 9 / 5.
  assert.ok(Math.abs(result.summary.effectiveBets - 1.8) < 0.15, `${result.summary.effectiveBets}`);
  assert.deepEqual([result.mostAlike[0].left, result.mostAlike[0].right, result.mostAlike[0].correlation], ['AAA', 'BBB', 1]);
  assert.match(result.read, /These 3 symbols behave like 1\.8 independent bets; AAA and BBB move most alike \(correlation 1\)/);
});

test('identical names are one bet; unrelated names are about as many bets as names', () => {
  const same = draws(4);
  const identical = calculatePortfolioRisk({ histories: new Map([['A', path(axis, same)], ['B', path(axis, same)], ['C', path(axis, same)]]), benchmark });
  assert.equal(identical.summary.effectiveBets, 1);
  const unrelated = calculatePortfolioRisk({ histories: new Map([5, 6, 7, 8, 9].map((seed) => [`U${seed}`, path(axis, draws(seed))])), benchmark });
  assert.ok(unrelated.summary.effectiveBets > 4.5, `${unrelated.summary.effectiveBets}`);
});

test('a name moving twice the benchmark has beta 2 and correlation 1; risk shares sum to 100 and follow volatility', () => {
  const doubled = benchmarkReturns.map((value) => value * 2);
  const calm = draws(10, 0.004);
  const result = calculatePortfolioRisk({ histories: new Map([['LEV', path(axis, doubled)], ['CALM', path(axis, calm)]]), benchmark });
  const lev = result.positions.find((position) => position.symbol === 'LEV');
  assert.equal(lev.beta, 2);
  assert.equal(lev.correlationToBenchmark, 1);
  const total = result.positions.reduce((sum, position) => sum + position.riskSharePercent, 0);
  assert.ok(Math.abs(total - 100) < 0.2, `${total}`);
  assert.equal(result.positions[0].symbol, 'LEV', 'the volatile name carries most of the risk');
  assert.ok(lev.riskSharePercent > 75);
  assert.match(result.read, /LEV carries [\d.]+% of the risk at an equal weight of 50%/);
});

test('only dates every symbol shares are used, and too few of them refuse with a reason', () => {
  const late = path(axis, draws(11)).slice(150);
  const short = calculatePortfolioRisk({ histories: new Map([['OLD', path(axis, draws(12))], ['NEW', late]]), benchmark });
  assert.equal(short.status, 'unavailable');
  assert.match(short.reason, /share 109 sessions/);
  assert.equal(calculatePortfolioRisk({ histories: new Map([['ONE', benchmark]]), benchmark }).status, 'unavailable');
});

test('watchlist symbols map to the tickers Yahoo knows', () => {
  assert.equal(yahooTickerFor('BTC'), 'BTC-USD');
  assert.equal(yahooTickerFor('xau'), 'GC=F');
  assert.equal(yahooTickerFor('BRK.B'), 'BRK-B');
  assert.equal(yahooTickerFor('NVDA'), 'NVDA');
});
