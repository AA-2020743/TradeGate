import { median } from './statistics.js';

/**
 * Two providers asked for the same closes, and whether they agree.
 *
 * Every model here trusts the price series it is handed. A provider that
 * quietly misses a split, stamps a close on the wrong day, or freezes a
 * symbol produces a series that looks like a market and scores like one. The
 * cross-check puts each primary history beside an independent second source
 * and measures the disagreement, so a bad series is visible before it is
 * believed.
 *
 * Three rules:
 *
 * - A source compared with itself proves nothing. When the primary history
 *   came from the same provider as the shadow - no Twelve Data key, no
 *   database - the check reports "no independent source" rather than a pass.
 * - Daily returns are compared, not only levels. Two series can agree on
 *   today's close while one of them carries a wrong day weeks ago; levels
 *   hide that and returns expose it.
 * - Day stamps differ by convention. CoinGecko stamps a daily bitcoin point
 *   at 00:00 UTC - the previous day's close - while Yahoo stamps the close on
 *   its own date. The check tries a one-day offset each way and uses the
 *   alignment the data supports, and says which it used, rather than flagging
 *   every day as a discrepancy.
 *
 * Disagreement is a review trigger, not proof that either side is wrong:
 * session cutoffs, corporate-action adjustments and venue differences all
 * move closes legitimately.
 */

const THRESHOLDS = {
  latestPercent: 0.5,
  medianReturnPoints: 0.15,
  maxReturnPoints: 1.5,
};
const MINIMUM_OVERLAP = 20;
const DAY_MS = 86_400_000;

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function byDate(points) {
  const map = new Map();
  for (const point of points ?? []) {
    const date = String(point?.date ?? point?.timestamp ?? '').slice(0, 10);
    const value = Number(point?.value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && value > 0) map.set(date, value);
  }
  return map;
}

function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + (days * DAY_MS)).toISOString().slice(0, 10);
}

/** Paired closes on shared dates, with the shadow moved `offset` days. */
function pair(primary, shadow, offset, window) {
  const rows = [];
  for (const [date, value] of primary) {
    const other = shadow.get(shiftDate(date, offset));
    if (Number.isFinite(other)) rows.push({ date, primary: value, shadow: other });
  }
  return rows.sort((left, right) => left.date.localeCompare(right.date)).slice(-(window + 1));
}

function compare(rows) {
  const differences = [];
  for (let index = 1; index < rows.length; index += 1) {
    const a = ((rows[index].primary / rows[index - 1].primary) - 1) * 100;
    const b = ((rows[index].shadow / rows[index - 1].shadow) - 1) * 100;
    differences.push({ date: rows[index].date, points: Math.abs(a - b) });
  }
  const worst = differences.reduce((best, entry) => (!best || entry.points > best.points ? entry : best), null);
  const latest = rows.at(-1);
  return {
    overlap: differences.length,
    latestDate: latest?.date ?? null,
    latestPrimary: latest?.primary ?? null,
    latestShadow: latest?.shadow ?? null,
    latestDifferencePercent: latest ? round(Math.abs((latest.primary / latest.shadow) - 1) * 100) : null,
    medianReturnDifferencePoints: round(median(differences.map((entry) => entry.points))),
    maxReturnDifferencePoints: round(worst?.points),
    worstDate: worst?.date ?? null,
  };
}

export function crossCheckSeries({ symbol, name, primary, shadow, primarySource, shadowSource, allowOffset = false, window = 60 }) {
  const base = { symbol, name, primarySource, shadowSource };
  // "Yahoo (stored)" is still Yahoo: compare the provider, not the label.
  const providerOf = (source) => String(source ?? '').replace(/\s*\(stored\)$/i, '');
  if (!primarySource || !shadowSource || providerOf(primarySource) === providerOf(shadowSource)) {
    return { ...base, status: 'not-independent', reason: `The primary history came from ${primarySource ?? 'an unknown source'}, the same provider as the shadow, so agreement would prove nothing. A Twelve Data key or stored history supplies an independent primary.` };
  }
  const left = byDate(primary);
  const right = byDate(shadow);
  const offsets = allowOffset ? [0, -1, 1] : [0];
  const candidates = offsets
    .map((offset) => ({ offset, rows: pair(left, right, offset, window) }))
    .filter((candidate) => candidate.rows.length > MINIMUM_OVERLAP)
    .map((candidate) => ({ ...candidate, result: compare(candidate.rows) }))
    .sort((a, b) => a.result.medianReturnDifferencePoints - b.result.medianReturnDifferencePoints);
  if (!candidates.length) {
    return { ...base, status: 'unavailable', reason: `Fewer than ${MINIMUM_OVERLAP} shared dates between the two sources.`, primaryPoints: left.size, shadowPoints: right.size };
  }
  const { offset, result } = candidates[0];
  const breaches = [];
  if (result.latestDifferencePercent > THRESHOLDS.latestPercent) breaches.push(`latest closes differ by ${result.latestDifferencePercent}%`);
  if (result.medianReturnDifferencePoints > THRESHOLDS.medianReturnPoints) breaches.push(`daily returns differ by a median ${result.medianReturnDifferencePoints} points`);
  if (result.maxReturnDifferencePoints > THRESHOLDS.maxReturnPoints) breaches.push(`returns differ by ${result.maxReturnDifferencePoints} points on ${result.worstDate}`);
  return {
    ...base,
    status: breaches.length ? 'review' : 'pass',
    ...result,
    offsetDays: offset,
    alignment: offset === 0 ? 'same date' : `shadow ${offset > 0 ? 'one day later' : 'one day earlier'}: the sources stamp their daily close on different days`,
    breaches,
  };
}

