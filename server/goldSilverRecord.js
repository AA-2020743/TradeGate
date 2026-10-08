/**
 * What the gold/silver ratio's extremes have been followed by.
 *
 * The metals panel labels the ratio by its percentile over the past year:
 * 80th or above reads "gold favored", 20th or below "silver favored". The
 * label describes what has happened. The common trading claim built on it is
 * mean reversion - a stretched ratio is followed by the lagging metal
 * catching up - and the opposite reading, that the leader keeps leading, is
 * just as often argued. This measures which held.
 *
 * Every session is labeled with the panel's own rule, computed only from the
 * year of ratios up to that day, and followed forward 30 and 90 days by
 * silver's return minus gold's: positive when silver outran gold. The order
 * tested is mean reversion - a high ratio followed by the largest silver
 * catch-up, a low one by the smallest - through the shared evaluator
 * (held-out newest 30%, effective sample size, each label against all days).
 */

import { evaluateTrackRecord } from './trackRecord.js';
import { ordinal, percentileRank } from './statistics.js';

export const GOLD_SILVER_RECORD_VERSION = 'gold-silver-record-v1';
export const RATIO_STATES = [
  { key: 'high', label: 'Ratio high: gold favored (80th pct +)' },
  { key: 'middle', label: 'Balanced' },
  { key: 'low', label: 'Ratio low: silver favored (20th pct or less)' },
];
const WINDOW = 252;
const HORIZONS = [{ days: 30, sessions: 21 }, { days: 90, sessions: 63 }];
const MINIMUM_SESSIONS = 1500;

function round(value, digits = 2) {
  return Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
}

/** The panel's label for a ratio's percentile within its trailing year. */
export function ratioState(percentile) {
  if (!Number.isFinite(percentile)) return null;
  return percentile >= 80 ? 'high' : percentile <= 20 ? 'low' : 'middle';
}

/**
 * @param {{ gold: Array<{date: string, value: number}>, silver: Array<{date: string, value: number}> }} input
 */
export function calculateGoldSilverRecord({ gold, silver }) {
  const version = GOLD_SILVER_RECORD_VERSION;
  const byDate = (points) => new Map((points ?? []).filter((point) => point.value > 0).map((point) => [point.date, point.value]));
  const goldBy = byDate(gold);
  const silverBy = byDate(silver);
  const dates = [...goldBy.keys()].filter((date) => silverBy.has(date)).sort();
  if (dates.length < MINIMUM_SESSIONS) {
    return { version, status: 'unavailable', reason: `Gold and silver share ${dates.length} sessions; ${MINIMUM_SESSIONS} are needed.` };
  }
  const ratios = dates.map((date) => goldBy.get(date) / silverBy.get(date));
  const percentiles = ratios.map((ratio, index) => (index + 1 >= WINDOW ? percentileRank(ratios.slice(index + 1 - WINDOW, index + 1), ratio) : null));
  const states = percentiles.map(ratioState);

  const observations = [];
  for (let at = 0; at < dates.length; at += 1) {
    if (!states[at]) continue;
    const returns = {};
    for (const horizon of HORIZONS) {
      const end = at + horizon.sessions;
      returns[horizon.days] = end < dates.length
        ? ((silverBy.get(dates[end]) / silverBy.get(dates[at]) - 1) - (goldBy.get(dates[end]) / goldBy.get(dates[at]) - 1)) * 100
        : null;
    }
    observations.push({ date: dates[at], label: states[at], returns });
  }
  const record = evaluateTrackRecord({ observations, order: RATIO_STATES, horizons: HORIZONS, stepDays: 365 / 252, stepLabel: 'session' });

  const last = dates.length - 1;
  let runStart = last;
  while (runStart > 0 && states[runStart - 1] === states[last]) runStart -= 1;
  const readHorizonDays = (() => {
    if (record.status !== 'calculated') return 90;
    for (const horizon of [...record.horizons].sort((left, right) => right.days - left.days)) {
      const ends = ['high', 'low'].map((key) => horizon.states.find((state) => state.key === key));
      if (ends.every((state) => Number.isFinite(state?.heldOut.stats.median) || Number.isFinite(state?.development.stats.median))) return horizon.days;
    }
    return 30;
  })();
  const result = {
    version,
    status: 'calculated',
    asOf: dates[last],
    asOfSource: 'Latest close gold and silver futures share',
    date: dates[last],
    from: dates[0],
    sessions: dates.length,
    ratio: round(ratios[last], 1),
    yearPercentile: percentiles[last],
    fullPercentile: percentileRank(ratios, ratios[last]),
    state: states[last],
    stateLabel: RATIO_STATES.find((entry) => entry.key === states[last])?.label ?? null,
    since: dates[runStart],
    record: record.status === 'calculated'
      ? { ...record, readHorizonDays, limits: 'Descriptive, not predictive. Front-month futures roll each contract month. A year-long percentile reaches its extremes in runs, so the extreme labels come in a few dozen episodes however many sessions they span.' }
      : record,
  };
  return {
    ...result,
    read: describeGoldSilverRecord(result),
    methodology: `Daily COMEX gold (GC) and silver (SI) front-month closes (Yahoo) since ${result.from.slice(0, 4)}. Each session is labeled by the gold/silver ratio’s percentile within the ${WINDOW} sessions to that day - the metals panel’s rule - and followed forward 30 and 90 days by silver’s return minus gold’s.`,
    limits: result.record.limits ?? '',
  };
}

function describeGoldSilverRecord(result) {
  const parts = [`The ratio is ${result.ratio}, the ${ordinal(result.yearPercentile)} percentile of its past year and the ${ordinal(result.fullPercentile)} since ${result.from.slice(0, 4)}; it has read ${result.state === 'high' ? 'high (gold favored)' : result.state === 'low' ? 'low (silver favored)' : 'balanced'} since ${result.since}`];
  if (result.record.status !== 'calculated') return `${parts[0]}.`;
  const horizon = result.record.horizons.find((entry) => entry.days === result.record.readHorizonDays);
  const cell = (key) => horizon.states.find((state) => state.key === key);
  const block = ['high', 'low'].every((key) => Number.isFinite(cell(key)?.heldOut.stats.median)) ? 'heldOut' : 'development';
  const high = cell('high')?.[block].stats.median;
  const low = cell('low')?.[block].stats.median;
  let record = '';
  if (Number.isFinite(high) && Number.isFinite(low)) {
    const when = block === 'heldOut' ? `Since ${result.record.holdoutFrom}` : `Before ${result.record.holdoutFrom}`;
    record = ` ${when}, sessions with the ratio high were followed over ${horizon.days} days by silver ${high >= 0 ? 'beating' : 'trailing'} gold by a median ${Math.abs(high)} points, and sessions with it low by silver ${low >= 0 ? 'beating' : 'trailing'} gold by ${Math.abs(low)}`;
    if (high > 0 && low < 0) record += ': both extremes reverted, the lagging metal catching up.';
    else if (high < 0 && low > 0) record += ': both extremes persisted, the leading metal staying ahead.';
    else if (high > low) record += ': silver fared better after a high ratio than after a low one - the direction mean reversion expects, without a catch-up at both ends.';
    else record += ': silver fared worse after a high ratio than after a low one - against mean reversion, without persistence at both ends.';
  }
  return `${parts[0]}.${record} This describes what followed, not what will.`;
}

