/**
 * The numeric primitives every model shares.
 *
 * These were copied into seven modules. The arithmetic ones were identical, so
 * the duplication was merely noise - but `percentileRank` had drifted into six
 * versions with different behaviour, which meant "percentile" did not mean the
 * same thing on the macro page as on the equity page. One of those versions
 * knew to refuse a degenerate distribution and the rest did not, so a yield
 * spread that had been flat for 600 sessions published a confident "72nd
 * percentile" that was ranking floating-point dust.
 */

const DAY_MS = 86_400_000;

export function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Sample standard deviation. Needs two observations to have any meaning. */
export function standardDeviation(values) {
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(values.reduce((total, value) => total + ((value - average) ** 2), 0) / (values.length - 1));
}

/**
 * Where `value` sits in `values`, as a percentage at or below it.
 *
 * Refuses a distribution with no meaningful spread. Ranking against a series
 * that never moved answers a question the data cannot support: the ordering
 * comes from floating-point noise, and the resulting number reads as a real
 * position in a real range. The threshold is relative to the magnitude of the
 * values so it behaves the same for basis points and for trillions.
 */
export function percentileRank(values, value, { round = true } = {}) {
  const finite = (values ?? []).filter(Number.isFinite);
  if (!finite.length || !Number.isFinite(value)) return null;
  const spread = Math.max(...finite) - Math.min(...finite);
  const scale = Math.max(Math.abs(value), ...finite.map(Math.abs), 1);
  if (spread <= scale * 1e-9) return null;
  const share = (finite.filter((entry) => entry <= value).length / finite.length) * 100;
  return round ? Math.round(share) : share;
}

/** The typical gap between observations, which is a series' real resolution. */
export function medianSpacingDays(points) {
  if (points.length < 3) return null;
  const gaps = points.slice(1).map((point, index) => (new Date(point.date) - new Date(points[index].date)) / DAY_MS);
  const sorted = gaps.filter((gap) => gap > 0).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * "43rd", "22nd", "11th". Kept here because five copies of this existed and
 * one of them had drifted: without the finite guard a null percentile - which
 * a refused rank now legitimately produces - rendered as "nullth", and without
 * Math.abs a negative value rendered as "-3th".
 */
export function ordinal(value) {
  if (!Number.isFinite(value)) return '\u2014';
  const lastTwo = Math.abs(value) % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${value}th`;
  return `${value}${{ 1: 'st', 2: 'nd', 3: 'rd' }[Math.abs(value) % 10] ?? 'th'}`;
}
