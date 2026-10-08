/**
 * Does the Forex page's 20-session "outlook" carry forward?
 *
 * The outlook panel labels each currency by its move against the dollar over
 * the last 20 sessions: more than +0.5% reads "USD weak", less than -0.5%
 * "USD strong", anything between "Range". Calling that an outlook assumes the
 * move continues - currency time-series momentum. This replays the rule on
 * every session of the carry model's spot history, using only closes to that
 * day, and measures each currency's move against the dollar over the next 30
 * and 90 days. One observation per label per session, the average of the
 * currencies carrying it, since they share the dollar leg; the shared
 * evaluator holds out the newest 30%.
 */

import { evaluateTrackRecord } from './trackRecord.js';

export const FX_MOMENTUM_RECORD_VERSION = 'fx-momentum-record-v1';
export const FX_MOMENTUM_STATES = [
  { key: 'usdWeak', label: 'USD weak (currency up 0.5%+)' },
  { key: 'range', label: 'Range' },
  { key: 'usdStrong', label: 'USD strong (currency down 0.5%+)' },
];
const LOOKBACK = 20;
const THRESHOLD = 0.5;
const MEANINGFUL_GAP = 0.25;
const HORIZONS = [{ days: 30, sessions: 21 }, { days: 90, sessions: 63 }];
const MINIMUM_SESSIONS = 750;

/** The outlook panel's label for a 20-session move in percent. */
export function outlookState(changePercent) {
  if (!Number.isFinite(changePercent)) return null;
  return changePercent > THRESHOLD ? 'usdWeak' : changePercent < -THRESHOLD ? 'usdStrong' : 'range';
}

/**
 * @param {Map<string, Array<{date: string, value: number}>>} spots  Dollars per unit of each currency.
 */
export function calculateFxMomentumRecord(spots) {
  const version = FX_MOMENTUM_RECORD_VERSION;
  const series = [...spots.entries()].filter(([, points]) => (points ?? []).length > MINIMUM_SESSIONS).map(([code, points]) => [code, new Map(points.map((point) => [point.date, point.value]))]);
  if (series.length < 3) return { version, status: 'unavailable', reason: `Needs three currencies with ${MINIMUM_SESSIONS} sessions of spot; ${series.length} have them.` };
  const dates = [...series[0][1].keys()].filter((date) => series.every(([, map]) => map.has(date))).sort();
  if (dates.length < MINIMUM_SESSIONS) return { version, status: 'unavailable', reason: `The currencies share ${dates.length} sessions; ${MINIMUM_SESSIONS} are needed.` };

  const observations = [];
  for (let at = LOOKBACK; at < dates.length; at += 1) {
    const labeled = series.map(([code, map]) => ({ code, map, state: outlookState((map.get(dates[at]) / map.get(dates[at - LOOKBACK]) - 1) * 100) }));
    for (const state of FX_MOMENTUM_STATES) {
      const members = labeled.filter((entry) => entry.state === state.key);
      if (!members.length) continue;
      const returns = {};
      for (const horizon of HORIZONS) {
        const end = at + horizon.sessions;
        returns[horizon.days] = end < dates.length
          ? members.reduce((total, entry) => total + (entry.map.get(dates[end]) / entry.map.get(dates[at]) - 1) * 100, 0) / members.length
          : null;
      }
      observations.push({ date: dates[at], label: state.key, returns });
    }
  }
  const record = evaluateTrackRecord({ observations, order: FX_MOMENTUM_STATES, horizons: HORIZONS, stepDays: 365 / 252, stepLabel: 'session' });
  if (record.status !== 'calculated') return { version, ...record };
  const result = {
    version,
    status: 'calculated',
    asOf: dates.at(-1),
    from: dates[0],
    sessions: dates.length,
    currencies: series.map(([code]) => code),
    record: { ...record, readHorizonDays: 30, limits: 'Descriptive, not predictive. Spot moves only, before carry. The currencies share the dollar leg, so a dollar trend moves every label at once; one observation per label per session keeps that from counting several times.' },
  };
  return { ...result, read: describeFxMomentumRecord(result) };
}

function signed(value) {
  return `${value > 0 ? '+' : ''}${value}%`;
}

function describeFxMomentumRecord(result) {
  const horizon = result.record.horizons.find((entry) => entry.days === 30);
  const block = Number.isFinite(horizon.heldOut.ordering) ? 'heldOut' : 'development';
  const cell = (key) => horizon.states.find((state) => state.key === key)?.[block].stats.median;
  const weak = cell('usdWeak');
  const strong = cell('usdStrong');
  const when = block === 'heldOut' ? `Since ${result.record.holdoutFrom}` : `Before ${result.record.holdoutFrom}`;
  if (!Number.isFinite(weak) || !Number.isFinite(strong)) return `${when}, too few independent sessions to compare the outlook’s labels.`;
  // An order can flip on a few hundredths of a point; under a quarter point
  // apart, the two labels were followed by the same thing.
  // A direction is claimed only when both blocks agree on it, as the
  // scorecard requires for "held up"; one block alone can be noise.
  const apart = Math.abs(weak - strong) >= MEANINGFUL_GAP;
  const orderings = [horizon.development.ordering, horizon.heldOut.ordering].filter(Number.isFinite);
  const verdict = apart && orderings.length && orderings.every((value) => value >= 0.6) ? 'the 20-session move tended to carry forward, as the outlook label implies'
    : apart && orderings.length && orderings.every((value) => value <= -0.2) ? 'the 20-session move tended to reverse, against what the outlook label implies'
      : 'the 20-session move carried little consistent information about the next month';
  return `${when}, a currency labeled "USD weak" moved a median ${signed(weak)} against the dollar over the next 30 days and one labeled "USD strong" ${signed(strong)}: ${verdict}. This describes what followed, not what will.`;
}
