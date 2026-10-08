/**
 * Has the screener score picked stocks that went on to beat the index?
 *
 * The score ranks S&P 500 members on 20-session momentum, distance from the
 * 200-day average and calm (low 20-session volatility). This replays it: every
 * month of a five-year history, each member is scored using only the closes
 * available that day, the members are split into fifths by score, and each
 * fifth's average return over the next 30 and 90 days is measured against SPY
 * over the same days.
 *
 * One observation per fifth per date, not one per stock: a hundred stocks in
 * the same month share the same market, and counting them separately would
 * claim a hundred times the evidence there is. The shared evaluator then
 * applies the disciplines every track record here uses - a held-out recent
 * block, each fifth compared with the average of all fifths, effective sample
 * size for overlapping windows, and whether the fifths ranked in the order the
 * score assumes.
 *
 * Survivorship: the universe is today's index membership, so stocks that left
 * the index (often after falling) are missing from every past date. That lifts
 * every fifth's return, and if the removed names would have scored low it
 * flatters the bottom fifth less than it should - the spread between the top
 * and bottom fifths is the cleaner reading, and even it is not clean.
 */

import { calculateScreenerScores } from './analytics.js';
import { evaluateTrackRecord } from './trackRecord.js';
import { describeComponents, verdictFor } from './scorecard.js';

export const SCREENER_TRACK_RECORD_VERSION = 'screener-track-record-v1';
export const SCREENER_FIFTHS = [
  { key: 'q1', label: 'Top fifth' },
  { key: 'q2', label: 'Second fifth' },
  { key: 'q3', label: 'Middle fifth' },
  { key: 'q4', label: 'Fourth fifth' },
  { key: 'q5', label: 'Bottom fifth' },
];
const LOOKBACK = 200;
// The score's three inputs, each ranked so that higher is what the score prefers.
export const SCREENER_COMPONENTS = [
  { key: 'momentum', label: '20-session momentum', weight: 45, value: (row) => row.mom20 },
  { key: 'trend', label: 'Distance above the 200-day average', weight: 35, value: (row) => row.vsSma200 },
  { key: 'calm', label: 'Calm (low 20-session volatility)', weight: 20, value: (row) => (Number.isFinite(row.vol20) ? -row.vol20 : null) },
];
const MINIMUM_MEMBERS = 100;

function round(value, digits = 2) {
  return Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
}

/** A symbol's closes laid on the benchmark's trading days; a missing day is null, never shifted. */
export function alignToAxis(points, axis) {
  const byDate = new Map((points ?? []).map((point) => [point.date, point.value]));
  return axis.map((date) => {
    const value = byDate.get(date);
    return Number.isFinite(value) && value > 0 ? value : null;
  });
}

/** The three score inputs at axis index `at`, from closes up to and including it only. */
export function featuresAt(values, at) {
  const last = values[at];
  const prior = values[at - 20];
  if (!(last > 0) || !(prior > 0)) return null;
  const window = values.slice(at - LOOKBACK + 1, at + 1).filter((value) => value > 0);
  if (window.length < LOOKBACK * 0.95) return null;
  const sma200 = window.reduce((total, value) => total + value, 0) / window.length;
  const returns = [];
  for (let index = at - 19; index <= at; index += 1) {
    if (values[index] > 0 && values[index - 1] > 0) returns.push(values[index] / values[index - 1] - 1);
  }
  if (returns.length < 15) return null;
  const mean = returns.reduce((total, value) => total + value, 0) / returns.length;
  const variance = returns.reduce((total, value) => total + (value - mean) ** 2, 0) / returns.length;
  return {
    mom20: ((last / prior) - 1) * 100,
    vsSma200: ((last / sma200) - 1) * 100,
    vol20: Math.sqrt(variance) * Math.sqrt(252) * 100,
  };
}

/**
 * @param {{ histories: Map<string, Array<{date: string, value: number}>>, benchmark: Array<{date: string, value: number}>, stepSessions?: number, horizons?: Array<{days: number, sessions: number}> }} input
 */
