import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTrackRecord, forwardObservations } from './trackRecord.js';

const ORDER = [{ key: 'cheap', label: 'Cheap' }, { key: 'mid', label: 'Mid' }, { key: 'dear', label: 'Dear' }];
const date = (index) => new Date(Date.UTC(2015, 0, 1) + (index * 7 * 86_400_000)).toISOString().slice(0, 10);

/** Weekly observations whose 30/90-day returns are chosen per state. */
function observations(count, returnFor) {
  return Array.from({ length: count }, (_, index) => {
    const label = ORDER[index % 3].key;
    return { date: date(index), label, returns: { 30: returnFor(label, index, 30), 90: returnFor(label, index, 90) } };
  });
}

const HORIZONS = [{ days: 30 }, { days: 90 }];

test('overlapping weekly windows are counted at their effective size', () => {
  // 52 weekly readings of a 90-day return overlap eleven weeks in twelve, so
  // they carry about four independent observations, not 52.
  const record = evaluateTrackRecord({ observations: observations(600, () => 1), order: ORDER, horizons: HORIZONS, stepDays: 7, holdoutFraction: 0.3 });
  const ninety = record.horizons.find((horizon) => horizon.days === 90);
  const cheap = ninety.states.find((state) => state.key === 'cheap').development.stats;
  assert.equal(cheap.effective, Math.round(cheap.n * (7 / 90) * 10) / 10);
  const thirty = record.horizons.find((horizon) => horizon.days === 30);
  assert.ok(thirty.states[0].development.stats.effective > cheap.effective * 2.9, 'a shorter horizon overlaps less');
});

test('a cell with fewer than four effective observations publishes no statistics', () => {
  const record = evaluateTrackRecord({ observations: observations(120, () => 2), order: ORDER, horizons: HORIZONS, stepDays: 7, holdoutFraction: 0.3 });
  const held = record.horizons.find((horizon) => horizon.days === 90).states[0].heldOut.stats;
  assert.equal(held.status, 'insufficient');
  assert.equal(held.median, undefined);
  assert.ok(held.effective < 4);
});

test('the edge is measured against what every week did, not against zero', () => {
  // Everything rose. "Cheap" rose less than the average week, so it carries a
  // negative edge despite a 100% hit rate - the base rate is the comparison.
  const record = evaluateTrackRecord({
    observations: observations(900, (label) => (label === 'cheap' ? 3 : label === 'mid' ? 6 : 9)),
    order: ORDER,
    horizons: HORIZONS,
  });
  const cheap = record.horizons.find((horizon) => horizon.days === 30).states.find((state) => state.key === 'cheap');
  assert.equal(cheap.development.stats.hitRate, 100);
  assert.ok(cheap.development.edge < 0, `edge ${cheap.development.edge}`);
});

test('the held-out block is the newest observations and shares none with development', () => {
  const list = observations(400, () => 1);
  const record = evaluateTrackRecord({ observations: list, order: ORDER, horizons: HORIZONS, holdoutFraction: 0.25 });
  assert.equal(record.holdoutFrom, date(300));
  const thirty = record.horizons.find((horizon) => horizon.days === 30);
  assert.equal(thirty.development.all.n + thirty.heldOut.all.n, 400);
  assert.equal(thirty.heldOut.all.n, 100);
});

test('ordering scores +1 when states line up as assumed and -1 when reversed', () => {
  const asAssumed = evaluateTrackRecord({ observations: observations(900, (label) => ({ cheap: 9, mid: 5, dear: 1 })[label]), order: ORDER, horizons: HORIZONS });
  const reversed = evaluateTrackRecord({ observations: observations(900, (label) => ({ cheap: 1, mid: 5, dear: 9 })[label]), order: ORDER, horizons: HORIZONS });
  assert.equal(asAssumed.horizons[0].development.ordering, 1);
  assert.equal(reversed.horizons[0].development.ordering, -1);
});

test('a state consistent in both blocks is flagged; one that flips is not', () => {
  // Unequal groups (a quarter, a half, a quarter) so the all-weeks median
  // falls inside the middle group rather than exactly on one group's value,
  // which would give that group an edge of zero by construction.
  const list = Array.from({ length: 900 }, (_, index) => {
    const label = ['cheap', 'mid', 'mid', 'dear'][index % 4];
    const value = label === 'mid' ? (index % 8 < 4 ? 3 : 5) : label === 'dear' ? -2 : (index < 630 ? 8 : -5);
    return { date: date(index), label, returns: { 30: value, 90: value } };
  });
  const record = evaluateTrackRecord({ observations: list, order: ORDER, horizons: HORIZONS });
  const thirty = record.horizons.find((horizon) => horizon.days === 30);
  assert.equal(thirty.states.find((state) => state.key === 'dear').consistent, true);
  assert.equal(thirty.states.find((state) => state.key === 'cheap').consistent, false, 'cheap led in development and lagged after');
});

test('a sample too close to the end has no forward return at that horizon, not a truncated one', () => {
  const values = Array.from({ length: 100 }, (_, index) => 100 + index);
  const dates = values.map((_, index) => date(index));
  const [early, late] = forwardObservations({ dates, values, samples: [{ index: 10, label: 'mid' }, { index: 95, label: 'mid' }], horizons: [{ days: 30, sessions: 3 }, { days: 90, sessions: 10 }] });
  assert.ok(Number.isFinite(early.returns[90]));
  assert.ok(Number.isFinite(late.returns[30]));
  assert.equal(late.returns[90], null);
});

test('too few observations refuses rather than describing noise', () => {
  const record = evaluateTrackRecord({ observations: observations(20, () => 1), order: ORDER, horizons: HORIZONS });
  assert.equal(record.status, 'unavailable');
  assert.match(record.reason, /40 dated observations/);
});

test('a three-state signal is ranked from its two extremes when the middle is thin', () => {
  // Without this a three-regime score whose middle state is rarely visited
  // could never report an ordering at all.
  const list = Array.from({ length: 900 }, (_, index) => {
    const label = index % 60 === 0 ? 'mid' : index % 2 ? 'cheap' : 'dear';
    return { date: date(index), label, returns: { 30: label === 'cheap' ? 6 : label === 'dear' ? -2 : 1, 90: 0 } };
  });
  const record = evaluateTrackRecord({ observations: list, order: ORDER, horizons: [{ days: 30 }], holdoutFraction: 0.3 });
  const thirty = record.horizons[0];
  assert.equal(thirty.states.find((state) => state.key === 'mid').development.stats.status, 'insufficient');
  assert.equal(thirty.development.ordering, 1);
});
