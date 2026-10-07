import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkspaceSnapshot, collectReadings, collectVintages, snapshotToCsv, SNAPSHOT_VERSION } from './workspaceSnapshot.js';
import { compareSnapshots, SNAPSHOT_VERSION as CLIENT_SNAPSHOT_VERSION } from '../src/snapshotDiff.js';
import { calculateAccumulationSchedule } from './accumulation.js';

function syntheticPoints(days, { start = '2016-01-04', drift = 0.0004, wave = 0.25 } = {}) {
  const points = [];
  const origin = Date.parse(`${start}T00:00:00Z`);
  for (let index = 0; index < days; index += 1) {
    const date = new Date(origin + index * 86_400_000).toISOString().slice(0, 10);
    points.push({ date, value: 100 * Math.exp(drift * index + wave * Math.sin(index / 180)) });
  }
  return points;
}

function fulfilled(value) {
  return { status: 'fulfilled', value };
}

test('the server and client agree on the snapshot format version', () => {
  assert.equal(SNAPSHOT_VERSION, CLIENT_SNAPSHOT_VERSION);
});

test('readings are collected from a real model output with its tier, risk, date and version', () => {
  const schedule = calculateAccumulationSchedule({ key: 'gold', name: 'Gold', points: syntheticPoints(3000) });
  assert.equal(schedule.status, 'calculated');
  const payload = { asOf: new Date().toISOString(), version: 'accumulation-v1', status: 'calculated', schedules: [schedule] };
  const readings = collectReadings('accumulation', payload);
  const gold = readings.find((reading) => reading.key === 'accumulation.schedules.gold');
  assert.ok(gold, readings.map((reading) => reading.key).join(', '));
  assert.equal(gold.name, 'Gold');
  assert.equal(gold.version, 'accumulation-v1');
  assert.equal(gold.state, schedule.tier.label);
  assert.equal(gold.score, schedule.risk);
  assert.equal(gold.asOf, schedule.asOf);
  assert.match(gold.read, /percentile/);
  // The track record nested inside the schedule is history, not a current
  // reading, and its own status must not be confused with the schedule's.
  assert.ok(!readings.some((reading) => reading.key.startsWith('accumulation.schedules.gold.backtest')));
});

test('a payload computed now does not date its readings to now', () => {
  const now = new Date().toISOString();
  const readings = collectReadings('macro', {
    asOf: now,
    model: { version: 'us-liquidity-v1', status: 'calculated', regime: 'Expanding', score: 61, asOf: now },
    yieldCurve: { version: 'yield-curve-v1', status: 'calculated', state: 'Steepening', asOf: '2026-10-02' },
  });
  assert.equal(readings.find((reading) => reading.key === 'macro.model').asOf, null, 'a sub-model stamped with the compute time is undated');
  assert.equal(readings.find((reading) => reading.key === 'macro.yieldCurve').asOf, '2026-10-02');
  // A payload date that names its stalest input is a data vintage and is kept.
  const vintage = collectReadings('accumulation', { asOf: '2026-10-06', asOfSource: 'Gold', version: 'accumulation-v1', status: 'calculated' });
  assert.equal(vintage[0].asOf, '2026-10-06');
});

test('array elements are keyed by identity, not position, so reordering keeps keys', () => {
  const tenors = [{ tenor: '2-Year', status: 'unavailable', reason: 'none' }, { tenor: '10-Year', status: 'unavailable', reason: 'none' }];
  const keys = collectReadings('treasury', { auctions: { version: 'treasury-funding-v1', status: 'unavailable', reason: 'x', tenors } }).map((reading) => reading.key);
  const reordered = collectReadings('treasury', { auctions: { version: 'treasury-funding-v1', status: 'unavailable', reason: 'x', tenors: [...tenors].reverse() } }).map((reading) => reading.key);
  assert.ok(keys.includes('treasury.auctions.tenors.10-Year'));
  assert.deepEqual([...keys].sort(), [...reordered].sort());
});