export function summarizeCrossChecks(checks) {
  const counted = (status) => checks.filter((check) => check.status === status);
  const review = counted('review');
  const pass = counted('pass');
  const independent = review.length + pass.length;
  return {
    status: independent ? 'calculated' : checks.some((check) => check.status === 'not-independent') ? 'provisional' : 'unavailable',
    passed: pass.map((check) => check.symbol),
    review: review.map((check) => check.symbol),
    notIndependent: counted('not-independent').map((check) => check.symbol),
    unavailable: counted('unavailable').map((check) => check.symbol),
    read: !independent
      ? 'No symbol could be compared against an independent second source.'
      : review.length
        ? `${review.map((check) => check.symbol).join(', ')} ${review.length === 1 ? 'disagrees' : 'disagree'} with the independent source beyond tolerance - ${review[0].breaches[0]}${review.length > 1 ? ', among others' : ''}. Treat ${review.length === 1 ? 'its' : 'their'} model readings with caution until the difference is explained. ${pass.length} other${pass.length === 1 ? '' : 's'} agree.`
        : `All ${pass.length} independently checked ${pass.length === 1 ? 'symbol agrees' : 'symbols agree'} with the second source within tolerance.`,
    thresholds: THRESHOLDS,
    methodology: `Each primary history is aligned with an independent second source on shared dates over the last ${60} sessions. A symbol goes to review when the latest closes differ by more than ${THRESHOLDS.latestPercent}%, the median daily-return difference exceeds ${THRESHOLDS.medianReturnPoints} points, or any single day differs by more than ${THRESHOLDS.maxReturnPoints} points. A difference is a review trigger, not proof of error: session cutoffs, dividend adjustments and venue differences move closes legitimately.`,
  };
}

export { THRESHOLDS as CROSS_CHECK_THRESHOLDS };

/**
 * What a cross-check means for a model built on the primary series.
 *
 * Only an independent comparison can verify or flag a series. A check that
 * could not run - no second source, too little overlap, a shadow that did
 * not answer in time - leaves the series unverified, which is not a pass and
 * not a fault: the model publishes as it would have, saying it is unchecked.
 */
export function dataQualityFor(check) {
  if (!check) return { status: 'unverified', read: 'This symbol is not cross-checked against a second source.' };
  if (check.status === 'pass') {
    return { status: 'verified', against: check.shadowSource, read: `Prices agree with ${check.shadowSource} within tolerance over the last ${check.overlap} sessions.` };
  }
  if (check.status === 'review') {
    return {
      status: 'review',
      against: check.shadowSource,
      breaches: check.breaches,
      read: `${check.primarySource} and ${check.shadowSource} disagree on this series: ${check.breaches.join('; ')}. The reading is built on the ${check.primarySource} series and is provisional until the difference is explained.`,
    };
  }
  return { status: 'unverified', read: check.reason ?? 'The cross-check could not run.' };
}

/**
 * A model on a series under review drops from calculated to provisional and
 * says why; its numbers stay visible. Withholding them would hide a reading
 * that is often right - a difference is a review trigger, not proof of error
 * - while publishing them as calculated would vouch for a series an
 * independent source contradicts.
 */
export function gateOnDataQuality(output, quality) {
  if (!output || typeof output !== 'object') return output;
  if (quality?.status === 'review' && output.status === 'calculated') {
    return { ...output, status: 'provisional', dataQuality: quality, provisionalReason: quality.read };
  }
  return { ...output, dataQuality: quality ?? dataQualityFor(null) };
}
