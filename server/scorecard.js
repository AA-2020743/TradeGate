/**
 * Which models have held up out of sample.
 *
 * Every track record here goes through the same evaluator and ends in the
 * same two numbers: how well the model's states ranked in the order it
 * assumes, from -1 (exactly reversed) to +1 (exactly as assumed), on the
 * older development block and on the newest 30% it never shaped. This lines
 * those numbers up across models and says in plain words what each pair
 * means, so the evidence for every model is in one place rather than in a
 * table at the foot of each panel.
 *
 * The thresholds are the evaluator's own: 0.6 is where an order starts to
 * count as "mostly as assumed", and -0.2 or below is an order running the
 * other way. A held-out block too thin to score is reported as untested,
 * never as a pass.
 */

import { evaluateTrackRecord } from './trackRecord.js';

const HOLDS = 0.6;
const REVERSED = -0.2;

export const SCORECARD_VERDICTS = {
  held: 'Held up out of sample',
  'held-recent': 'Ordered only in the held-out block',
  faded: 'Ordered before, only loosely since',
  reversed: 'Ran against its assumed order since',
  'no-order': 'No reliable order in either block',
  untested: 'Held-out block too thin to judge',
  thin: 'Too few independent observations in either block',
  unavailable: 'No track record available',
};

function horizonFor(record, preferredDays) {
  const horizons = record.horizons ?? [];
  const preferred = horizons.find((entry) => entry.days === preferredDays);
  if (preferred && Number.isFinite(preferred.heldOut?.ordering)) return preferred;
  return [...horizons].sort((left, right) => right.days - left.days).find((entry) => Number.isFinite(entry.heldOut?.ordering))
    ?? preferred ?? horizons.at(-1) ?? null;
}

export function verdictFor(development, heldOut) {
  // A record that exists but cannot rank its states in either block is thin,
  // not missing: the model has a record, it just does not say anything yet.
  if (!Number.isFinite(heldOut)) return Number.isFinite(development) ? 'untested' : 'thin';
  if (heldOut <= REVERSED) return 'reversed';
  if (heldOut >= HOLDS) return Number.isFinite(development) && development >= HOLDS ? 'held' : 'held-recent';
  if (Number.isFinite(development) && development >= HOLDS) return 'faded';
  return 'no-order';
}

const COMPONENT_PHRASES = {
  held: () => 'ranked as assumed both before and since the cutoff',
  'held-recent': () => 'ranked as assumed only since the cutoff',
  faded: () => 'ranked as assumed before the cutoff and only loosely since',
  reversed: () => 'ran against its assumed order since the cutoff',
  'no-order': () => 'showed no reliable order',
  untested: (unit) => `has too few independent ${unit} after the cutoff`,
  thin: (unit) => `has too few independent ${unit} to rank`,
  unavailable: () => 'could not be replayed',
};

/**
 * Each input of a composite score run through the evaluator on its own, in
 * the score's assumed order, with a one-line summary at `days`: its ordering
 * before and after the cutoff, the held-out gap between the band the score
 * favors and the band it disfavors, and the scorecard's verdict.
 *
 * @param {{ components: Array<{ key: string, label: string, weight?: number }>, observationsByComponent: Record<string, object[]>, order: Array<{ key: string, label: string }>, horizonDays: number[], days: number, stepDays?: number }} input
 */
export function componentRecords({ components, observationsByComponent, order, horizonDays, days, stepDays = 7 }) {
  return components.map((component) => {
    const observations = observationsByComponent?.[component.key] ?? [];
    const record = evaluateTrackRecord({ observations, order, horizons: horizonDays.map((horizon) => ({ days: horizon })), stepDays });
    const horizon = record.status === 'calculated' ? record.horizons.find((entry) => entry.days === days) : null;
    const favored = horizon?.states.find((state) => state.key === order[0].key)?.heldOut.stats.median;
    const disfavored = horizon?.states.find((state) => state.key === order.at(-1).key)?.heldOut.stats.median;
    return {
      key: component.key,
      label: component.label,
      weight: component.weight ?? null,
      summary: horizon ? {
        days,
        developmentOrdering: horizon.development.ordering,
        heldOutOrdering: horizon.heldOut.ordering,
        heldOutSpread: Number.isFinite(favored) && Number.isFinite(disfavored) ? Math.round((favored - disfavored) * 100) / 100 : null,
        verdict: verdictFor(horizon.development.ordering, horizon.heldOut.ordering),
      } : null,
      record: record.status === 'calculated' ? { ...record, readHorizonDays: days } : record,
    };
  });
}

/**
 * Which of a score's inputs carries it: each input's own verdict at the read
 * horizon, as a sentence to follow the score's own read.
 *
 * @param {Array<{ label: string, record?: object }>} components
 * @param {number} days
 * @param {{ unit?: string }} [options]  What one observation is, for the thin cases.
 */
