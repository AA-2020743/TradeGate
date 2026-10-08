/**
 * What bitcoin's cycle phases have been followed by.
 *
 * The Crypto page places bitcoin in one of four phases - capitulation, early
 * recovery, expansion, euphoria - from drawdown, MVRV-Z, the 200-week and
 * 200-day averages, the short-term holders' cost basis, realized volatility,
 * funding and stablecoin supply. The names carry the claim: capitulation is
 * the time to accumulate, euphoria the time to be careful. This replays the
 * live phase model itself every week since the 200-week average exists,
 * rebuilding each leg from data up to that week only, and measures bitcoin's
 * return over the next 90, 180 and 365 days through the shared evaluator.
 *
 * Funding and stablecoin supply have no long history here, so the replay runs
 * without those two legs - each phase still has three or four of its own, but
 * expansion and euphoria lean more on valuation and price than the live read
 * does. Weeks the model calls ambiguous are left out, as the live page leaves
 * them unresolved.
 */

import { calculateBitcoinCyclePhase } from './analytics.js';
import { evaluateTrackRecord } from './trackRecord.js';

export const BITCOIN_CYCLE_RECORD_VERSION = 'bitcoin-cycle-record-v1';
const PHASE_ORDER = [
  { key: 'capitulation', label: 'Capitulation / accumulation' },
  { key: 'recovery', label: 'Early recovery' },
  { key: 'expansion', label: 'Expansion' },
  { key: 'euphoria', label: 'Euphoria / distribution' },
];
const HORIZONS = [{ days: 90 }, { days: 180 }, { days: 365 }];
const STEP_DAYS = 7;
const WEEKS_FOR_LONG_AVERAGE = 200;
const DAY_MS = 86_400_000;

function round(value, digits = 1) {
  return Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
}

function toNumber(value) {
  const number = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(number) ? number : null;
}

function percentileWithin(sortedValues, value) {
  if (!sortedValues.length || !Number.isFinite(value)) return null;
  let below = 0;
  for (const entry of sortedValues) if (entry <= value) below += 1;
  return Math.round((below / sortedValues.length) * 100);
}

/** The latest row of a dated series on or before `date`, by binary search. */
function latestOnOrBefore(rows, date) {
  let low = 0;
  let high = rows.length - 1;
  let found = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (rows[middle].date <= date) { found = rows[middle]; low = middle + 1; } else high = middle - 1;
  }
  return found;
}

/**
 * @param {{ prices: Array<{date: string, value: number}>, mvrv: Array<{d: string, mvrvZscore: number|string}>, sth: Array<{d: string, sthRealizedPrice: number|string}> }} input
 */