test('a failed loader is listed as a failure and the rest still snapshot', () => {
  const snapshot = buildWorkspaceSnapshot({
    build: { commit: 'a'.repeat(40), shortCommit: 'aaaaaaa' },
    registry: [{ id: 'technical-v1' }],
    takenAt: '2026-10-07T12:00:00.000Z',
    sources: {
      sentiment: { status: 'rejected', reason: new Error('Upstream request failed with 403') },
      macro: fulfilled({ asOf: '2026-10-07T12:00:00.000Z', seriesHealth: [{ id: 'WALCL', name: 'Fed balance sheet', asOf: '2026-10-01', state: 'current' }], model: { version: 'us-liquidity-v1', status: 'calculated', regime: 'Expanding', score: 61 } }),
    },
  });
  assert.equal(snapshot.snapshotVersion, SNAPSHOT_VERSION);
  assert.deepEqual(snapshot.failures, [{ source: 'sentiment', reason: 'Upstream request failed with 403' }]);
  assert.equal(snapshot.counts.readings, 1);
  assert.equal(snapshot.counts.calculated, 1);
  assert.deepEqual(snapshot.vintages, [{ id: 'WALCL', name: 'Fed balance sheet', observationDate: '2026-10-01', state: 'current', stored: false }]);
  assert.deepEqual(snapshot.models, ['technical-v1']);
  assert.deepEqual(collectVintages(null), []);
});

test('CSV quotes commas and quotes, keeps negative numbers, and defuses formula openings', () => {
  const csv = snapshotToCsv({
    takenAt: '2026-10-07T12:00:00.000Z',
    build: { shortCommit: 'abc1234' },
    readings: [
      { key: 'a', name: 'Say "hi", then', version: 'v1', status: 'calculated', state: '=HYPERLINK("x")', score: -3.5, asOf: '2026-10-01', read: 'line one\nline two', reason: null },
      { key: 'b', name: '-flat', version: 'v1', status: 'unavailable', state: null, score: null, asOf: null, read: null, reason: '+cmd' },
    ],
  });
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'takenAt,commit,key,name,version,status,state,score,asOf,read,reason');
  assert.match(csv, /"Say ""hi"", then"/);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /,-3\.5,/);
  assert.match(csv, /,'-flat,/);
  assert.match(csv, /,'\+cmd\r\n$/);
  assert.match(csv, /"line one\nline two"/);
});

function snapshotWith(takenAt, readings, { commit = 'c1', vintages = [] } = {}) {
  return { snapshotVersion: SNAPSHOT_VERSION, takenAt, build: { commit, shortCommit: commit }, readings, vintages };
}

test('changes are attributed to the model, the data, or neither', () => {
  const earlier = snapshotWith('2026-10-01T00:00:00Z', [
    { key: 'a', name: 'Gold', source: 'accumulation', version: 'accumulation-v1', status: 'calculated', state: 'Neutral', score: 50, asOf: '2026-09-30' },
    { key: 'b', name: 'Silver', source: 'accumulation', version: 'accumulation-v1', status: 'calculated', state: 'Neutral', score: 50, asOf: '2026-09-30' },
    { key: 'c', name: 'Curve', source: 'macro', version: 'yield-curve-v1', status: 'calculated', state: 'Flat', score: null, asOf: '2026-09-30' },
    { key: 'd', name: 'Steady', source: 'accumulation', version: 'accumulation-v1', status: 'calculated', state: 'Neutral', score: 40, asOf: '2026-09-30' },
    { key: 'gone', name: 'Old', source: 'fx', version: 'fx-v1', status: 'calculated', state: 'x', score: null, asOf: null },
  ]);
  const later = snapshotWith('2026-10-08T00:00:00Z', [
    { key: 'a', name: 'Gold', source: 'accumulation', version: 'accumulation-v1', status: 'calculated', state: 'Accumulate', score: 30, asOf: '2026-10-07' },
    { key: 'b', name: 'Silver', source: 'accumulation', version: 'accumulation-v1', status: 'calculated', state: 'Neutral', score: 55, asOf: '2026-09-30' },
    { key: 'c', name: 'Curve', source: 'macro', version: 'yield-curve-v2', status: 'unavailable', state: null, score: null, asOf: null },
    { key: 'd', name: 'Steady', source: 'accumulation', version: 'accumulation-v1', status: 'calculated', state: 'Neutral', score: 40.4, asOf: '2026-10-07' },
    { key: 'new', name: 'New', source: 'fx', version: 'fx-v1', status: 'calculated', state: 'y', score: null, asOf: null },
  ], { commit: 'c2' });
  const diff = compareSnapshots(earlier, later);
  assert.equal(diff.status, 'compared');
  assert.equal(diff.elapsedDays, 7);
  assert.equal(diff.codeChanged, true);
  assert.deepEqual(diff.changes.map((change) => [change.key, change.kind, change.cause]), [
    ['c', 'status', 'model'],
    ['a', 'state', 'data'],
    ['b', 'score', 'unexplained'],
  ]);
  assert.equal(diff.changes[1].delta, -20);
  assert.equal(diff.unchanged, 1, 'a 0.4-point move is under the reporting threshold');
  assert.deepEqual(diff.appeared.map((entry) => entry.key), ['new']);
  assert.deepEqual(diff.disappeared.map((entry) => entry.key), ['gone']);
  assert.deepEqual(diff.byCause, { data: 1, model: 1, undated: 0, unexplained: 1 });
});

