import test from 'node:test';
import assert from 'node:assert/strict';
import { getDailyChanges, pickBaseline, snapshotDue } from './dailySnapshot.js';
import { SNAPSHOT_VERSION } from '../src/snapshotDiff.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const snapshot = (takenAt, score) => ({ snapshotVersion: SNAPSHOT_VERSION, takenAt, build: { commit: 'a' }, readings: [{ key: 'macro:liquidity', name: 'US liquidity', status: 'calculated', score, asOf: takenAt.slice(0, 10), version: 'v1' }], vintages: [] });
const stored = (takenAt, score) => ({ output: snapshot(takenAt, score) });

test('the baseline is the newest snapshot at least twenty hours old, and a new copy is due only after that', () => {
  const list = [stored('2026-10-06T09:00:00Z', 40), stored('2026-10-07T10:00:00Z', 45), stored('2026-10-08T02:00:00Z', 47)];
  assert.equal(pickBaseline(list, NOW).output.takenAt, '2026-10-07T10:00:00Z');
  assert.equal(snapshotDue(list, NOW), false, 'the newest is ten hours old');
  assert.equal(snapshotDue(list.slice(0, 2), NOW), true);
  assert.equal(snapshotDue([], NOW), true);
});

test('changes compare the live workspace with yesterday, and a due copy is stored once', async () => {
  const writes = [];
  const result = await getDailyChanges({
    databaseConfigured: true,
    now: NOW,
    take: async () => snapshot('2026-10-08T12:00:00Z', 52),
    load: async () => [stored('2026-10-07T09:00:00Z', 45)],
    store: async (value) => { writes.push(value.takenAt); },
  });
  assert.equal(result.status, 'calculated');
  assert.equal(result.changes[0].key, 'macro:liquidity');
  assert.equal(result.changes[0].delta, 7);
  assert.equal(result.changes[0].cause, 'data');
  assert.deepEqual(writes, ['2026-10-08T12:00:00Z']);
});

test('with nothing old enough yet it says when the comparison will appear, and without a database it says why not', async () => {
  const first = await getDailyChanges({ databaseConfigured: true, now: NOW, take: async () => snapshot('2026-10-08T12:00:00Z', 50), load: async () => [], store: async () => {} });
  assert.equal(first.status, 'provisional');
  assert.match(first.reason, /first daily snapshot was stored at 2026-10-08 12:00 UTC/);
  const none = await getDailyChanges({ databaseConfigured: false, take: async () => { throw new Error('not called'); }, load: async () => [], store: async () => {} });
  assert.equal(none.status, 'unavailable');
});
