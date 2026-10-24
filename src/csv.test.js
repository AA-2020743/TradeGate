import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, csvFilename, toCsv } from './csv.js';

test('a value with a comma or quote stays in its own column', () => {
  assert.equal(csvCell('Health Care, Equipment'), '"Health Care, Equipment"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(toCsv(['a', 'b'], [['x,y', 2]]), 'a,b\r\n"x,y",2\r\n');
});

test('a cell that would run as a formula is neutralised, a negative number is not', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('+1+1'), "'+1+1");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('-cmd'), "'-cmd");
  assert.equal(csvCell(-12.5), '-12.5');
  assert.equal(csvCell('-0.25'), '-0.25');
});

test('missing values are empty cells, and file names carry the date', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(0), '0');
  assert.equal(csvFilename('Screener: Momentum leaders', new Date('2026-10-24T12:00:00Z')), 'screener-momentum-leaders-2026-10-24.csv');
});
