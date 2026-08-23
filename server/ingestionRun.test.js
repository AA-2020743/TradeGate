import test from 'node:test';
import assert from 'node:assert/strict';
import { observationTimestamp, runIngestionJob } from './ingestionRun.js';

const silent = { error: () => {} };

function harness(overrides = {}) {
  const calls = { finished: [], started: [], released: 0 };
  return {
    calls,
    deps: {
      acquireLock: overrides.acquireLock ?? (async () => ({
        acquired: true,
        release: overrides.release ?? (async () => { calls.released += 1; }),
      })),
      startRun: overrides.startRun ?? (async (job) => { calls.started.push(job); return 42; }),
      finishRun: overrides.finishRun ?? (async (...args) => { calls.finished.push(args); }),
      logger: overrides.logger ?? silent,
    },
  };
}

test('a completed job records its run and returns what the loader produced', async () => {
  const { calls, deps } = harness();
  const result = await runIngestionJob('market', async ({ runId, reportWritten }) => {
    assert.equal(runId, 42);
    reportWritten(12);
    reportWritten(8);
    return { details: { symbols: 3 } };
  }, deps);

  assert.deepEqual(calls.started, ['market']);
  assert.equal(result.status, 'completed');
  assert.equal(result.observationsWritten, 20);
  assert.deepEqual(result.details, { symbols: 3 });
  assert.deepEqual(calls.finished, [[42, 'completed', 20, { symbols: 3 }]]);
  assert.equal(calls.released, 1);
});

test('a loader can declare its own terminal status', async () => {
  const { calls, deps } = harness();
  const result = await runIngestionJob('macro', async () => ({ status: 'partial', details: { missing: 2 } }), deps);
  assert.equal(result.status, 'partial');
  assert.equal(calls.finished[0][1], 'partial');
});

test('a job already held elsewhere is skipped without starting a run', async () => {
  const { calls, deps } = harness({ acquireLock: async () => ({ acquired: false, release: async () => {} }) });
  let loaderRan = false;
  const result = await runIngestionJob('market', async () => { loaderRan = true; return {}; }, deps);

  assert.equal(loaderRan, false);
  assert.equal(result.status, 'skipped');
  assert.equal(result.observationsWritten, 0);
  assert.match(result.details.reason, /active on another process/);
  assert.deepEqual(calls.started, []);
  assert.deepEqual(calls.finished, []);
});

test('a failing loader records the failure, keeps the count, and re-raises', async () => {
  const { calls, deps } = harness();
  const failure = new Error('Upstream request failed with 403');
  await assert.rejects(
    () => runIngestionJob('history', async ({ reportWritten }) => { reportWritten(5); throw failure; }, deps),
    /403/,
  );
  assert.deepEqual(calls.finished, [[42, 'failed', 5, {}, 'Upstream request failed with 403']]);
  assert.equal(calls.released, 1);
});

test('the lock is released even when starting the run itself fails', async () => {
  const { calls, deps } = harness({ startRun: async () => { throw new Error('no database'); } });
  await assert.rejects(() => runIngestionJob('market', async () => ({}), deps), /no database/);
  assert.equal(calls.released, 1);
  // The run never started, so the failure is recorded against a null id.
  assert.equal(calls.finished[0][0], null);
});

test('a failure while recording the failure does not replace the original error', async () => {
  const logged = [];
  const { deps } = harness({
    finishRun: async () => { throw new Error('bookkeeping exploded'); },
    logger: { error: (message) => logged.push(message) },
  });
  await assert.rejects(
    () => runIngestionJob('macro', async () => { throw new Error('the real problem'); }, deps),
    /the real problem/,
  );
  assert.equal(logged.length, 1);
  assert.match(logged[0], /Could not record the failed macro run: bookkeeping exploded/);
});

test('a lock that cannot be released does not mask a successful run', async () => {
  const logged = [];
  const { deps } = harness({
    release: async () => { throw new Error('connection dropped'); },
    logger: { error: (message) => logged.push(message) },
  });
  const result = await runIngestionJob('research', async () => ({ details: { ok: true } }), deps);
  assert.equal(result.status, 'completed');
  assert.match(logged[0], /Could not release the research ingestion lock: connection dropped/);
});

test('a lock that cannot be released does not mask the job failure either', async () => {
  const { deps } = harness({
    release: async () => { throw new Error('connection dropped'); },
    logger: silent,
  });
  await assert.rejects(
    () => runIngestionJob('research', async () => { throw new Error('provider down'); }, deps),
    /provider down/,
  );
});

test('a non-numeric written count is ignored rather than poisoning the total', async () => {
  const { deps } = harness();
  const result = await runIngestionJob('market', async ({ reportWritten }) => {
    reportWritten(10);
    reportWritten(undefined);
    reportWritten(Number.NaN);
    reportWritten(5);
    return {};
  }, deps);
  assert.equal(result.observationsWritten, 15);
});

test('observation timestamps fall back to the run time when a provider date will not parse', () => {
  const fallback = '2026-08-20T12:00:00.000Z';
  assert.equal(observationTimestamp('2026-08-19T00:00:00.000Z', fallback), '2026-08-19T00:00:00.000Z');
  assert.equal(observationTimestamp('not a date', fallback), fallback);
  assert.equal(observationTimestamp(null, fallback), fallback);
  assert.equal(observationTimestamp(undefined, fallback), fallback);
  assert.equal(observationTimestamp('', fallback), fallback);
});