export function describeComponents(components, days, { unit = 'observations' } = {}) {
  const phrases = components.map((component) => {
    const horizon = component.record?.horizons?.find((entry) => entry.days === days);
    const verdict = component.record?.status === 'calculated' && horizon ? verdictFor(horizon.development.ordering, horizon.heldOut.ordering) : 'unavailable';
    // Mid-sentence, "Momentum" reads "momentum"; an acronym such as RSI stays as it is.
    const label = /^[A-Z][a-z]/.test(component.label) ? `${component.label.charAt(0).toLowerCase()}${component.label.slice(1)}` : component.label;
    return `${label} ${COMPONENT_PHRASES[verdict](unit)}`;
  });
  if (!phrases.length) return '';
  return phrases.length > 1 ? ` Ranked on its own over ${days} days, ${phrases.slice(0, -1).join('; ')}; and ${phrases.at(-1)}.` : ` Ranked on its own over ${days} days, ${phrases[0]}.`;
}

/**
 * @param {object} record  An evaluateTrackRecord result (status, holdoutFrom, horizons).
 * @param {{ preferredDays?: number }} [options]
 */
export function scoreTrackRecord(record, { preferredDays = record?.readHorizonDays ?? 90 } = {}) {
  if (record?.status !== 'calculated') {
    return { status: 'unavailable', verdict: 'unavailable', verdictLabel: SCORECARD_VERDICTS.unavailable, reason: record?.reason ?? 'The model returned no track record.' };
  }
  const horizon = horizonFor(record, preferredDays);
  if (!horizon) return { status: 'unavailable', verdict: 'unavailable', verdictLabel: SCORECARD_VERDICTS.unavailable, reason: 'The record has no horizons.' };
  const development = horizon.development?.ordering ?? null;
  const heldOut = horizon.heldOut?.ordering ?? null;
  const verdict = verdictFor(development, heldOut);
  return {
    status: 'calculated',
    horizonDays: horizon.days,
    holdoutFrom: record.holdoutFrom,
    from: record.from ?? null,
    developmentOrdering: development,
    heldOutOrdering: heldOut,
    heldOutEffective: horizon.heldOut?.all?.effective ?? null,
    verdict,
    verdictLabel: SCORECARD_VERDICTS[verdict],
  };
}

/**
 * @param {Array<{ key: string, name: string, page: string, assumption: string, measure: string, result: PromiseSettledResult<object>, pick: (payload: object) => object }>} entries
 */
export function buildScorecard(entries) {
  const rows = entries.map((entry) => {
    const base = { key: entry.key, name: entry.name, page: entry.page, assumption: entry.assumption, measure: entry.measure };
    if (entry.result.status !== 'fulfilled') {
      // A loader that failed or timed out says so; it is not a model without a record.
      return { ...base, status: 'unavailable', verdict: 'unavailable', verdictLabel: 'Did not load', reason: entry.result.reason?.message ?? 'The model did not load.' };
    }
    return { ...base, ...scoreTrackRecord(entry.pick(entry.result.value)) };
  });
  const counts = Object.fromEntries(Object.keys(SCORECARD_VERDICTS).map((key) => [key, rows.filter((row) => row.verdict === key).length]));
  const judged = rows.filter((row) => !['untested', 'thin', 'unavailable'].includes(row.verdict));
  const describe = () => {
    if (!judged.length) return 'No track record has a held-out block large enough to judge yet.';
    const parts = [`Of ${rows.length} track records, ${judged.length} have a held-out block large enough to judge`];
    parts.push(`${counts.held} ranked as assumed both before and after their cutoff`);
    if (counts['held-recent']) parts.push(`${counts['held-recent']} only after it`);
    if (counts.faded) parts.push(`${counts.faded} ranked as assumed before and only loosely since`);
    if (counts.reversed) parts.push(`${counts.reversed} ran against the order assumed`);
    if (counts['no-order']) parts.push(`${counts['no-order']} showed no reliable order`);
    return `${parts.join('; ')}.`;
  };
  return {
    version: 'scorecard-v1',
    status: rows.some((row) => row.status === 'calculated') ? 'calculated' : 'unavailable',
    rows,
    counts,
    read: describe(),
    methodology: `Each row is the model’s own track record from the shared evaluator, at the horizon its panel reads (or the longest with a held-out score). Ordering runs from -1, the states exactly reversed, to +1, exactly the order the model assumes. Held up means ${HOLDS} or more in both the development block and the held-out newest 30%; ${REVERSED} or less in the held-out block means the order ran the other way.`,
    limits: 'An ordering score says whether the states ranked as assumed, not by how much; the panels give the medians. Held-out blocks are short by construction, and several records share assets and years, so their verdicts are not independent of one another.',
  };
}
