/**
 * What changed since yesterday, from snapshots the server keeps itself.
 *
 * The manual comparison needs an earlier snapshot file in hand. This keeps
 * one a day in the database - written when the newest stored copy is at
 * least MIN_AGE_HOURS old - and compares the live workspace against the
 * newest stored copy that is at least that old, with the same comparison the
 * manual one uses, so a change still carries its cause (data, model code, or
 * neither) rather than reading as a market move.
 */

import { compareSnapshots } from '../src/snapshotDiff.js';

export const DAILY_SNAPSHOT_MODEL_ID = 'workspace-snapshot';
export const MIN_AGE_HOURS = 20;
const KEEP_SNAPSHOTS = 90;
const HOUR_MS = 3_600_000;

function takenAtOf(entry) {
  return Date.parse(entry?.output?.takenAt ?? '');
}

/** The newest stored snapshot taken at least `minAgeHours` before `now`. */
export function pickBaseline(stored, now, minAgeHours = MIN_AGE_HOURS) {
  return [...(stored ?? [])]
    .filter((entry) => Number.isFinite(takenAtOf(entry)) && now - takenAtOf(entry) >= minAgeHours * HOUR_MS)
    .sort((left, right) => takenAtOf(right) - takenAtOf(left))[0] ?? null;
}

/** Whether today's copy is due: nothing stored, or the newest is at least `minAgeHours` old. */
export function snapshotDue(stored, now, minAgeHours = MIN_AGE_HOURS) {
  const newest = Math.max(...(stored ?? []).map(takenAtOf).filter(Number.isFinite), -Infinity);
  return !Number.isFinite(newest) || now - newest >= minAgeHours * HOUR_MS;
}

let pendingStore = null;

/**
 * @param {{ take: () => Promise<object>, load: () => Promise<Array<{ output: object }>>, store: (snapshot: object) => Promise<void>, prune?: (keep: number) => Promise<unknown>, databaseConfigured: boolean, now?: number }} io
 */
export async function getDailyChanges({ take, load, store, prune = async () => {}, databaseConfigured, now = Date.now() }) {
  if (!databaseConfigured) {
    return { status: 'unavailable', reason: 'Daily snapshots are kept in PostgreSQL, and no database is configured. The manual comparison below still works with a downloaded snapshot.' };
  }
  const [current, stored] = await Promise.all([take(), load()]);
  if (snapshotDue(stored, now) && !pendingStore) {
    pendingStore = store(current).then(() => prune(KEEP_SNAPSHOTS)).finally(() => { pendingStore = null; });
    await pendingStore.catch(() => {});
  }
  const baseline = pickBaseline(stored, now);
  if (!baseline) {
    const oldest = (stored ?? []).map(takenAtOf).filter(Number.isFinite).sort((left, right) => left - right)[0];
    const first = Number.isFinite(oldest) ? new Date(oldest).toISOString() : current.takenAt;
    return { status: 'provisional', reason: `The first daily snapshot was stored at ${first.slice(0, 16).replace('T', ' ')} UTC; a comparison appears once one is at least ${MIN_AGE_HOURS} hours old.`, storedSnapshots: (stored ?? []).length || 1 };
  }
  const diff = compareSnapshots(baseline.output, current);
  if (diff.status !== 'compared') return { status: 'unavailable', reason: diff.reason };
  return { ...diff, status: 'calculated', storedSnapshots: (stored ?? []).length };
}