export function calculateBitcoinCycleRecord({ prices, mvrv, sth }) {
  const version = BITCOIN_CYCLE_RECORD_VERSION;
  const daily = (prices ?? []).filter((point) => point.value > 0 && point.date).sort((left, right) => left.date.localeCompare(right.date));
  const mvrvRows = (mvrv ?? []).map((row) => ({ date: String(row.d ?? row.date ?? '').slice(0, 10), value: toNumber(row.mvrvZscore ?? row.value) })).filter((row) => row.date && Number.isFinite(row.value)).sort((left, right) => left.date.localeCompare(right.date));
  const sthRows = (sth ?? []).map((row) => ({ date: String(row.d ?? row.date ?? '').slice(0, 10), value: toNumber(row.sthRealizedPrice ?? row.value) })).filter((row) => row.date && row.value > 0).sort((left, right) => left.date.localeCompare(right.date));
  if (daily.length < WEEKS_FOR_LONG_AVERAGE * 7 + 365 || !mvrvRows.length) {
    return { version, status: 'unavailable', reason: `Needs ${WEEKS_FOR_LONG_AVERAGE} weeks of daily closes plus a year to follow, and the MVRV-Z history; ${daily.length} closes and ${mvrvRows.length} MVRV rows available.` };
  }
  const closes = daily.map((point) => point.value);
  const dates = daily.map((point) => point.date);

  // 30-day realized volatility at every day, and the running maximum.
  const vol = closes.map((_value, index) => {
    if (index < 31) return null;
    const returns = [];
    for (let step = index - 29; step <= index; step += 1) returns.push(Math.log(closes[step] / closes[step - 1]));
    const average = returns.reduce((total, value) => total + value, 0) / returns.length;
    return Math.sqrt(returns.reduce((total, value) => total + (value - average) ** 2, 0) / (returns.length - 1)) * Math.sqrt(365) * 100;
  });
  const peaks = [];
  closes.reduce((peak, value) => { const next = Math.max(peak, value); peaks.push(next); return next; }, 0);
  // Weekly closes for the 200-week average: the last close of each 7-day block counted back from each sample.
  const weeklyMean = (index) => {
    let sum = 0;
    for (let week = 0; week < WEEKS_FOR_LONG_AVERAGE; week += 1) sum += closes[index - week * 7];
    return sum / WEEKS_FOR_LONG_AVERAGE;
  };
  const dailyMean = (index) => {
    let sum = 0;
    for (let day = index - 199; day <= index; day += 1) sum += closes[day];
    return sum / 200;
  };

  const first = (WEEKS_FOR_LONG_AVERAGE - 1) * 7;
  const volHistory = [];
  for (let index = 0; index < first; index += 1) if (Number.isFinite(vol[index])) volHistory.push(vol[index]);
  volHistory.sort((left, right) => left - right);
  const insertSorted = (value) => {
    let low = 0;
    let high = volHistory.length;
    while (low < high) { const middle = (low + high) >> 1; if (volHistory[middle] < value) low = middle + 1; else high = middle; }
    volHistory.splice(low, 0, value);
  };

  const observations = [];
  const phaseAt = [];
  let lastIndexed = first - 1;
  for (let index = first; index < closes.length; index += STEP_DAYS) {
    // Volatility percentile against every 30-day window up to this day only.
    for (let fill = lastIndexed + 1; fill <= index; fill += 1) if (Number.isFinite(vol[fill])) insertSorted(vol[fill]);
    lastIndexed = index;
    const date = dates[index];
    const price = closes[index];
    const mvrvRow = latestOnOrBefore(mvrvRows, date);
    const sthRow = latestOnOrBefore(sthRows, date);
    const sma200w = weeklyMean(index);
    const sma200d = dailyMean(index);
    const phase = calculateBitcoinCyclePhase({
      trend: { status: 'calculated', pctVsSma200d: (price / sma200d - 1) * 100, pctVsSma200w: (price / sma200w - 1) * 100 },
      valuation: mvrvRow && Date.parse(date) - Date.parse(mvrvRow.date) <= 14 * DAY_MS ? { status: 'calculated', mvrvZ: mvrvRow.value } : null,
      drawdown: { status: 'calculated', drawdownPct: (price / peaks[index] - 1) * 100 },
      shortTermHolder: sthRow && Date.parse(date) - Date.parse(sthRow.date) <= 14 * DAY_MS ? { status: 'calculated', premiumPercent: (price / sthRow.value - 1) * 100 } : null,
      realizedVolatility: Number.isFinite(vol[index]) ? { status: 'calculated', percentile: percentileWithin(volHistory, vol[index]) } : null,
      leverage: null,
      stablecoins: null,
    });
    const key = phase.leading?.key ?? null;
    phaseAt.push({ date, key, price });
    if (!key) continue;
    const returns = {};
    for (const horizon of HORIZONS) {
      const end = index + horizon.days;
      returns[horizon.days] = end < closes.length ? (closes[end] / price - 1) * 100 : null;
    }
    observations.push({ date, label: key, returns });
  }
  const record = evaluateTrackRecord({ observations, order: PHASE_ORDER, horizons: HORIZONS, stepDays: STEP_DAYS });
  if (record.status !== 'calculated') return { version, ...record };

  // Open on the longest horizon where at least two phases have evidence: a
  // phase's weeks overlap heavily at a year, and bitcoin's history is short.
  const readHorizonDays = [...record.horizons].sort((left, right) => right.days - left.days)
    .find((horizon) => horizon.states.filter((state) => Number.isFinite(state.heldOut.stats.median) || Number.isFinite(state.development.stats.median)).length >= 2)?.days ?? 90;
  const decided = phaseAt.filter((entry) => entry.key);
  const share = (key) => round((decided.filter((entry) => entry.key === key).length / phaseAt.length) * 100, 0);
  const latest = phaseAt.at(-1);
  const result = {
    version,
    status: 'calculated',
    asOf: latest.date,
    asOfSource: 'Latest weekly replay of the cycle phase',
    from: phaseAt[0].date,
    weeks: phaseAt.length,
    ambiguousShare: round(((phaseAt.length - decided.length) / phaseAt.length) * 100, 0),
    timeInPhase: Object.fromEntries(PHASE_ORDER.map((phase) => [phase.key, share(phase.key)])),
    replayedPhase: latest.key,
    record: {
      ...record,
      readHorizonDays,
      limits: 'Descriptive, not predictive. Replayed without the funding and stablecoin legs, which have no long history, and on today’s vintage of the on-chain series. Bitcoin’s replayable history holds two or three cycles, so each phase rests on a handful of episodes however many weeks it spans.',
    },
    history: phaseAt.map((entry) => ({ date: entry.date, phase: entry.key, price: Math.round(entry.price) })),
  };
  return { ...result, read: describeCycleRecord(result) };
}

