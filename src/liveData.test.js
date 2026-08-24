import test from 'node:test';
import assert from 'node:assert/strict';
import { changeOverSpan, formatPercent, formatSpanLabel, formatTimestamp, formatUsd } from './liveData.js';

test('an unreadable provider timestamp is reported, not thrown', () => {
  // Intl.DateTimeFormat raises RangeError on an invalid date; one malformed
  // provider field must not be able to take a panel down.
  for (const bad of ['not a date', '2026-13-45', 'null', '  ']) {
    assert.doesNotThrow(() => formatTimestamp(bad));
    assert.equal(formatTimestamp(bad), 'Provider timestamp unreadable');
  }
});

test('an absent timestamp is distinguished from an unreadable one', () => {
  for (const empty of [null, undefined, '', 0, Number.NaN]) {
    assert.equal(formatTimestamp(empty), 'Awaiting provider timestamp');
  }
});

test('a valid timestamp still formats', () => {
  assert.match(formatTimestamp('2026-08-20T12:00:00Z'), /12:00\s?PM/);
  assert.match(formatTimestamp(new Date('2026-08-20T12:00:00Z')), /12:00\s?PM/);
});

test('currency decimals follow magnitude rather than sign', () => {
  // The old check compared the raw value, so every negative took the
  // small-number branch no matter how large it was.
  assert.equal(formatUsd(1234.5), formatUsd(-1234.5).replace('-', ''));
  assert.equal(formatUsd(99.5), '$99.50');
  assert.equal(formatUsd(-99.5), '-$99.50');
  assert.equal(formatUsd(0), '$0.00');
});

test('sub-hundred values always carry cents', () => {
  assert.equal(formatUsd(5), '$5.00');
  assert.equal(formatUsd(0.5), '$0.50');
  assert.equal(formatUsd(-0.25), '-$0.25');
});

test('non-numeric prices are explicitly unavailable', () => {
  for (const value of [null, undefined, Number.NaN, Infinity, -Infinity, '64000']) {
    assert.equal(formatUsd(value), 'Unavailable');
  }
});

test('percent changes carry an explicit sign and two decimals', () => {
  assert.equal(formatPercent(1.234), '+1.23%');
  assert.equal(formatPercent(-1.235), '-1.24%');
  assert.equal(formatPercent(0), '+0.00%');
});

test('a missing percent change says so rather than reading as flat', () => {
  for (const value of [null, undefined, Number.NaN, '1.2']) {
    assert.equal(formatPercent(value), 'No change data');
  }
});

test('a trailing change is measured in days, not in observations', () => {
  const day = 86_400_000;
  // The global liquidity history unions two weekly feeds, so it lands about
  // twice a week. Counting thirteen points back covers about six weeks.
  const points = [];
  for (let index = 0; index < 60; index += 1) {
    points.push({ date: new Date(Date.UTC(2024, 0, 3) + (index * 7 * day)).toISOString().slice(0, 10), value: 24_000_000 + (index * 20_000) });
    points.push({ date: new Date(Date.UTC(2024, 0, 5) + (index * 7 * day)).toISOString().slice(0, 10), value: 24_000_000 + (index * 20_000) + 9_000 });
  }
  points.sort((left, right) => (left.date < right.date ? -1 : 1));

  const measured = changeOverSpan(points, points.length - 1, 91);
  assert.equal(measured.spanDays, 91);
  assert.equal(formatSpanLabel(measured.spanDays), '13W');
});

test('a history too short to reach back declines rather than shrinking the window', () => {
  const day = 86_400_000;
  const points = [];
  for (let index = 0; index < 6; index += 1) {
    points.push({ date: new Date(Date.UTC(2024, 0, 3) + (index * 7 * day)).toISOString().slice(0, 10), value: 100 + index });
  }
  // Five weeks of history cannot answer a thirteen-week question.
  assert.equal(changeOverSpan(points, points.length - 1, 91), null);
});

test('a span reports in the unit that describes it', () => {
  assert.equal(formatSpanLabel(91), '13W');
  assert.equal(formatSpanLabel(88), '13W');
  assert.equal(formatSpanLabel(10), '10D');
  assert.equal(formatSpanLabel(0), '');
});
