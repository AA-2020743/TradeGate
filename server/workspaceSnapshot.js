/**
 * A dated, exportable record of every published reading.
 *
 * A screenshot of the page says what a model read but not which data it read
 * or which code read it, so a number captured last month cannot be checked
 * against today's. A snapshot carries the build commit, each model's version
 * and status, the date of the data behind each reading, and the observation
 * date of every macro input series - enough to say, for any reading that
 * changed between two snapshots, whether the data moved, the code moved, or
 * only the clock did.
 *
 * Readings are found by walking the payloads rather than by a hand-kept list:
 * every model here publishes `{ status, version?, read?, reason? }`, and a
 * list maintained beside them would drift from them the first time a model
 * was added without it.
 */

export const SNAPSHOT_VERSION = 'workspace-snapshot-v1';

const STATUSES = new Set(['calculated', 'provisional', 'unavailable', 'insufficient-history', 'stale', 'partial']);
const MAX_DEPTH = 4;
const COMPUTE_STAMP_TOLERANCE_MS = 5_000;
// Bulky arrays of history or methodology that never hold a current reading.
const SKIP_KEYS = new Set(['history', 'points', 'series', 'observations', 'weeklyObservations', 'transitions', 'boundaries', 'priceLadder', 'backtest', 'components', 'cells', 'horizons', 'legs', 'spreads', 'events', 'samples', 'narrative', 'errors', 'seriesHealth', 'methodology', 'ladder']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (isPlainObject(value) && typeof value.label === 'string') return value.label;
  return null;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stateOf(node) {
  return text(node.regime) ?? text(node.state) ?? text(node.band) ?? text(node.tier) ?? text(node.rating) ?? null;
}

function scoreOf(node) {
  return finite(node.score) ?? finite(node.risk) ?? null;
}

function isReading(node) {
  if (typeof node.status !== 'string' || !STATUSES.has(node.status)) return false;
  return typeof node.version === 'string' || typeof node.read === 'string' || typeof node.reason === 'string' || stateOf(node) !== null || scoreOf(node) !== null;
}

function humanize(segment) {
  const words = String(segment).replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Most macro models carry no display name. A model whose own version is in
 * the registry takes the registry's name; anything else is named from where
 * it sits, so a reader never sees a bare key as the name.
 */
function nameFor(node, path, ownVersion, registryNames) {
  if (typeof node.name === 'string' && node.name.trim()) return node.name;
  if (ownVersion && registryNames.has(ownVersion)) return registryNames.get(ownVersion);
  if (!path.length) return null;
  const last = humanize(path.at(-1));
  return path.length > 1 ? `${humanize(path[0])} \u00b7 ${last}` : last;
}

function segmentFor(element, index) {
  return String(element?.key ?? element?.symbol ?? element?.id ?? element?.currency ?? element?.tenor ?? element?.klass ?? element?.name ?? index);
}

/**
 * @param {string} source  The section the payload came from, e.g. "macro".
 * @param {unknown} payload
 * @returns {Array<object>} One row per reading, keyed `source.path`.
 */
export function collectReadings(source, payload, { registry = [] } = {}) {
  const registryNames = new Map(registry.map((entry) => [entry.id, entry.name]));
  const readings = [];
  // Sub-models built in the same call as the payload sometimes stamp the same
  // clock time; within a few seconds of it, a date is the computation's.
  const computedAt = isPlainObject(payload) && typeof payload.asOfSource !== 'string' ? Date.parse(payload.asOf) : Number.NaN;
  const isComputeStamp = (asOf) => Number.isFinite(computedAt) && asOf.length > 10 && Math.abs(Date.parse(asOf) - computedAt) <= COMPUTE_STAMP_TOLERANCE_MS;
  const walk = (node, path, inheritedVersion, depth) => {
    if (!isPlainObject(node) || depth > MAX_DEPTH) return;
    const version = typeof node.version === 'string' ? node.version : inheritedVersion;
    // A payload's own asOf is usually when it was computed, not what it read,
    // and inheriting it would date every reading to the request. Only a
    // model's own date counts, or a payload date that names its source (the
    // stalest-input vintage); a reading with neither is honestly undated.
    const ownDate = typeof node.asOf === 'string' && (depth > 0 ? !isComputeStamp(node.asOf) : typeof node.asOfSource === 'string');
    const asOf = ownDate ? node.asOf : null;
    if (isReading(node)) {
      readings.push({
        key: [source, ...path].join('.'),
        source,
        name: nameFor(node, path, typeof node.version === 'string' ? node.version : null, registryNames) ?? humanize(source),
        version: version ?? null,
        status: node.status,
        state: stateOf(node),
        score: scoreOf(node),
        asOf: asOf ?? null,
        asOfSource: typeof node.asOfSource === 'string' ? node.asOfSource : null,
        read: typeof node.read === 'string' ? node.read : null,
        reason: node.status === 'unavailable' && typeof node.reason === 'string' ? node.reason : null,
      });
    }
    for (const [key, child] of Object.entries(node)) {
      if (SKIP_KEYS.has(key)) continue;
      if (Array.isArray(child)) {
        child.forEach((element, index) => {
          if (isPlainObject(element)) walk(element, [...path, key, segmentFor(element, index)], version, depth + 1);
        });
      } else if (isPlainObject(child)) {
        walk(child, [...path, key], version, depth + 1);
      }
    }
  };
  walk(payload, [], null, 0);
  return readings;
}

/**
 * The observation date of each macro input, so a reading that did not change
 * can be told apart from one whose inputs did not print.
 */
export function collectVintages(liquidity) {
  return (Array.isArray(liquidity?.seriesHealth) ? liquidity.seriesHealth : []).map((series) => ({
    id: series.id ?? null,
    name: series.name ?? null,
    observationDate: series.asOf ?? null,
    state: series.state ?? null,
    stored: Boolean(series.stored),
  }));
}

/**
 * @param {{ build: object, registry: Array<{ id: string }>, takenAt?: string, sources: Record<string, PromiseSettledResult<unknown>> }} input
 */
export function buildWorkspaceSnapshot({ build, registry = [], takenAt = new Date().toISOString(), sources = {} }) {
  const readings = [];
  const failures = [];
  for (const [source, result] of Object.entries(sources)) {
    if (result?.status !== 'fulfilled') {
      failures.push({ source, reason: result?.reason?.message ?? String(result?.reason ?? 'The loader failed without a message.') });
      continue;
    }
    readings.push(...collectReadings(source, result.value, { registry }));
  }
  const keys = new Set();
  const unique = readings.filter((reading) => (keys.has(reading.key) ? false : keys.add(reading.key)));
  const macro = sources.macro?.status === 'fulfilled' ? sources.macro.value : null;
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    takenAt,
    build: build ? { commit: build.commit ?? null, shortCommit: build.shortCommit ?? null } : null,
    models: registry.map((entry) => entry.id),
    counts: {
      readings: unique.length,
      calculated: unique.filter((reading) => reading.status === 'calculated').length,
      unavailable: unique.filter((reading) => reading.status === 'unavailable').length,
      failedSources: failures.length,
    },
    readings: unique,
    vintages: collectVintages(macro),
    failures,
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let string = String(value);
  // A spreadsheet runs a cell that opens with = + @ or - as a formula; a
  // negative number is the one such opening that has to survive as is.
  if (/^[=+@\t\r]/.test(string) || (/^-/.test(string) && !/^-\d/.test(string))) string = `'${string}`;
  return /[",\r\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
}

const CSV_COLUMNS = ['key', 'name', 'version', 'status', 'state', 'score', 'asOf', 'read', 'reason'];

/** One row per reading, with the snapshot's commit and time on every row so rows survive being pasted elsewhere. */
export function snapshotToCsv(snapshot) {
  const header = ['takenAt', 'commit', ...CSV_COLUMNS];
  const rows = (snapshot?.readings ?? []).map((reading) => [snapshot.takenAt, snapshot.build?.shortCommit ?? '', ...CSV_COLUMNS.map((column) => reading[column])]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
