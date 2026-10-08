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