test('undated readings are undated, unless they are macro readings whose inputs printed', () => {
  const reading = (source, score) => ({ key: `${source}.x`, name: source, source, version: 'v1', status: 'calculated', state: null, score, asOf: null });
  const quiet = compareSnapshots(
    snapshotWith('2026-10-01T00:00:00Z', [reading('macro', 40), reading('fx', 40)], { vintages: [{ id: 'WALCL', observationDate: '2026-09-24' }] }),
    snapshotWith('2026-10-02T00:00:00Z', [reading('macro', 45), reading('fx', 45)], { vintages: [{ id: 'WALCL', observationDate: '2026-09-24' }] }),
  );
  assert.deepEqual(quiet.changes.map((change) => change.cause), ['undated', 'undated']);
  assert.deepEqual(quiet.vintages, { compared: 1, advanced: [] });
  const printed = compareSnapshots(
    snapshotWith('2026-10-01T00:00:00Z', [reading('macro', 40), reading('fx', 40)], { vintages: [{ id: 'WALCL', name: 'Fed', observationDate: '2026-09-24' }] }),
    snapshotWith('2026-10-02T00:00:00Z', [reading('macro', 45), reading('fx', 45)], { vintages: [{ id: 'WALCL', name: 'Fed', observationDate: '2026-10-01' }] }),
  );
  assert.deepEqual(printed.changes.map((change) => [change.key, change.cause]), [['fx.x', 'undated'], ['macro.x', 'data']]);
  assert.deepEqual(printed.vintages.advanced, [{ id: 'WALCL', name: 'Fed', from: '2026-09-24', to: '2026-10-01' }]);
});

test('files given in the wrong order are compared oldest to newest, and foreign files are refused', () => {
  const earlier = snapshotWith('2026-10-01T00:00:00Z', [{ key: 'a', status: 'calculated', state: 'x', score: 10, asOf: '2026-09-30', version: 'v1' }]);
  const later = snapshotWith('2026-10-03T00:00:00Z', [{ key: 'a', status: 'calculated', state: 'x', score: 20, asOf: '2026-10-02', version: 'v1' }]);
  const diff = compareSnapshots(later, earlier);
  assert.equal(diff.swapped, true);
  assert.equal(diff.changes[0].delta, 10);
  assert.equal(diff.from.takenAt, '2026-10-01T00:00:00Z');
  assert.equal(compareSnapshots({ hello: 1 }, later).status, 'invalid');
  assert.match(compareSnapshots(later, { snapshotVersion: 'workspace-snapshot-v0' }).reason, /current file .* \(it is workspace-snapshot-v0\)/);
});

test('readings without a name are named from the registry, then from their position, never by bare key', () => {
  const readings = collectReadings('macro', {
    asOf: '2026-10-07T12:00:00.000Z',
    model: { version: 'us-liquidity-v1', status: 'calculated', regime: 'Expanding' },
    liquidityRunway: { version: 'liquidity-runway-v1', status: 'unavailable', reason: 'x' },
    inflation: { version: 'inflation-nowcast-v1', status: 'unavailable', reason: 'x', market: { breakeven5y: { status: 'unavailable', reason: 'x' } } },
  }, { registry: [{ id: 'us-liquidity-v1', name: 'US liquidity' }] });
  assert.deepEqual(readings.map((reading) => reading.name), ['US liquidity', 'Liquidity runway', 'Inflation', 'Inflation · Breakeven 5y']);
  // A sub-reading inheriting a registered version is not given the parent's name.
  const nested = collectReadings('macro', { inflation: { version: 'us-liquidity-v1', status: 'calculated', state: 'x', leg: { status: 'calculated', state: 'y' } } }, { registry: [{ id: 'us-liquidity-v1', name: 'US liquidity' }] });
  assert.deepEqual(nested.map((reading) => reading.name), ['US liquidity', 'Inflation · Leg']);
  assert.equal(collectReadings('treasury', { version: 't', status: 'calculated', read: 'x' })[0].name, 'Treasury');
});
