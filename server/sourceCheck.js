/**
 * One line of truth per external source: did it answer, with what, and if
 * not, why.
 *
 * Several sources here were built against documented response shapes from a
 * network that could not reach them, so the first real run is on the
 * deployment. This turns that run into something readable: each loader is
 * called once, and its payload is reduced to a verdict, its sub-parts'
 * states, a key figure, and the upstream reasons it gave for anything it
 * could not publish.
 */

const PUBLISHED = new Set(['calculated', 'provisional', 'partial', 'stable', 'updated', 'compared']);

function statusOf(value) {
  return value && typeof value === 'object' && typeof value.status === 'string' ? value.status : null;
}

function labelOf(value, fallback) {
  return String(value?.currency ?? value?.symbol ?? value?.key ?? value?.tenor ?? value?.name ?? fallback);
}

/** The states of a payload's immediate parts: named sub-models and arrays of them. */
export function partStates(payload) {
  const parts = [];
  if (!payload || typeof payload !== 'object') return parts;
  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      const states = value.filter((item) => statusOf(item)).map((item, index) => `${labelOf(item, index)}=${item.status}`);
      if (states.length) parts.push(`${key}: ${states.slice(0, 8).join(' ')}${states.length > 8 ? ` (+${states.length - 8})` : ''}`);
    } else if (statusOf(value)) {
      parts.push(`${key}=${value.status}`);
    }
  }
  return parts;
}

/** Upstream reasons, de-duplicated, from the payload and its unavailable parts. */
export function reasonsFrom(payload, limit = 4) {
  const reasons = [];
  const add = (text) => {
    const clean = typeof text === 'string' ? text.trim() : '';
    if (clean && !reasons.includes(clean)) reasons.push(clean);
  };
  if (!payload || typeof payload !== 'object') return reasons;
  if (!PUBLISHED.has(payload.status)) add(payload.reason);
  for (const error of Array.isArray(payload.errors) ? payload.errors : []) add(typeof error === 'string' ? error : error?.message);
  for (const value of Object.values(payload)) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) if (statusOf(item) === 'unavailable') add(item.reason);
  }
  return reasons.slice(0, limit);
}

/**
 * @param {{ name: string, endpoint?: string, figure?: (payload: any) => string|null, answered?: (payload: any) => boolean }} source
 * @param {PromiseSettledResult<any>} result
 * @param {number} elapsedMs
 */
export function summarizeSource(source, result, elapsedMs) {
  const base = { name: source.name, endpoint: source.endpoint ?? null, seconds: Math.round(elapsedMs / 100) / 10 };
  if (result.status === 'rejected') {
    return { ...base, verdict: 'failed', status: 'error', figure: null, parts: [], reasons: [result.reason?.message ?? String(result.reason)] };
  }
  const payload = result.value;
  const parts = partStates(payload);
  const anyPartPublished = parts.some((part) => /=(calculated|provisional|partial|pass)\b/.test(part));
  // Some payloads carry no status of their own (the FRED snapshot, the quote
  // board); the source then says what answering means for it.
  const answered = typeof source.answered === 'function' ? Boolean(source.answered(payload)) : null;
  // A source that fell short of its own test but still published parts (31 of
  // 32 FRED series, the missing one stood in by a stored observation) is
  // incomplete, not empty.
  const status = statusOf(payload) ?? (answered === null ? 'unknown' : answered ? 'answered' : anyPartPublished ? 'incomplete' : 'empty');
  const verdict = status === 'calculated' || status === 'answered' ? 'ok' : PUBLISHED.has(status) || anyPartPublished ? 'partial' : 'failed';
  let figure = null;
  try {
    figure = source.figure ? source.figure(payload) : null;
  } catch {
    figure = null;
  }
  const values = plausibilityOf(source, payload);
  const implausible = values.filter((value) => !value.ok);
  // A source that parsed but reports a value no market has produced is more
  // likely misread (a percent read as a fraction, millions as billions) than
  // right, and must not show OK.
  const adjusted = implausible.length && verdict === 'ok' ? 'partial' : verdict;
  return { ...base, verdict: adjusted, status, figure, parts, values, reasons: [...implausible.map((value) => `${value.label} = ${value.value}${value.unit ?? ''} is outside the plausible ${value.min}-${value.max}${value.unit ?? ''}: check the reader's units`), ...reasonsFrom(payload)] };
}

/**
 * Key figures against generous plausible ranges. The readers for several
 * sources were written from documentation without a live response to check
 * against; a range wide enough for any real market and narrow enough to
 * catch a scale error is the cheapest test that the numbers mean what they
 * are labelled.
 */
export function plausibilityOf(source, payload) {
  if (typeof source.plausible !== 'function') return [];
  let entries;
  try {
    entries = source.plausible(payload) ?? [];
  } catch {
    return [];
  }
  return entries
    .filter((entry) => Number.isFinite(entry?.value))
    .map((entry) => ({ label: entry.label, value: Math.round(entry.value * 1000) / 1000, min: entry.min, max: entry.max, unit: entry.unit ?? '', ok: entry.value >= entry.min && entry.value <= entry.max }));
}

const MARKS = { ok: 'OK  ', partial: 'PART', failed: 'FAIL' };

