import test from 'node:test';
import assert from 'node:assert/strict';
import { SCREENER_COLUMNS, ariaSortFor, nextSortState, sortRows } from './screenerSort.js';

const ROWS = [
  { symbol: 'CCC', mom20: 4, score: 60 },
  { symbol: 'AAA', mom20: -2, score: 20 },
  { symbol: 'BBB', mom20: null, score: 90 },
];
const byScoreDesc = (left, right) => right.score - left.score;

test('sorting a numeric column orders it and sinks rows without a reading', () => {
  assert.deepEqual(sortRows(ROWS, { key: 'mom20', direction: 'desc' }).map((row) => row.symbol), ['CCC', 'AAA', 'BBB']);
  assert.deepEqual(sortRows(ROWS, { key: 'mom20', direction: 'asc' }).map((row) => row.symbol), ['AAA', 'CCC', 'BBB']);
});

test('sorting the symbol column is alphabetical in both directions', () => {
  assert.deepEqual(sortRows(ROWS, { key: 'symbol', direction: 'asc' }).map((row) => row.symbol), ['AAA', 'BBB', 'CCC']);
  assert.deepEqual(sortRows(ROWS, { key: 'symbol', direction: 'desc' }).map((row) => row.symbol), ['CCC', 'BBB', 'AAA']);
});

test('no column and an unknown column both defer to the screen ordering', () => {
  assert.deepEqual(sortRows(ROWS, null, byScoreDesc).map((row) => row.symbol), ['BBB', 'CCC', 'AAA']);
  assert.deepEqual(sortRows(ROWS, { key: 'nonsense', direction: 'asc' }, byScoreDesc).map((row) => row.symbol), ['BBB', 'CCC', 'AAA']);
});

test('sorting never mutates the rows it was handed', () => {
  const original = [...ROWS];
  sortRows(ROWS, { key: 'mom20', direction: 'asc' });
  assert.deepEqual(ROWS, original);
});

test('sorting tolerates a missing or non-array input', () => {
  assert.deepEqual(sortRows(undefined, { key: 'mom20', direction: 'asc' }), []);
  assert.deepEqual(sortRows(null, null, byScoreDesc), []);
});

test('a header cycles natural direction, reverse, then back to the screen order', () => {
  const first = nextSortState(null, 'mom20');
  assert.deepEqual(first, { key: 'mom20', direction: 'desc' });
  const second = nextSortState(first, 'mom20');
  assert.deepEqual(second, { key: 'mom20', direction: 'asc' });
  assert.equal(nextSortState(second, 'mom20'), null);
});

test('symbol sorts ascending first and switching columns restarts the cycle', () => {
  assert.deepEqual(nextSortState(null, 'symbol'), { key: 'symbol', direction: 'asc' });
  assert.deepEqual(nextSortState({ key: 'mom20', direction: 'asc' }, 'score'), { key: 'score', direction: 'desc' });
});

test('an unknown header leaves the current sort untouched', () => {
  const current = { key: 'score', direction: 'desc' };
  assert.equal(nextSortState(current, 'nonsense'), current);
  assert.equal(nextSortState(null, 'nonsense'), null);
});

test('every column is announced to assistive technology', () => {
  assert.equal(ariaSortFor({ key: 'score', direction: 'desc' }, 'score'), 'descending');
  assert.equal(ariaSortFor({ key: 'score', direction: 'asc' }, 'score'), 'ascending');
  assert.equal(ariaSortFor({ key: 'score', direction: 'asc' }, 'mom20'), 'none');
  assert.equal(ariaSortFor(null, 'score'), 'none');
});

test('the column list matches the rendered table width', () => {
  assert.equal(SCREENER_COLUMNS.length, 9);
  assert.deepEqual(SCREENER_COLUMNS.filter((column) => column.type === 'text').map((column) => column.key), ['symbol']);
});
