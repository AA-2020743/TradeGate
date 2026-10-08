import test from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, bondEquivalentYield, calculateRecessionProbability, fitProbit, normalCdf, probabilityFromSpread } from './recessionProbability.js';

test('the normal CDF, the bond-equivalent bill and the published curve read as documented', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-4);
  // 365 x 0.05 / (360 - 91 x 0.05)
  assert.ok(Math.abs(bondEquivalentYield(5) - 5.1343) < 1e-3);
  // A flat curve is the familiar ~30%; a point of inversion is just over half.
  assert.ok(Math.abs(probabilityFromSpread(0) - 29.7) < 0.1);
  assert.ok(Math.abs(probabilityFromSpread(-1) - 54.0) < 0.1);
  assert.equal(addMonths('2025-11', 3), '2026-02');
  assert.equal(addMonths('2026-01', -1), '2025-12');
});

test('the probit fit recovers the coefficients that generated the outcomes', () => {
  let state = 17;
  const random = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
  const xs = [];
  const ys = [];
  for (let index = 0; index < 20000; index += 1) {
    const x = -2 + 6 * random();
    xs.push(x);
    ys.push(random() < normalCdf(-0.5 - 0.6 * x) ? 1 : 0);
  }
  const fit = fitProbit(xs, ys);
  assert.ok(fit.converged);
  assert.ok(Math.abs(fit.alpha + 0.5) < 0.05, `${fit.alpha}`);
  assert.ok(Math.abs(fit.beta + 0.6) < 0.05, `${fit.beta}`);
});

// Monthly GS10, TB3MS (discount basis) and USREC from 1959 to September 2026,
// with the spread set month by month.
function history({ spreadFor, recessionFor, last = '2026-09' }) {
  const tenYear = [];
  const billDiscount = [];
  const recessions = [];
  for (let month = '1959-01'; month <= last; month = addMonths(month, 1)) {
    const bey = (5 - spreadFor(month)) / 100;
    tenYear.push({ date: `${month}-01`, value: 5 });
    billDiscount.push({ date: `${month}-01`, value: (360 * bey) / (365 + 91 * bey) * 100 });
    recessions.push({ date: `${month}-01`, value: recessionFor(month) ? 1 : 0 });
  }
  return { tenYear, billDiscount, recessions };
}

const between = (month, from, to) => month >= from && month <= to;

test('each signal is judged by whether a recession began within two years, and unsignalled recessions are named', () => {
  const input = history({
    spreadFor: (month) => (between(month, '1966-06', '1966-12') ? -0.5 : between(month, '1968-12', '1969-10') ? -0.5 : between(month, '2026-01', '2026-09') ? -1 : 1.5),
    recessionFor: (month) => between(month, '1969-12', '1970-11') || between(month, '1990-08', '1991-03'),
  });
  const result = calculateRecessionProbability(input);
  assert.equal(result.status, 'calculated', result.reason);
  assert.equal(result.month, '2026-09');
  assert.equal(result.targetMonth, '2027-09');
  assert.equal(result.spread, -1);
  assert.equal(result.probability, 54);
  assert.equal(result.invertedMonths, 9);
  assert.equal(result.outcomesConfirmedThrough, '2025-09');

  const byStart = Object.fromEntries(result.episodes.map((episode) => [episode.start, episode]));
  assert.deepEqual(Object.keys(byStart), ['1966-06', '1968-12', '2026-01']);
  assert.equal(byStart['1966-06'].outcome, 'not followed');
  assert.equal(byStart['1968-12'].outcome, 'followed');
  assert.equal(byStart['1968-12'].leadMonths, 12);
  assert.equal(byStart['2026-01'].outcome, 'pending');
  assert.equal(byStart['2026-01'].ongoing, true);
  assert.deepEqual(result.missedRecessions, ['1990-08']);
  assert.equal(result.recessionsInSample, 2);

  assert.match(result.read, /puts the chance of a U\.S\. recession in September 2027 at 54%/);
  assert.match(result.read, /inverted 9 months running/);
  assert.match(result.read, /risen above 30% 2 times with the outcome known, and a recession began within two years of 1; the latest exception began in June 1966/);
  assert.match(result.read, /1 recession arrived without the signal \(1990\)/);

  const scoredMonths = result.bands.reduce((total, band) => total + band.months, 0);
  assert.equal(scoredMonths, result.history.filter((row) => row.target <= '2025-09').length);
});

test('a recession inside a long episode that already produced one is signalled, not missed', () => {
  const input = history({
    spreadFor: (month) => (between(month, '1978-11', '1981-09') ? -1 : 1.5),
    recessionFor: (month) => between(month, '1980-02', '1980-07') || between(month, '1981-08', '1982-11'),
  });
  const result = calculateRecessionProbability(input);
  assert.equal(result.episodes.length, 1);
  assert.equal(result.episodes[0].recessionStart, '1980-02');
  assert.deepEqual(result.missedRecessions, []);
});

test('outcomes NBER has not had time to date are not scored', () => {
  // A recession that starts in the final months reads as one, but its months
  // fall after the confirmation horizon and must not count as hits or misses.
  const input = history({ spreadFor: () => 1.5, recessionFor: (month) => month >= '2026-06' });
  const result = calculateRecessionProbability(input);
  assert.ok(result.bands.every((band) => band.distinctRecessions === 0));
  assert.deepEqual(result.missedRecessions, ['2026-06'], 'the recession start is still listed');
});

test('too short a history refuses with a reason', () => {
  const input = history({ spreadFor: () => 1, recessionFor: () => false, last: '1970-12' });
  const result = calculateRecessionProbability(input);
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /share 144 months/);
});
