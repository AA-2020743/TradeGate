import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMissingTechnical } from './equities.js';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');

test('a stale stored history names its date, its age, and what the fallback did', () => {
  // This is the reported case: the panel said only "Unavailable", which reads
  // as a configuration problem when ingestion had simply stopped writing.
  const reason = describeMissingTechnical(
    { stored: true, configured: true, stale: true, asOf: '2026-08-21T00:00:00.000Z' },
    'Upstream request failed with 429',
    NOW,
  );
  assert.match(reason, /stored history ends 2026-08-21/);
  assert.match(reason, /7 days old/);
  assert.match(reason, /live fallback did not fill in: Upstream request failed with 429/);
});

test('a missing database is distinguished from an empty one', () => {
  assert.match(describeMissingTechnical({ configured: false, stored: false }, null, NOW), /no database is configured/);
  assert.match(describeMissingTechnical({ configured: true, stored: false }, null, NOW), /holds no history for this symbol/);
});

test('a live fallback that returned too little is not reported as a failure', () => {
  const reason = describeMissingTechnical({ stored: true, configured: true, asOf: '2026-08-27T00:00:00.000Z' }, null, NOW);
  assert.match(reason, /returned a history too short to score/);
  assert.doesNotMatch(reason, /did not fill in/);
});

test('a one-day-old history reads as a day, not as days', () => {
  const reason = describeMissingTechnical({ stored: true, configured: true, asOf: '2026-08-27T12:00:00.000Z' }, null, NOW);
  assert.match(reason, /1 day old/);
  assert.doesNotMatch(reason, /1 days old/);
});
