/**
 * What the VIX term structure has been followed by.
 *
 * The equity risk dashboard labels the ratio of the 30-day VIX to the 3-month
 * VIX3M: below 0.92 is contango, a calm market paying more for distant
 * protection than near; 0.92 to 1 is flat; 1 or more is backwardation, when
 * near-term fear outprices the longer horizon. The label describes the
 * present. This measures what each state was followed by, because the two
 * common readings point opposite ways - "stress, stand aside" and "fear is
 * priced, the bottom is near" - and only the record can say which held.
 *
 * Every session is classified by the ratio as it closed that day and followed
 * forward 30 and 90 days, twice: SPY's return, and SPY's worst peak-to-trough
 * fall inside the window. Both go through the shared track-record evaluator
 * (held-out newest 30%, effective sample size for overlapping windows, each
 * state against the all-days median, and whether the states ranked in order).
 * The order tested is calm first - contango followed by the best outcomes -
 * which is the reading the "stress" label invites.
 */

import { evaluateTrackRecord } from './trackRecord.js';
import { ordinal, percentileRank } from './statistics.js';

export const VIX_TERM_RECORD_VERSION = 'vix-term-record-v1';
export const VIX_FLAT_RATIO = 0.92;
export const VIX_BACKWARDATION_RATIO = 1;
export const VIX_TERM_STATES = [
  { key: 'contango', label: 'Contango (below 0.92)' },
  { key: 'flat', label: 'Flat (0.92 to 1)' },
  // The soft hyphen lets a narrow column break the word as Back-wardation.
  { key: 'backwardation', label: 'Back\u00adwardation (1 or more)' },
];
const HORIZONS = [{ days: 30, sessions: 21 }, { days: 90, sessions: 63 }];
const MINIMUM_SESSIONS = 750;

/** The state label the equity risk dashboard shows for a VIX/VIX3M ratio. */
export function vixTermState(ratio) {
  if (!Number.isFinite(ratio)) return null;
  return ratio >= VIX_BACKWARDATION_RATIO ? 'backwardation' : ratio >= VIX_FLAT_RATIO ? 'flat' : 'contango';
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
}

/**
 * @param {{ vix: Array<{date: string, value: number}>, vix3m: Array<{date: string, value: number}>, spy: Array<{date: string, value: number}> }} input
 */
export function calculateVixTermRecord({ vix, vix3m, spy }) {
  const version = VIX_TERM_RECORD_VERSION;
  const byDate = (points) => new Map((points ?? []).filter((point) => point.value > 0).map((point) => [point.date, point.value]));
  const near = byDate(vix);
  const far = byDate(vix3m);
  const index = byDate(spy);
  const dates = [...index.keys()].filter((date) => near.has(date) && far.has(date)).sort();
  if (dates.length < MINIMUM_SESSIONS) {
    return { version, status: 'unavailable', reason: `VIX, VIX3M and SPY share ${dates.length} sessions; ${MINIMUM_SESSIONS} are needed.` };
  }
  const ratios = dates.map((date) => near.get(date) / far.get(date));
  const states = ratios.map(vixTermState);
  const levels = dates.map((date) => index.get(date));

  const returnObservations = [];
  const drawdownObservations = [];
  for (let at = 0; at < dates.length; at += 1) {
    const returns = {};
    const drawdowns = {};
    for (const horizon of HORIZONS) {
      const end = at + horizon.sessions;
      if (end >= dates.length) { returns[horizon.days] = null; drawdowns[horizon.days] = null; continue; }
      returns[horizon.days] = (levels[end] / levels[at] - 1) * 100;
      let peak = levels[at];
      let worst = 0;
      for (let step = at + 1; step <= end; step += 1) {
        peak = Math.max(peak, levels[step]);
        worst = Math.min(worst, levels[step] / peak - 1);
      }
      drawdowns[horizon.days] = worst * 100;
    }
    returnObservations.push({ date: dates[at], label: states[at], returns });
    drawdownObservations.push({ date: dates[at], label: states[at], returns: drawdowns });
  }
  // One observation per session: a session is about 1.45 calendar days.
  const stepDays = 365 / 252;
  const returnsRecord = evaluateTrackRecord({ observations: returnObservations, order: VIX_TERM_STATES, horizons: HORIZONS, stepDays, stepLabel: 'session' });
  const drawdownRecord = evaluateTrackRecord({ observations: drawdownObservations, order: VIX_TERM_STATES, horizons: HORIZONS, stepDays, stepLabel: 'session' });
  // Open both tables on the horizon the written read is about.
  const readHorizonDays = evidenceFor(returnsRecord, 'backwardation')?.horizon.days ?? 90;

  const last = dates.length - 1;
  let runStart = last;
  while (runStart > 0 && states[runStart - 1] === states[last]) runStart -= 1;
  const share = (key) => round(states.filter((state) => state === key).length / states.length * 100, 1);
  const limits = 'Descriptive, not predictive. Backwardation comes in a handful of sell-off episodes, so its days are many and its independent readings few, and each episode’s path dominates its state. SPY returns are price only, before dividends.';

  const result = {
    version,
    status: 'calculated',
    date: dates[last],
    from: dates[0],
    sessions: dates.length,
    vix: round(near.get(dates[last])),
    vix3m: round(far.get(dates[last])),
    ratio: round(ratios[last]),
    state: states[last],
    stateLabel: VIX_TERM_STATES.find((entry) => entry.key === states[last]).label,
    since: dates[runStart],
    percentile: percentileRank(ratios, ratios[last]),
    timeInState: Object.fromEntries(VIX_TERM_STATES.map((entry) => [entry.key, share(entry.key)])),
    returns: returnsRecord.status === 'calculated' ? { ...returnsRecord, readHorizonDays, limits } : returnsRecord,
    drawdowns: drawdownRecord.status === 'calculated' ? { ...drawdownRecord, readHorizonDays, limits } : drawdownRecord,
  };
  return {
    ...result,
    read: describeVixTermRecord(result),
    methodology: `Daily closes of the CBOE VIX and VIX3M indices and SPY (Yahoo) on the sessions all three share. Each session is labeled by VIX/VIX3M as it closed - contango below ${VIX_FLAT_RATIO}, flat to ${VIX_BACKWARDATION_RATIO}, backwardation at ${VIX_BACKWARDATION_RATIO} or more, the thresholds the risk dashboard uses - and followed forward 30 and 90 days.`,
    limits,
  };
}

