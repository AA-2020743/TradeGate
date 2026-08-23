/**
 * Timestamp for a persisted observation. Providers occasionally return a date
 * that will not parse; the run's own time is used rather than writing an
 * Invalid Date into the series.
 */
export function observationTimestamp(value, fallback) {
  const timestamp = value ? new Date(value) : new Date(fallback);
  return Number.isNaN(timestamp.getTime()) ? new Date(fallback).toISOString() : timestamp.toISOString();
}

/**
 * Runs one ingestion job under its cross-process lock and records the outcome.
 *
 * The bookkeeping around a job must never obscure the job. Recording a failure
 * can itself fail, and so can releasing the lock — in both cases the original
 * error is what the caller needs, so those are logged and swallowed rather than
 * thrown over the top of it. A lock that cannot be released is recovered by the
 * next run's acquisition, not by crashing this one.
 */
export async function runIngestionJob(jobName, loader, { acquireLock, startRun, finishRun, logger = console } = {}) {
  const lock = await acquireLock(jobName);
  if (!lock?.acquired) {
    return { status: 'skipped', observationsWritten: 0, details: { reason: 'Job is active on another process' } };
  }

  let runId = null;
  let observationsWritten = 0;
  const reportWritten = (count) => {
    if (Number.isFinite(count)) observationsWritten += count;
  };

  try {
    runId = await startRun(jobName);
    const result = await loader({ runId, reportWritten });
    const status = result?.status ?? 'completed';
    await finishRun(runId, status, observationsWritten, result?.details);
    return { ...result, status, observationsWritten };
  } catch (error) {
    try {
      await finishRun(runId, 'failed', observationsWritten, {}, error.message);
    } catch (bookkeepingError) {
      logger?.error?.(`Could not record the failed ${jobName} run: ${bookkeepingError.message}`);
    }
    throw error;
  } finally {
    try {
      await lock.release();
    } catch (releaseError) {
      logger?.error?.(`Could not release the ${jobName} ingestion lock: ${releaseError.message}`);
    }
  }
}
