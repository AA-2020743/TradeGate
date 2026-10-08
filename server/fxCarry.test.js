import test from 'node:test';
import assert from 'node:assert/strict';
import { CARRY_CURRENCIES, calculateFxCarry, dollarsPerUnit, spliceRateSeries, spliceUsRate } from './fxCarry.js';

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

// Fixed rate gaps per currency. With `paid`, spot drifts by less than the
// carry (high-yielders earn); without it, spot falls by exactly the carry
// (uncovered interest parity holds and carry earns nothing).
function market({ sessions = 2500, paid = true, seed = 5, stale = null } = {}) {
  const random = noise(seed);
  const axis = tradingDays(sessions);
  const gaps = { EUR: -1, GBP: 0.5, JPY: -3, CHF: -2.5, AUD: 2, NZD: 2.5, CAD: 0 };
  const spots = new Map();
  const rates = new Map();
  for (const currency of CARRY_CURRENCIES) {
    let level = 1;
    const drift = paid ? 0 : -gaps[currency.code] / 100 / 252;
    spots.set(currency.code, axis.map((date) => { level *= 1 + drift + 0.006 * random(); return { date, value: level }; }));
    const months = [...new Set(axis.map((date) => date.slice(0, 7)))].filter((month) => currency.code !== stale || month < '2020-01');
    rates.set(currency.code, months.map((month) => ({ date: `${month}-01`, value: 2 + gaps[currency.code] })));
  }
  const usRate = [...new Set(axis.map((date) => date.slice(0, 7)))].map((month) => ({ date: `${month}-01`, value: 2 }));
  return { spots, rates, usRate };
}

test('a quote per dollar is inverted to dollars per unit', () => {
  assert.deepEqual(dollarsPerUnit([{ date: '2026-01-02', value: 4 }], false), [{ date: '2026-01-02', value: 0.25 }]);
  assert.deepEqual(dollarsPerUnit([{ date: '2026-01-02', value: 1.1 }], true), [{ date: '2026-01-02', value: 1.1 }]);
});

test('when spot does not offset it, high carry is followed by higher returns and the trade earns its carry', () => {
  const result = calculateFxCarry(market({ paid: true }));
  assert.equal(result.status, 'calculated', result.reason);
  assert.deepEqual(result.trade.long, ['NZD', 'AUD']);
  assert.deepEqual(result.trade.short, ['CHF', 'JPY']);
  assert.equal(result.trade.carry, 5.0);
  assert.equal(result.currencies[0].carry, 2.5);
  assert.ok(result.currencies[0].volatility > 1.5 && result.currencies[0].volatility < 5, `${result.currencies[0].volatility}`);
  assert.ok(Math.abs(result.spreadHistory.annualReturn - 5) < 3, `${result.spreadHistory.annualReturn}`);
  const horizon = result.record.horizons.find((entry) => entry.days === 90);
  assert.ok(horizon.development.ordering >= 0.6, `${horizon.development.ordering}`);
  assert.match(result.read, /^Against a U\.S\. 3-month rate of 2%, the NZD pays the most carry \(\+2\.5 pts, [\d.]+ per unit of volatility\) and the JPY the least \(-3 pts\)/);
  assert.match(result.read, /long NZD and AUD against CHF and JPY earns 5 points a year of carry/);
});

test('when spot falls by exactly the carry, the trade earns about nothing', () => {
  const result = calculateFxCarry(market({ paid: false }));
  assert.ok(Math.abs(result.spreadHistory.annualReturn) < 3, `${result.spreadHistory.annualReturn}`);
});

test('a currency whose rate stopped publishing is left out and named', () => {
  const result = calculateFxCarry(market({ stale: 'JPY' }));
  assert.equal(result.status, 'calculated');
  assert.ok(result.excluded.some((entry) => entry.startsWith('JPY: rate last published 2019-12')));
  assert.ok(!result.currencies.some((row) => row.code === 'JPY'));
});

test('too few currencies or too short a history refuses with a reason', () => {
  const input = market({ sessions: 2500 });
  for (const code of ['EUR', 'GBP', 'JPY']) input.spots.delete(code);
  assert.match(calculateFxCarry(input).reason, /at least 5 currencies/);
  assert.match(calculateFxCarry(market({ sessions: 900 })).reason, /months of spot and rates; 60 are needed/);
});

test('the U.S. leg switches to the bond-equivalent T-bill after the interbank series stops, and only then', () => {
  const interbank = [{ date: '2023-05-01', value: 5.4 }, { date: '2023-06-01', value: 5.5 }];
  const bills = [{ date: '2023-06-01', value: 5.2 }, { date: '2023-07-01', value: 5.3 }, { date: '2023-08-01', value: 5.3 }, { date: '2023-09-01', value: 5.3 }];
  const spliced = spliceUsRate(interbank, bills);
  assert.deepEqual(spliced.points.map((point) => point.date), ['2023-05-01', '2023-06-01', '2023-07-01', '2023-08-01', '2023-09-01']);
  // Two months behind is late, not stopped.
  assert.equal(spliceUsRate(interbank, bills.slice(0, 3)).points.length, 2);
  assert.equal(spliced.points[1].value, 5.5, 'the interbank month is kept where it exists');
  assert.ok(spliced.points[2].value > 5.3, 'the bill is converted from its discount quote');
  assert.match(spliced.source, /interbank rate through 2023-06, then the 3-month Treasury bill/);
  assert.equal(spliceUsRate(bills.map((point) => ({ ...point })), []).source, 'OECD U.S. 3-month interbank rate');
  assert.equal(spliceUsRate([], bills).points.length, 4);
});

test('a foreign leg whose 3-month series stopped continues on its overnight rate', () => {
  const overnight = ['2021-11', '2021-12', '2022-01', '2022-02'].map((month, index) => ({ date: `${month}-01`, value: 0.05 + index * 0.05 }));
  const spliced = spliceRateSeries([{ date: '2021-11-01', value: 0.1 }], overnight, { primaryLabel: '3-month interbank', fallbackLabel: 'the overnight rate' });
  assert.deepEqual(spliced.points.map((point) => Math.round(point.value * 100) / 100), [0.1, 0.1, 0.15, 0.2]);
  assert.equal(spliced.splicedFrom, '2021-12');
  assert.equal(spliced.source, '3-month interbank through 2021-11, then the overnight rate');
});