function signed(value) {
  return `${value > 0 ? '+' : ''}${value}%`;
}

/** The longest horizon, and the newest block within it, where a state has enough evidence to publish. */
function evidenceFor(record, key) {
  if (record?.status !== 'calculated') return null;
  for (const horizon of [...record.horizons].sort((left, right) => right.days - left.days)) {
    const state = horizon.states.find((entry) => entry.key === key);
    for (const block of ['heldOut', 'development']) {
      if (Number.isFinite(state?.[block].stats.median)) return { horizon, state, block };
    }
  }
  return null;
}

function describeVixTermRecord(result) {
  const verb = { contango: 'calm: distant protection costs more than near', flat: 'flat: near and distant protection cost about the same', backwardation: 'stressed: near-term protection costs more than the next three months' }[result.state];
  const parts = [`VIX at ${result.vix} against ${result.vix3m} for VIX3M puts the ratio at ${result.ratio}, the ${ordinal(result.percentile)} percentile since ${result.from.slice(0, 4)} - ${verb} - and it has read ${result.state} since ${result.since}`];
  let record = '';
  const back = evidenceFor(result.returns, 'backwardation');
  if (back) {
    const { horizon, state, block } = back;
    const when = block === 'heldOut' ? `since ${result.returns.holdoutFrom}` : `before ${result.returns.holdoutFrom}`;
    const median = state[block].stats.median;
    const all = horizon[block].all.median;
    record = ` ${when.charAt(0).toUpperCase()}${when.slice(1)}, sessions in backwardation were followed over ${horizon.days} days by a median ${signed(median)} for SPY against ${signed(all)} for all sessions`;
    const fallHorizon = result.drawdowns.horizons?.find((entry) => entry.days === horizon.days);
    const fall = fallHorizon?.states.find((entry) => entry.key === 'backwardation');
    const fallMedian = fall?.[block].stats.median;
    const fallAll = fallHorizon?.[block].all.median;
    if (Number.isFinite(fallMedian)) record += `, with a median worst fall of ${fallMedian}% against ${fallAll}%`;
    const rougher = Number.isFinite(fallMedian) && Number.isFinite(fallAll) && fallMedian < fallAll;
    record += median > all
      ? `: stress pricing was followed by recovery more often than by further losses${rougher ? ', at the cost of a rougher ride' : ''}.`
      : `: stress pricing was followed by weaker returns than an ordinary session${rougher ? ', and by deeper falls' : ''}.`;
    if (state[block].stats.status === 'thin') record += ` A thin sample: ${state[block].stats.effective} independent readings.`;
  } else {
    record = ' Backwardation has too few independent sessions in this history to say what followed it.';
  }
  return `${parts.join('; ')}.${record}`;
}