function signed(value) {
  return `${value > 0 ? '+' : ''}${value}%`;
}

function describeCycleRecord(result) {
  const record = result.record;
  const byLength = [...record.horizons].sort((left, right) => right.days - left.days);
  const pick = (key) => {
    for (const horizon of byLength) {
      const state = horizon.states.find((entry) => entry.key === key);
      for (const block of ['heldOut', 'development']) if (Number.isFinite(state?.[block].stats.median)) return { horizon, block, median: state[block].stats.median };
    }
    return null;
  };
  const parts = [`Replayed weekly since ${result.from.slice(0, 4)}, the phase model was decisive in ${100 - result.ambiguousShare}% of weeks`];
  // Both ends from one horizon and one block, so the comparison is like for like.
  let paired = null;
  for (const horizon of byLength) {
    for (const block of ['heldOut', 'development']) {
      const median = (key) => horizon.states.find((entry) => entry.key === key)?.[block].stats.median;
      if (Number.isFinite(median('capitulation')) && Number.isFinite(median('euphoria'))) { paired = { horizon, block, capitulation: median('capitulation'), euphoria: median('euphoria') }; break; }
    }
    if (paired) break;
  }
  if (paired) {
    const when = paired.block === 'heldOut' ? `in the held-out block since ${record.holdoutFrom}` : `before ${record.holdoutFrom}`;
    parts.push(`${when}, weeks it called capitulation were followed over ${paired.horizon.days} days by a median ${signed(paired.capitulation)} and weeks it called euphoria by ${signed(paired.euphoria)}`);
  } else {
    const capitulation = pick('capitulation');
    const euphoria = pick('euphoria');
    if (capitulation) parts.push(`weeks it called capitulation were followed over ${capitulation.horizon.days} days by a median ${signed(capitulation.median)} (${capitulation.block === 'heldOut' ? 'held out' : `before ${record.holdoutFrom}`}); euphoria has too few independent weeks to compare`);
    else if (euphoria) parts.push(`weeks it called euphoria were followed over ${euphoria.horizon.days} days by a median ${signed(euphoria.median)} (${euphoria.block === 'heldOut' ? 'held out' : `before ${record.holdoutFrom}`}); capitulation has too few independent weeks to compare`);
  }
  const horizon = record.horizons.find((entry) => entry.days === record.readHorizonDays);
  const ordering = horizon?.heldOut.ordering ?? horizon?.development.ordering;
  let order = '';
  if (Number.isFinite(ordering)) {
    const block = Number.isFinite(horizon.heldOut.ordering) ? 'held-out block' : 'development history';
    const at = `Over ${horizon.days} days, across the ${block},`;
    order = ordering >= 0.6 ? ` ${at} the phases ranked in the order their names imply, capitulation best and euphoria worst.`
      : ordering <= -0.2 ? ` ${at} the phases ranked against the order their names imply.`
        : ` ${at} the phases ranked only loosely in the order their names imply.`;
  } else {
    order = ' Too few independent weeks per phase to rank them yet.';
  }
  return `${parts.join('; ')}.${order} This describes what followed, not what will.`;
}
