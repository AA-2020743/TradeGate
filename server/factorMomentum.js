/**
 * Does a factor's past year say anything about its next month?
 *
 * Factor momentum is the documented tendency of long-short factors that have
 * done well over the past year to keep doing well, and of those that have
 * done badly to keep lagging. It matters for reading the factor panel: if it
 * holds, a factor's trailing year is a weak signal about the months ahead; if
 * it does not, the trailing year is history and nothing more.
 *
 * At every month-end since the library begins, each of the six factors is
 * labeled by the sign of its compounded return over the twelve months to
 * that date - using only months already complete - and followed over the
 * next one and three months. One observation per label per month, the
 * average of the factors carrying it, because factors in the same month share
 * a market and counting them separately would claim more evidence than there
 * is. The shared evaluator then holds out the newest 30% of months and
 * reports each label against the all-factor median.
 */

import { evaluateTrackRecord } from './trackRecord.js';
import { median } from './statistics.js';

export const FACTOR_MOMENTUM_VERSION = 'factor-momentum-v1';
export const FACTOR_MOMENTUM_STATES = [
  { key: 'positive', label: 'Coming off a positive year' },
  { key: 'negative', label: 'Coming off a negative year' },
];
const LOOKBACK_MONTHS = 12;
const HORIZONS = [{ days: 30, months: 1 }, { days: 90, months: 3 }];
const MINIMUM_MONTHS = 120;

function round(value, digits = 2) {
  return Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
}

function compound(values) {
  return values.reduce((growth, value) => growth * (1 + value), 1) - 1;
}

/** Daily factor rows (decimal returns) compounded into calendar months. */
export function monthlyFactorReturns(rows, keys) {
  const byMonth = new Map();
  for (const row of [...(rows ?? [])].sort((left, right) => left.date.localeCompare(right.date))) {
    const month = row.date.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, Object.fromEntries(keys.map((key) => [key, []])));
    for (const key of keys) if (Number.isFinite(row[key])) byMonth.get(month)[key].push(row[key]);
  }
  return [...byMonth.entries()].map(([month, lists]) => ({ month, ...Object.fromEntries(keys.map((key) => [key, lists[key].length ? compound(lists[key]) : null])) }));
}

/**
 * @param {Array<object>} rows  Daily joined factor rows, as factorReturns uses.
 * @param {Array<{ key: string, name: string }>} factors
 */
