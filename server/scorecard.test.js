import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScorecard, scoreTrackRecord, verdictFor } from './scorecard.js';

const record = (orderings, extra = {}) => ({
  status: 'calculated',
  holdoutFrom: '2023-01-01',
  horizons: orderings.map(([days, development, heldOut]) => ({ days, development: { ordering: development, all: { effective: 40 } }, heldOut: { ordering: heldOut, all: { effective: 12 } }, states: [] })),
  ...extra,
});

test('verdicts follow the evaluator thresholds, and a thin held-out block is never a pass', () => {
  assert.equal(verdictFor(0.8, 0.7), 'held');
  assert.equal(verdictFor(0.2, 0.7), 'held-recent');
  assert.equal(verdictFor(0.9, 0.3), 'faded');
  assert.equal(verdictFor(0.9, -0.4), 'reversed');
  assert.equal(verdictFor(0.1, 0.1), 'no-order');
  assert.equal(verdictFor(1, null), 'untested');
  assert.equal(verdictFor(null, null), 'thin');
});

test('the score reads the horizon the panel reads, or the longest one with a held-out score', () => {
  const scored = scoreTrackRecord(record([[30, 1, 0.2], [90, 0.8, 0.7]], { readHorizonDays: 30 }));
  assert.equal(scored.horizonDays, 30);
  assert.equal(scored.verdict, 'faded');
  const fallback = scoreTrackRecord(record([[30, 1, 0.9], [90, 0.8, null]]));
  assert.equal(fallback.horizonDays, 30, 'the 90-day held-out block has no score');
  assert.equal(fallback.heldOutEffective, 12);
  assert.equal(scoreTrackRecord({ status: 'unavailable', reason: 'short' }).reason, 'short');
});

test('the scorecard counts verdicts and says how many held up', () => {
  const card = buildScorecard([
    { key: 'a', name: 'A', page: 'P', assumption: 'x', measure: 'return', result: { status: 'fulfilled', value: record([[90, 0.8, 0.8]]) }, pick: (payload) => payload },
    { key: 'b', name: 'B', page: 'P', assumption: 'x', measure: 'return', result: { status: 'fulfilled', value: { record: record([[90, 0.7, -0.5]]) } }, pick: (payload) => payload.record },
    { key: 'c', name: 'C', page: 'P', assumption: 'x', measure: 'return', result: { status: 'rejected', reason: new Error('timed out') }, pick: (payload) => payload },
  ]);
  assert.equal(card.counts.held, 1);
  assert.equal(card.counts.reversed, 1);
  assert.equal(card.rows[2].reason, 'timed out');
  assert.equal(card.rows[2].verdictLabel, 'Did not load');
  assert.equal(card.read, 'Of 3 track records, 2 have a held-out block large enough to judge; 1 ranked as assumed both before and after their cutoff; 1 ran against the order assumed.');
});

test('a record built from several inputs carries how each ranked on its own', () => {
  const card = buildScorecard([{
    key: 'a', name: 'A', page: 'P', assumption: 'x', measure: 'return',
    result: { status: 'fulfilled', value: { record: record([[90, -1, -0.33]]), parts: [
      { label: 'Trend', weight: 40, summary: { days: 90, developmentOrdering: -1, heldOutOrdering: -1, verdict: 'reversed' } },
      { label: 'Calm', weight: 5, summary: null },
    ] } },
    pick: (payload) => payload.record,
    components: (payload) => payload.parts,
  }]);
  // An input with no summary - one that could not be replayed - is left out.
  assert.deepEqual(card.rows[0].components, [{ label: 'Trend', weight: 40, days: 90, developmentOrdering: -1, heldOutOrdering: -1, verdict: 'reversed', verdictLabel: 'Ran against its assumed order since' }]);
  const plain = buildScorecard([{ key: 'b', name: 'B', page: 'P', assumption: 'x', measure: 'return', result: { status: 'fulfilled', value: record([[90, 1, 1]]) }, pick: (payload) => payload }]);
  assert.equal(plain.rows[0].components, undefined);
});

test('an input too thin to rank at the preferred horizon is judged at the longest one that can be', async () => {
  const { componentRecords } = await import('./scorecard.js');
  const order = [{ key: 'high', label: 'High' }, { key: 'low', label: 'Low' }];
  // Weekly readings, four years: enough independent 30-day windows per band
  // after the cutoff, too few 180-day ones.
  const observations = Array.from({ length: 208 }, (_, index) => {
    const label = Math.floor(index / 4) % 2 ? 'high' : 'low';
    return { date: new Date(Date.UTC(2020, 0, 1) + (index * 7 * 86_400_000)).toISOString().slice(0, 10), label, returns: { 30: label === 'high' ? 2 : -1, 180: label === 'high' ? 3 : -2 } };
  });
  const [component] = componentRecords({ components: [{ key: 'a', label: 'A' }], observationsByComponent: { a: observations }, order, horizonDays: [30, 180], days: 180 });
  assert.equal(component.summary.days, 30);
  assert.equal(component.summary.verdict, 'held');
});
