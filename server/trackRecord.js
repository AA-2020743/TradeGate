import { median } from './statistics.js';

/**
 * What followed a signal, measured honestly enough to be worth reading.
 *
 * A model that says "deep value" or "stretched" is making an implicit claim
 * about what comes next. This measures that claim: for every week a signal
 * was in a given state, what did the asset do over the following 30, 90 and
 * 180 days - and was that any different from what an ordinary week was
 * followed by?
 *
 * Three disciplines keep it from being the flattering backtest these usually
 * are:
 *
 * - Held out. The most recent block of history is set aside and reported
 *   separately. A pattern that exists only in the earlier block is a pattern
 *   in that block, not a property of the signal.
 * - Against the base rate, not against zero. An asset that rose 80% of all
 *   quarters makes every state look predictive of gains. The edge is a
 *   state's median forward return minus the median for all weeks in the
 *   same period.
 * - Effective sample size. Weekly observations of a 90-day forward return
 *   overlap by eleven weeks in twelve, so 52 of them carry roughly four
 *   independent readings, not 52. Every cell publishes both counts, and a
 *   cell with fewer than four effective observations publishes no statistics
 *   at all.
 *
 * It is descriptive. A state followed by gains in the past is not a forecast
 * of gains, and the read says so.
 */

const MINIMUM_EFFECTIVE = 4;
const SOLID_EFFECTIVE = 10;

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * The forward return from each sampled index, at each horizon. A sample too
 * close to the end of the history for a horizon has no return at that
 * horizon rather than a truncated one.
 */
export function forwardObservations({ dates, values, samples, horizons, asset = null }) {
  return (samples ?? []).flatMap(({ index, label }) => {
    const start = values[index];
    if (!(start > 0) || label === null || label === undefined) return [];
    const returns = {};
    for (const horizon of horizons) {
      const end = values[index + horizon.sessions];
      returns[horizon.days] = end > 0 ? ((end / start) - 1) * 100 : null;
    }
    return [{ date: dates[index], label, asset, returns }];
  });
}

function summarize(list, horizonDays, stepDays) {
  const returns = list.filter(Number.isFinite);
  const n = returns.length;
  const effective = round(n * Math.min(1, stepDays / horizonDays), 1);
  if (effective < MINIMUM_EFFECTIVE) return { n, effective, status: 'insufficient' };
  return {
    n,
    effective,
    status: effective >= SOLID_EFFECTIVE ? 'measured' : 'thin',
    median: round(median(returns)),
    mean: round(returns.reduce((total, value) => total + value, 0) / n),
    hitRate: Math.round((returns.filter((value) => value > 0).length / n) * 100),
  };
}

/**
 * Whether the states line up the way the model assumes: the first state in
 * `order` followed by the best returns, the last by the worst. Measured as
 * pairwise concordance over states with enough evidence, from -1 (exactly
 * reversed) to +1 (exactly as assumed).
 */
function ordering(cells) {
  const usable = cells.filter((cell) => Number.isFinite(cell.stats?.median));
  if (usable.length < 3) return null;
  let agree = 0;
  let total = 0;
  for (let left = 0; left < usable.length; left += 1) {
    for (let right = left + 1; right < usable.length; right += 1) {
      total += 1;
      if (usable[left].stats.median > usable[right].stats.median) agree += 1;
      else if (usable[left].stats.median < usable[right].stats.median) agree -= 1;
    }
  }
  return round(agree / total, 2);
}

export function evaluateTrackRecord({ observations, order, horizons, stepDays = 7, holdoutFraction = 0.3 }) {
  const sorted = [...(observations ?? [])].sort((left, right) => String(left.date).localeCompare(String(right.date)));
  if (sorted.length < 40) {
    return { status: 'unavailable', reason: `Needs 40 dated observations of the signal; ${sorted.length} available.` };
  }
  const cutIndex = Math.floor(sorted.length * (1 - holdoutFraction));
  const holdoutFrom = sorted[cutIndex].date;
  const periods = {
    development: sorted.filter((observation) => observation.date < holdoutFrom),
    heldOut: sorted.filter((observation) => observation.date >= holdoutFrom),
  };

  const results = horizons.map((horizon) => {
    const period = (list) => {
      const all = summarize(list.map((observation) => observation.returns[horizon.days]), horizon.days, stepDays);
      const states = order.map((state) => {
        const stats = summarize(list.filter((observation) => observation.label === state.key).map((observation) => observation.returns[horizon.days]), horizon.days, stepDays);
        return {
          key: state.key,
          label: state.label,
          stats,
          edge: Number.isFinite(stats.median) && Number.isFinite(all.median) ? round(stats.median - all.median) : null,
        };
      });
      return { all, states, ordering: ordering(states) };
    };
    const development = period(periods.development);
    const heldOut = period(periods.heldOut);
    const states = order.map((state, index) => {
      const before = development.states[index];
      const after = heldOut.states[index];
      const consistent = Number.isFinite(before.edge) && Number.isFinite(after.edge) && before.edge !== 0 && Math.sign(before.edge) === Math.sign(after.edge);
      return { key: state.key, label: state.label, development: before, heldOut: after, consistent };
    });
    return {
      days: horizon.days,
      development: { all: development.all, ordering: development.ordering },
      heldOut: { all: heldOut.all, ordering: heldOut.ordering },
      states,
    };
  });

  return {
    status: 'calculated',
    holdoutFrom,
    from: sorted[0].date,
    to: sorted.at(-1).date,
    observations: sorted.length,
    stepDays,
    horizons: results,
    methodology: `Every ${stepDays}-day step is classified by the signal as it stood then, using only data available at that date, and followed forward ${horizons.map((horizon) => horizon.days).join(', ')} days. The newest ${Math.round(holdoutFraction * 100)}% of observations form a held-out block reported separately. Each state is compared with the median for all observations in the same block. Effective sample size discounts overlapping windows (n × step / horizon); fewer than ${MINIMUM_EFFECTIVE} effective observations publish no statistics, fewer than ${SOLID_EFFECTIVE} are marked thin.`,
    limits: 'Descriptive, not predictive: what followed a state in this history is not a forecast of what follows it next. One asset over one decade is one path, and the held-out block is short by construction.',
  };
}

export { MINIMUM_EFFECTIVE, SOLID_EFFECTIVE };