export function calculateScreenerTrackRecord({ histories, benchmark, stepSessions = 21, horizons = [{ days: 30, sessions: 21 }, { days: 90, sessions: 63 }] }) {
  const version = SCREENER_TRACK_RECORD_VERSION;
  const axis = (benchmark ?? []).filter((point) => point?.date && point.value > 0).map((point) => point.date).sort();
  if (axis.length < LOOKBACK + 20 + horizons[0].sessions + stepSessions * 10) {
    return { version, status: 'unavailable', reason: `Needs about two years of benchmark closes to replay the score monthly; ${axis.length} sessions available.` };
  }
  const benchmarkValues = alignToAxis(benchmark, axis);
  const aligned = new Map([...histories].map(([symbol, points]) => [symbol, alignToAxis(points, axis)]));
  const shortest = Math.min(...horizons.map((horizon) => horizon.sessions));
  // The blended score and each of its three inputs, ranked on the same dates:
  // the inputs' records say which part of the score, if any, carries it.
  const rankers = [{ key: 'score', value: (row) => row.score }, ...SCREENER_COMPONENTS.map((component) => ({ key: component.key, value: component.value }))];
  const observationsBy = Object.fromEntries(rankers.map((ranker) => [ranker.key, []]));
  const dates = [];
  for (let at = LOOKBACK + 20; at + shortest < axis.length; at += stepSessions) {
    const rows = [];
    for (const [symbol, values] of aligned) {
      const features = featuresAt(values, at);
      if (features) rows.push({ symbol, ...features });
    }
    if (rows.length < MINIMUM_MEMBERS) continue;
    const scoredRows = calculateScreenerScores(rows);
    const benchmarkReturns = Object.fromEntries(horizons.map((horizon) => {
      const end = at + horizon.sessions;
      return [horizon.days, benchmarkValues[end] > 0 && benchmarkValues[at] > 0 ? benchmarkValues[end] / benchmarkValues[at] - 1 : null];
    }));
    for (const ranker of rankers) {
      const ranked = scoredRows.filter((row) => Number.isFinite(ranker.value(row))).sort((left, right) => ranker.value(right) - ranker.value(left));
      const fifthSize = ranked.length / 5;
      SCREENER_FIFTHS.forEach((fifth, index) => {
        const members = ranked.slice(Math.round(index * fifthSize), Math.round((index + 1) * fifthSize));
        const returns = {};
        for (const horizon of horizons) {
          const end = at + horizon.sessions;
          const benchmarkReturn = benchmarkReturns[horizon.days];
          const excess = members.flatMap((member) => {
            const values = aligned.get(member.symbol);
            return values[end] > 0 && values[at] > 0 && benchmarkReturn !== null ? [(values[end] / values[at] - 1 - benchmarkReturn) * 100] : [];
          });
          // A fifth whose members mostly lack the forward close has no return
          // at this horizon rather than one drawn from a handful of survivors.
          returns[horizon.days] = excess.length >= members.length * 0.8 ? excess.reduce((total, value) => total + value, 0) / excess.length : null;
        }
        observationsBy[ranker.key].push({ date: axis[at], label: fifth.key, returns });
      });
    }
    dates.push(axis[at]);
  }
  const observations = observationsBy.score;
  const stepDays = Math.round(stepSessions * 365 / 252);
  const components = SCREENER_COMPONENTS.map((component) => {
    const componentRecord = evaluateTrackRecord({ observations: observationsBy[component.key], order: SCREENER_FIFTHS, horizons, stepDays });
    const horizon = componentRecord.status === 'calculated' ? componentRecord.horizons.find((entry) => entry.days === horizons.at(-1).days) : null;
    const top = horizon?.states[0];
    const bottom = horizon?.states.at(-1);
    return {
      key: component.key,
      label: component.label,
      weight: component.weight,
      summary: horizon ? {
        days: horizon.days,
        developmentOrdering: horizon.development.ordering,
        heldOutOrdering: horizon.heldOut.ordering,
        heldOutSpread: Number.isFinite(top?.heldOut.stats.median) && Number.isFinite(bottom?.heldOut.stats.median) ? round(top.heldOut.stats.median - bottom.heldOut.stats.median) : null,
        verdict: verdictFor(horizon.development.ordering, horizon.heldOut.ordering),
      } : null,
      record: componentRecord.status === 'calculated' ? { ...componentRecord, readHorizonDays: horizons.at(-1).days } : componentRecord,
    };
  });
  const record = evaluateTrackRecord({ observations, order: SCREENER_FIFTHS, horizons, stepDays });
  if (record.status !== 'calculated') return { version, ...record };
  return {
    version,
    ...record,
    members: aligned.size,
    replayDates: dates.length,
    readHorizonDays: horizons.at(-1).days,
    components,
    read: `${describeScreenerRecord(record)}${describeComponents(components, horizons.at(-1).days, { unit: 'months' })}`,
    limits: 'The universe is today’s index membership, so stocks that left the index - often after falling - are missing from every past date: every fifth’s return is flattered, and the spread between the top and bottom fifths is the cleaner reading. Returns are against SPY, before costs, and equal-weighted within each fifth. A month apart, the 90-day windows overlap, which the effective sample size accounts for.',
    methodology: `${record.methodology} Every member is scored with the screener’s own formula on closes available that day (20-session momentum 45%, distance from the 200-day average 35%, calm 20%, each a cross-sectional rank), split into fifths, and each fifth’s equal-weighted return over the horizon is measured in excess of SPY over the same sessions. One observation per fifth per date.`,
  };
}

