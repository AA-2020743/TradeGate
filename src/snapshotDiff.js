/**
 * What changed between two workspace snapshots, and why.
 *
 * A changed reading has three possible causes, and they mean different
 * things: the model's code changed (its version string moved, so the two
 * numbers are not comparable), its data changed (the date behind it moved),
 * or neither did - the same data under the same version gave a different
 * answer, which is usually an upstream revision or an input this reading
 * depends on but does not date. Each change carries its cause so a reader
 * does not mistake a code change for a market move. A reading that carries
 * no date of its own is 'undated' rather than 'unexplained': nothing says
 * whether its data moved.
 */

export const SNAPSHOT_VERSION = 'workspace-snapshot-v1';
const DAY_MS = 86_400_000;

function indexByKey(readings) {
  return new Map((Array.isArray(readings) ? readings : []).map((reading) => [reading.key, reading]));
}

function causeOf(before, after, macroInputsPrinted) {
  if ((before.version ?? null) !== (after.version ?? null)) return 'model';
  if (!before.asOf || !after.asOf) {
    // An undated macro reading is dated by its input series instead.
    if (after.source === 'macro' && macroInputsPrinted) return 'data';
    return 'undated';
  }
  return before.asOf !== after.asOf ? 'data' : 'unexplained';
}

function label(reading) {
  return reading.name ?? reading.key;
}

/**
 * @param {object} previous  An earlier snapshot (parsed JSON).
 * @param {object} current   The newer snapshot.
 * @param {{ scoreThreshold?: number }} [options]  Smallest score move reported.
 */
export function compareSnapshots(previous, current, { scoreThreshold = 1 } = {}) {
  for (const [role, snapshot] of [['earlier', previous], ['current', current]]) {
    if (!snapshot || typeof snapshot !== 'object' || snapshot.snapshotVersion !== SNAPSHOT_VERSION) {
      return { status: 'invalid', reason: `The ${role} file is not a ${SNAPSHOT_VERSION} export${snapshot?.snapshotVersion ? ` (it is ${snapshot.snapshotVersion})` : ''}.` };
    }
  }
  let [earlier, later] = [previous, current];
  const swapped = Date.parse(previous.takenAt) > Date.parse(current.takenAt);
  if (swapped) [earlier, later] = [current, previous];

  const priorVintages = new Map((earlier.vintages ?? []).map((series) => [series.id, series]));
  const advanced = (later.vintages ?? []).flatMap((series) => {
    const prior = priorVintages.get(series.id);
    if (!prior?.observationDate || !series.observationDate || prior.observationDate === series.observationDate) return [];
    return [{ id: series.id, name: series.name ?? series.id, from: prior.observationDate, to: series.observationDate }];
  });
  const vintagesCompared = (later.vintages ?? []).filter((series) => priorVintages.get(series.id)?.observationDate && series.observationDate).length;

  const before = indexByKey(earlier.readings);
  const after = indexByKey(later.readings);
  const changes = [];
  let unchanged = 0;
  for (const [key, next] of after) {
    const prior = before.get(key);
    if (!prior) continue;
    const statusChanged = prior.status !== next.status;
    const stateChanged = (prior.state ?? null) !== (next.state ?? null);
    const delta = Number.isFinite(prior.score) && Number.isFinite(next.score) ? Math.round((next.score - prior.score) * 100) / 100 : null;
    const scoreMoved = delta !== null && Math.abs(delta) >= scoreThreshold;
    if (!statusChanged && !stateChanged && !scoreMoved) {
      unchanged += 1;
      continue;
    }
    changes.push({
      key,
      name: label(next),
      kind: statusChanged ? 'status' : stateChanged ? 'state' : 'score',
      cause: causeOf(prior, next, advanced.length > 0),
      from: { status: prior.status, state: prior.state ?? null, score: prior.score ?? null, asOf: prior.asOf ?? null, version: prior.version ?? null },
      to: { status: next.status, state: next.state ?? null, score: next.score ?? null, asOf: next.asOf ?? null, version: next.version ?? null },
      delta,
    });
  }
  const rank = { status: 0, state: 1, score: 2 };
  changes.sort((left, right) => rank[left.kind] - rank[right.kind] || Math.abs(right.delta ?? 0) - Math.abs(left.delta ?? 0) || left.key.localeCompare(right.key));

  const appeared = [...after.keys()].filter((key) => !before.has(key)).map((key) => ({ key, name: label(after.get(key)), status: after.get(key).status }));
  const disappeared = [...before.keys()].filter((key) => !after.has(key)).map((key) => ({ key, name: label(before.get(key)), status: before.get(key).status }));

  const elapsedMs = Date.parse(later.takenAt) - Date.parse(earlier.takenAt);
  return {
    status: 'compared',
    swapped,
    from: { takenAt: earlier.takenAt, commit: earlier.build?.shortCommit ?? null },
    to: { takenAt: later.takenAt, commit: later.build?.shortCommit ?? null },
    elapsedDays: Number.isFinite(elapsedMs) ? Math.round((elapsedMs / DAY_MS) * 10) / 10 : null,
    codeChanged: Boolean(earlier.build?.commit && later.build?.commit && earlier.build.commit !== later.build.commit),
    changes,
    unchanged,
    appeared,
    disappeared,
    vintages: { compared: vintagesCompared, advanced },
    byCause: {
      data: changes.filter((change) => change.cause === 'data').length,
      model: changes.filter((change) => change.cause === 'model').length,
      undated: changes.filter((change) => change.cause === 'undated').length,
      unexplained: changes.filter((change) => change.cause === 'unexplained').length,
    },
  };
}
