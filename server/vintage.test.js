import test from 'node:test';
import assert from 'node:assert/strict';
import { oldestAsOf, resolveVintage } from './vintage.js';

test('a composite reports the vintage of its stalest input, not its freshest', () => {
  // The dashboard used to publish the newest of its input dates, so a fresh
  // technical snapshot hid a liquidity model that had stopped updating a year
  // earlier - the same fault the macro regime carried.
  const vintage = resolveVintage([
    { name: 'technical snapshot', asOf: '2026-08-24T00:00:00.000Z' },
    { name: 'liquidity model', asOf: '2025-07-20' },
  ]);
  assert.equal(vintage.asOf, '2025-07-20');
  assert.equal(vintage.asOfSource, 'liquidity model');
  assert.equal(vintage.asOfSpreadDays, 400);
});

test('vintages are compared as instants, not as strings', () => {
  // An ISO timestamp and a plain date for the same day sort the wrong way
  // lexicographically, because the shorter string is a prefix of the longer.
  const sameDay = resolveVintage([
    { name: 'timestamp leg', asOf: '2026-08-20T15:30:00.000Z' },
    { name: 'date leg', asOf: '2026-08-20' },
  ]);
  assert.equal(sameDay.asOfSpreadDays, 1);

  const ordered = resolveVintage([
    { name: 'newer timestamp', asOf: '2026-08-21T00:00:00.000Z' },
    { name: 'older date', asOf: '2026-08-20' },
  ]);
  assert.equal(ordered.asOfSource, 'older date');
});

test('a vintage ignores inputs that carry no readable date', () => {
  const vintage = resolveVintage([
    { name: 'missing', asOf: null },
    { name: 'unreadable', asOf: 'not a date' },
    { name: 'present', asOf: '2026-08-20' },
  ]);
  assert.equal(vintage.asOf, '2026-08-20');
  assert.equal(vintage.asOfSource, 'present');
  // One usable input means there is no spread to report.
  assert.equal(vintage.asOfSpreadDays, null);
});

test('a composite with no dated inputs says so rather than inventing a vintage', () => {
  const vintage = resolveVintage([{ name: 'a', asOf: null }, { name: 'b', asOf: null }]);
  assert.deepEqual(vintage, { asOf: null, asOfSource: null, asOfSpreadDays: null });
  assert.deepEqual(resolveVintage([]), { asOf: null, asOfSource: null, asOfSpreadDays: null });
  assert.deepEqual(resolveVintage(), { asOf: null, asOfSource: null, asOfSpreadDays: null });
});

test('a stalled member sets the vintage instead of hiding behind current ones', () => {
  // The obvious thing to write is dates.sort().at(-1) - the newest - and four
  // models here did. It let one fresh leg hide another that had stopped: a
  // positioning model whose gold contract last printed in March still claimed
  // today's date because the FX contracts beside it were current.
  const vintage = resolveVintage([
    { name: 'Euro FX', asOf: '2026-08-18' },
    { name: 'Gold', asOf: '2026-03-11' },
    { name: 'Japanese Yen', asOf: '2026-08-18' },
  ]);
  assert.equal(vintage.asOf, '2026-03-11');
  assert.equal(vintage.asOfSource, 'Gold');
  assert.equal(vintage.asOfSpreadDays, 160);
});

test('oldestAsOf answers for callers that only need the date', () => {
  assert.equal(oldestAsOf(['2026-08-18', '2026-03-11', '2026-08-20']), '2026-03-11');
  assert.equal(oldestAsOf([]), null);
  assert.equal(oldestAsOf(), null);
  assert.equal(oldestAsOf([null, 'not a date']), null);
});