function signed(value) {
  return `${value > 0 ? '+' : ''}${value}%`;
}

function describeScreenerRecord(record) {
  const horizon = [...record.horizons].sort((left, right) => right.days - left.days).find((entry) => Number.isFinite(entry.states[0].heldOut.stats.median) && Number.isFinite(entry.states.at(-1).heldOut.stats.median))
    ?? record.horizons.at(-1);
  const top = horizon.states[0];
  const bottom = horizon.states.at(-1);
  const block = Number.isFinite(top.heldOut.stats.median) && Number.isFinite(bottom.heldOut.stats.median) ? 'heldOut' : 'development';
  const topMedian = top[block].stats.median;
  const bottomMedian = bottom[block].stats.median;
  if (!Number.isFinite(topMedian) || !Number.isFinite(bottomMedian)) {
    return 'Too few independent months to compare the top and bottom fifths yet.';
  }
  const spread = round(topMedian - bottomMedian);
  const when = block === 'heldOut' ? `since ${record.holdoutFrom}` : `before ${record.holdoutFrom}`;
  const ordering = horizon[block].ordering;
  // 0.6 is where the shared evaluator starts calling an order "as assumed";
  // short of 0.8 a pair or two of fifths are out of place, which is "mostly".
  const order = !Number.isFinite(ordering) ? '' : ordering >= 0.8 ? '; the five fifths ranked in the order the score assumes' : ordering >= 0.6 ? '; the fifths ranked mostly in the order the score assumes' : ordering <= -0.2 ? '; the fifths ranked against the order the score assumes' : '; the middle fifths were only loosely in order';
  const thin = [top[block].stats.status, bottom[block].stats.status].includes('thin') ? ` (a thin sample: ${Math.min(top[block].stats.effective, bottom[block].stats.effective)} independent observations)` : '';
  return `${when.charAt(0).toUpperCase()}${when.slice(1)}, stocks in the top fifth of the score went on to a median ${signed(topMedian)} against SPY over ${horizon.days} days, the bottom fifth ${signed(bottomMedian)} - a spread of ${signed(spread)}${thin}${order}. This describes what followed, not what will, and today’s index membership flatters every fifth.`;
}