export function calculateFactorMomentum(rows, factors) {
  const version = FACTOR_MOMENTUM_VERSION;
  const keys = factors.map((factor) => factor.key).filter((key) => (rows ?? []).some((row) => Number.isFinite(row[key])));
  const months = monthlyFactorReturns(rows, keys);
  if (months.length < MINIMUM_MONTHS + LOOKBACK_MONTHS) {
    return { version, status: 'unavailable', reason: `Needs ${MINIMUM_MONTHS + LOOKBACK_MONTHS} months of factor returns; ${months.length} available.` };
  }
  const trailing = (key, end) => {
    const window = months.slice(end - LOOKBACK_MONTHS + 1, end + 1).map((month) => month[key]);
    return window.length === LOOKBACK_MONTHS && window.every(Number.isFinite) ? compound(window) : null;
  };
  const observations = [];
  const spreads = [];
  for (let end = LOOKBACK_MONTHS - 1; end < months.length; end += 1) {
    const labeled = keys.map((key) => ({ key, past: trailing(key, end) })).filter((entry) => Number.isFinite(entry.past));
    const forwardOf = (key, horizon) => {
      const window = months.slice(end + 1, end + 1 + horizon.months).map((month) => month[key]);
      return window.length === horizon.months && window.every(Number.isFinite) ? compound(window) * 100 : null;
    };
    for (const state of FACTOR_MOMENTUM_STATES) {
      const members = labeled.filter((entry) => (state.key === 'positive' ? entry.past > 0 : entry.past <= 0));
      if (!members.length) continue;
      const returns = Object.fromEntries(HORIZONS.map((horizon) => {
        const values = members.map((entry) => forwardOf(entry.key, horizon)).filter(Number.isFinite);
        return [horizon.days, values.length === members.length ? values.reduce((total, value) => total + value, 0) / values.length : null];
      }));
      observations.push({ date: months[end].month, label: state.key, returns });
    }
    const winners = labeled.filter((entry) => entry.past > 0).map((entry) => forwardOf(entry.key, HORIZONS[0]));
    const losers = labeled.filter((entry) => entry.past <= 0).map((entry) => forwardOf(entry.key, HORIZONS[0]));
    if (winners.length && losers.length && winners.every(Number.isFinite) && losers.every(Number.isFinite)) {
      const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;
      spreads.push({ signalMonth: months[end].month, month: months[end + 1].month, value: mean(winners) - mean(losers) });
    }
  }
  const record = evaluateTrackRecord({ observations, order: FACTOR_MOMENTUM_STATES, horizons: HORIZONS, stepDays: 30, stepLabel: 'month-end' });
  if (record.status !== 'calculated') return { version, ...record };

  const last = months.length - 1;
  const current = factors.filter((factor) => keys.includes(factor.key)).map((factor) => {
    const past = trailing(factor.key, last);
    return { key: factor.key, name: factor.name, pastYearPercent: round(Number.isFinite(past) ? past * 100 : null, 1), state: Number.isFinite(past) ? (past > 0 ? 'positive' : 'negative') : null };
  });
  const spreadValues = spreads.map((entry) => entry.value);
  const heldOutSpreads = spreads.filter((entry) => entry.signalMonth >= record.holdoutFrom).map((entry) => entry.value);
  const summary = (values) => (values.length ? { months: values.length, meanMonthly: round(values.reduce((total, value) => total + value, 0) / values.length), medianMonthly: round(median(values)), positiveShare: round(values.filter((value) => value > 0).length / values.length * 100, 0) } : null);
  const result = {
    version,
    status: 'calculated',
    throughMonth: months[last].month,
    current,
    winnersMinusLosers: { all: summary(spreadValues), heldOut: summary(heldOutSpreads) },
    record: {
      ...record,
      readHorizonDays: 30,
      limits: 'Descriptive, not predictive. Six factors make small groups, and a month where every factor sits on one side of zero has no comparison. Academic long-short portfolios before costs; the library publishes weeks late.',
    },
  };
  return { ...result, read: describeFactorMomentum(result) };
}

function signed(value) {
  return `${value > 0 ? '+' : ''}${value}%`;
}

function describeFactorMomentum(result) {
  const winners = result.current.filter((factor) => factor.state === 'positive').map((factor) => factor.name);
  const losers = result.current.filter((factor) => factor.state === 'negative').map((factor) => factor.name);
  const list = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]);
  const parts = [winners.length ? `${list(winners)} ${winners.length === 1 ? 'comes' : 'come'} off a positive year to ${result.throughMonth}${losers.length ? `; ${list(losers)} off a negative one` : ''}` : `Every factor comes off a negative year to ${result.throughMonth}`];
  const horizon = result.record.horizons.find((entry) => entry.days === 30);
  const cell = (key, block) => horizon.states.find((state) => state.key === key)?.[block].stats.median;
  const legs = [];
  if (Number.isFinite(cell('positive', 'development')) && Number.isFinite(cell('negative', 'development'))) {
    legs.push(`before ${result.record.holdoutFrom}, a factor coming off a positive year earned a median ${signed(cell('positive', 'development'))} the next month against ${signed(cell('negative', 'development'))} after a negative one`);
  }
  if (Number.isFinite(cell('positive', 'heldOut')) && Number.isFinite(cell('negative', 'heldOut'))) {
    legs.push(`in the held-out years since, ${signed(cell('positive', 'heldOut'))} against ${signed(cell('negative', 'heldOut'))}`);
  }
  let text = `${parts[0]}.`;
  if (legs.length) text += ` ${legs.join('; ').charAt(0).toUpperCase()}${legs.join('; ').slice(1)}.`;
  const held = result.winnersMinusLosers.heldOut;
  if (held) text += ` Holding the past year’s winners against its losers returned a mean ${signed(held.meanMonthly)} a month in the held-out block, positive in ${held.positiveShare}% of its ${held.months} months.`;
  return `${text} This describes what followed, not what will.`;
}
