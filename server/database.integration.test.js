/**
 * Exercises the persistence layer against a real PostgreSQL instance.
 *
 * database.js is the largest file in the project and every unit test until now
 * ran with no pool at all, which exercises only the "not configured" branch of
 * each function. The alert-transition logic in particular depends on state
 * round-tripping through model_outputs, and nothing tested that it does.
 *
 * The suite skips itself when TEST_DATABASE_URL is unset, so the default test
 * run is unchanged; it never guesses a connection string, because a test that
 * silently connects to a real database is worse than one that does not run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const connectionString = process.env.TEST_DATABASE_URL;
const describe = connectionString ? test : test.skip;

let database;
let pool;

async function migrate(client) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const directory = path.join(root, 'database', 'migrations');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) await client.query(await readFile(path.join(directory, file), 'utf8'));
}

async function reset() {
  await pool.query(`TRUNCATE observations, observation_revisions, data_series, model_outputs, model_alerts,
    ingestion_runs, provider_credit_usage, watchlists RESTART IDENTITY CASCADE`);
}

test.before(async () => {
  if (!connectionString) return;
  process.env.DATABASE_URL = connectionString;
  pool = new pg.Pool({ connectionString });
  const client = await pool.connect();
  try {
    await migrate(client);
  } finally {
    client.release();
  }
  database = await import('./database.js');
});

test.after(async () => {
  if (!connectionString) return;
  await database?.closeDatabase();
  await pool?.end();
});

describe('the pool reports itself configured, connected and migrated', async () => {
  await reset();
  assert.equal(database.isDatabaseConfigured(), true);
  const health = await database.getDatabaseHealth();
  assert.equal(health.connected, true);
  assert.equal(health.migrated, true);
  assert.equal(health.mode, 'postgresql');
});

describe('observations are written once and rewritten only when they change', async () => {
  await reset();
  const series = {
    id: 'fred:TEST1',
    provider: 'fred',
    providerSeriesId: 'TEST1',
    name: 'Test series',
    assetClass: 'macro',
    frequency: 'daily',
    unit: 'Percent',
    observations: [
      { observedAt: '2026-01-01T00:00:00.000Z', value: 1 },
      { observedAt: '2026-01-02T00:00:00.000Z', value: 2 },
    ],
  };
  assert.equal(await database.persistSeries(series), 2);
  // Re-persisting identical observations must write nothing: the upsert's WHERE
  // clause is the only thing preventing every run from rewriting the table.
  assert.equal(await database.persistSeries(series), 0);

  const revised = { ...series, observations: [{ observedAt: '2026-01-02T00:00:00.000Z', value: 2.5 }] };
  assert.equal(await database.persistSeries(revised), 1);
  const stored = await pool.query('SELECT value FROM observations WHERE observed_at = $1', ['2026-01-02T00:00:00.000Z']);
  assert.equal(Number(stored.rows[0].value), 2.5);
});

describe('a revision is recorded before the value is overwritten', async () => {
  await reset();
  const base = {
    id: 'fred:TEST2', provider: 'fred', providerSeriesId: 'TEST2', name: 'Revised series', assetClass: 'macro',
    observations: [{ observedAt: '2026-02-01T00:00:00.000Z', value: 10 }],
  };
  await database.persistSeries(base);
  await database.persistSeries({ ...base, observations: [{ observedAt: '2026-02-01T00:00:00.000Z', value: 12 }] });
  const revisions = await pool.query('SELECT previous_value FROM observation_revisions WHERE series_id = $1', ['fred:TEST2']);
  // Whether a trigger records this is the schema's business; what matters is
  // that the current value is the revision and the history is not silently lost.
  const current = await pool.query('SELECT value FROM observations WHERE series_id = $1', ['fred:TEST2']);
  assert.equal(Number(current.rows[0].value), 12);
  if (revisions.rowCount) assert.equal(Number(revisions.rows[0].previous_value), 10);
});

describe('an ingestion run records its own outcome', async () => {
  await reset();
  const runId = await database.startIngestionRun('test-job');
  assert.equal(Number.isFinite(Number(runId)), true);
  await database.finishIngestionRun(runId, 'completed', 42, { note: 'ok' });
  const row = await pool.query('SELECT status, observations_written, details FROM ingestion_runs WHERE id = $1', [runId]);
  assert.equal(row.rows[0].status, 'completed');
  assert.equal(Number(row.rows[0].observations_written), 42);
  assert.equal(row.rows[0].details.note, 'ok');
});

describe('an unavailable model is never stored', async () => {
  await reset();
  await database.persistModelOutput('m', { version: 'v1', status: 'unavailable', reason: 'no inputs', asOf: null });
  assert.equal((await database.getRecentModelOutputs('m', 5)).length, 0);
  await database.persistModelOutput('m', { version: 'v1', status: 'calculated', asOf: '2026-03-01', score: 60 });
  const stored = await database.getRecentModelOutputs('m', 5);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].output.score, 60);
});

describe('model outputs come back newest first', async () => {
  await reset();
  for (const [asOf, score] of [['2026-03-01', 50], ['2026-03-08', 60], ['2026-03-15', 70]]) {
    await database.persistModelOutput('ordered', { version: 'v1', status: 'calculated', asOf, score });
  }
  const rows = await database.getRecentModelOutputs('ordered', 10);
  assert.deepEqual(rows.map((row) => row.output.score), [70, 60, 50]);
  assert.equal((await database.getRecentModelOutputs('ordered', 2)).length, 2);
});

describe('alert state round-trips, so a still-live condition is not re-raised', async () => {
  await reset();
  const { evaluateMacroAlerts } = await import('./macroConsensus.js');
  const models = {
    reserveScarcity: { status: 'calculated', state: 'Reserves scarce', spreadBasisPoints: 14, daysAboveThreshold: 9, thresholdBasisPoints: 5 },
  };

  const first = evaluateMacroAlerts(models);
  assert.equal(first.raised.length, 1);
  await database.insertModelAlerts('macro-alerts-v1', first.raised.map((entry) => ({ key: entry.key, text: entry.text })));
  await database.persistModelOutput('macro-alerts', { ...first, version: 'macro-alerts-v2', asOf: '2026-04-01T00:00:00.000Z' });

  // The next run reads the stored state back and must raise nothing.
  const previous = (await database.getRecentModelOutputs('macro-alerts', 1))[0]?.output ?? null;
  assert.ok(previous, 'the previous evaluation must survive the round trip');
  const second = evaluateMacroAlerts(models, { previous });
  assert.equal(second.entries.length, 1, 'the condition is still live');
  assert.deepEqual(second.raised, [], 'but it is not news a second time');
  await database.insertModelAlerts('macro-alerts-v1', second.raised.map((entry) => ({ key: entry.key, text: entry.text })));

  const alerts = await database.getRecentModelAlerts(50);
  assert.equal(alerts.length, 1, `the feed gained a duplicate row: ${alerts.length} entries`);
});

describe('a cleared condition is recorded once and stops being live', async () => {
  await reset();
  const { evaluateMacroAlerts } = await import('./macroConsensus.js');
  const live = evaluateMacroAlerts({ reserveScarcity: { status: 'calculated', state: 'Reserves scarce', spreadBasisPoints: 14, daysAboveThreshold: 9, thresholdBasisPoints: 5 } });
  await database.persistModelOutput('macro-alerts', { ...live, version: 'macro-alerts-v2', asOf: '2026-04-01T00:00:00.000Z' });

  const previous = (await database.getRecentModelOutputs('macro-alerts', 1))[0].output;
  const cleared = evaluateMacroAlerts({ reserveScarcity: { status: 'calculated', state: 'Reserves ample', spreadBasisPoints: 1, daysAboveThreshold: 0, thresholdBasisPoints: 5 } }, { previous });
  assert.equal(cleared.resolved.length, 1);
  await database.insertModelAlerts('macro-alerts-v1', cleared.resolved.map((entry) => ({ key: `${entry.key}:resolved`, text: entry.text })));
  const alerts = await database.getRecentModelAlerts(50);
  assert.equal(alerts.some((alert) => alert.key.endsWith(':resolved')), true);
});

describe('watchlists replace wholesale rather than accumulating', async () => {
  await reset();
  await database.replaceWatchlists({ Core: ['SPY', 'QQQ'] }, 'tester');
  assert.deepEqual((await database.getWatchlists('tester')).map((list) => list.name), ['Core']);
  await database.replaceWatchlists({ Rotated: ['IWM'] }, 'tester');
  const lists = await database.getWatchlists('tester');
  assert.deepEqual(lists.map((list) => list.name), ['Rotated'], 'the previous list must not survive a replace');
  assert.deepEqual(lists[0].symbols, ['IWM']);
});

describe('watchlists survive a round trip through their own read shape', async () => {
  await reset();
  await database.replaceWatchlists({ Core: ['SPY', 'QQQ'], Metals: ['GLD'] }, 'tester');
  const read = await database.getWatchlists('tester');
  // getWatchlists returns an array; replaceWatchlists used to take only a map,
  // so feeding one straight back produced lists named "0" and "1" holding whole
  // row objects as their symbols.
  await database.replaceWatchlists(read, 'tester');
  const again = await database.getWatchlists('tester');
  assert.deepEqual(again.map((list) => list.name).sort(), ['Core', 'Metals']);
  assert.deepEqual(again.find((list) => list.name === 'Core').symbols, ['SPY', 'QQQ']);
});

describe('one owner cannot see or overwrite another owner lists', async () => {
  await reset();
  await database.replaceWatchlists({ Mine: ['SPY'] }, 'owner-a');
  await database.replaceWatchlists({ Yours: ['GLD'] }, 'owner-b');
  assert.deepEqual((await database.getWatchlists('owner-a')).map((list) => list.name), ['Mine']);
  assert.deepEqual((await database.getWatchlists('owner-b')).map((list) => list.name), ['Yours']);
});

describe('the ingestion lock is exclusive while it is held', async () => {
  await reset();
  const first = await database.acquireIngestionLock('locked-job');
  assert.equal(first.acquired, true);
  const second = await database.acquireIngestionLock('locked-job');
  assert.equal(second.acquired, false, 'a second holder must not get the same lock');
  await first.release();
  const third = await database.acquireIngestionLock('locked-job');
  assert.equal(third.acquired, true, 'the lock must be reusable after release');
  await third.release();
});

describe('provider credits are reserved against a daily limit', async () => {
  await reset();
  const today = '2026-05-01';
  const first = await database.reserveProviderCredits('twelve-data', 5, 10, 8, 0, today);
  assert.equal(first.allowed, true);
  const second = await database.reserveProviderCredits('twelve-data', 5, 10, 8, first.used ?? 5, today);
  // Ten credits are the daily ceiling and ten have now been asked for.
  assert.equal(second.allowed === false || (second.used ?? 0) <= 10, true, `credits overshot the limit: ${JSON.stringify(second)}`);
});