export function formatReport(summaries) {
  const lines = [];
  for (const summary of summaries) {
    lines.push(`${MARKS[summary.verdict]}  ${summary.name}  [${summary.status}, ${summary.seconds}s]${summary.figure ? `  ${summary.figure}` : ''}`);
    if (summary.endpoint) lines.push(`      ${summary.endpoint}`);
    for (const part of summary.parts.slice(0, 4)) lines.push(`      ${part}`);
    if (summary.values?.length) lines.push(`      values: ${summary.values.map((value) => `${value.label} ${value.value}${value.unit}${value.ok ? '' : ' (!)'}`).join(', ')}`);
    for (const reason of summary.reasons) lines.push(`      - ${reason.length > 220 ? `${reason.slice(0, 217)}...` : reason}`);
  }
  const ok = summaries.filter((summary) => summary.verdict === 'ok').length;
  const partial = summaries.filter((summary) => summary.verdict === 'partial').length;
  lines.push('', `${ok} of ${summaries.length} sources fully answered, ${partial} partly, ${summaries.length - ok - partial} not at all.`);
  return lines.join('\n');
}

/**
 * Whether stored history is being kept current. Ingestion is off unless
 * INGESTION_ENABLED=true, and a server running without it serves every model
 * from live calls while its stored series and alert record silently age.
 */
export function summarizeIngestion({ enabled, databaseConfigured, jobs = [], now = Date.now(), staleAfterHours = 36, runningGraceMinutes = 120 }) {
  if (!databaseConfigured) return { verdict: 'failed', lines: ['No database is configured, so nothing is stored and ingestion cannot run.'] };
  const lines = [];
  let verdict = enabled ? 'ok' : 'failed';
  if (!enabled) lines.push('INGESTION_ENABLED is not true in .env: the scheduler is off, so stored history, model outputs and alerts are not being updated.');
  if (!jobs.length) {
    lines.push('No ingestion run has ever been recorded.');
    return { verdict: 'failed', lines };
  }
  for (const job of jobs) {
    const finished = job.finished_at ? new Date(job.finished_at).getTime() : null;
    const startedMinutes = Math.round((now - new Date(job.started_at).getTime()) / 60_000);
    // A run started within the window the scheduler allows before closing it
    // as abandoned is in progress, not stuck: a check run just after a
    // restart found two jobs mid-run and called them never finished.
    if (finished === null && job.status === 'running' && Number.isFinite(startedMinutes) && startedMinutes <= runningGraceMinutes) {
      lines.push(`${job.job_name}: running, started ${startedMinutes} min ago`);
      continue;
    }
    const ageHours = finished === null ? null : Math.round((now - finished) / 3_600_000);
    const stale = ageHours === null || ageHours > staleAfterHours;
    if (stale && verdict === 'ok') verdict = 'partial';
    const when = ageHours === null ? `started ${new Date(job.started_at).toISOString().slice(0, 16)} and never finished` : ageHours < 48 ? `${ageHours}h ago` : `${Math.round(ageHours / 24)} days ago`;
    lines.push(`${job.job_name}: ${job.status}, ${when}${job.error_message ? ` - ${job.error_message}` : ''}`);
  }
  return { verdict, lines };
}

/**
 * Reads a source from the running app instead of calling its provider again.
 *
 * Run beside the app, a second process has none of its caches and its own
 * per-minute rate limiter, so it repeated the app's provider calls and drew
 * 429s from Twelve Data and bitcoin-data.com that the app never saw - and
 * reported them as the app's failures. Reading the endpoint checks exactly
 * what the app serves and costs no provider call.
 */
export function servedLoader(baseUrl, endpoint, { fetchImpl = globalThis.fetch, timeoutMs = 90_000 } = {}) {
  return async () => {
    const response = await fetchImpl(`${baseUrl}${endpoint}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) throw new Error(`${endpoint} answered ${response.status}${body?.error ? `: ${body.error}` : ''}`);
    return body;
  };
}

const SCORECARD_MARKS = { held: 'HELD', 'held-recent': 'RCNT', faded: 'FADE', reversed: 'REV ', 'no-order': 'NONE', untested: 'THIN', thin: 'THIN', unavailable: 'N/A ' };

/**
 * The track-record scorecard as report lines: the summary sentence, then one
 * line per record with its verdict and its ordering before and after the
 * held-out cutoff, so the out-of-sample evidence arrives with every check.
 */
export function formatScorecard(card) {
  if (!card || card.status !== 'calculated') return [`Track records: ${card?.reason ?? 'the scorecard did not load.'}`];
  const score = (value) => (Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value}` : 'n/a');
  const lines = [`Track records (held-out verdicts): ${card.read}`];
  for (const row of card.rows) {
    const detail = row.status === 'calculated'
      ? `before ${score(row.developmentOrdering)}, held out ${score(row.heldOutOrdering)}${row.holdoutFrom ? ` since ${row.holdoutFrom}` : ''}, ${row.horizonDays} days`
      : (row.reason ?? 'no record');
    lines.push(`${SCORECARD_MARKS[row.verdict] ?? '    '}  ${row.name}: ${row.verdictLabel.toLowerCase()} (${detail})`);
  }
  return lines;
}

/** The running app's base URL if it answers its health check, else null. */
export async function findRunningApp(baseUrl, { fetchImpl = globalThis.fetch, timeoutMs = 3_000 } = {}) {
  try {
    const response = await fetchImpl(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const health = await response.json();
    return { baseUrl, commit: health?.build?.shortCommit ?? null };
  } catch {
    return null;
  }
}
