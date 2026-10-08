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
