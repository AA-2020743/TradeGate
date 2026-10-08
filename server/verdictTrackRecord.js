/**
 * Have the section verdicts meant anything?
 *
 * Each section closes on a verdict - "Constructive for gold", "a headwind for
 * bitcoin" - built from the models beneath it. The verdict says it is a
 * reading of conditions, but a call like that invites a direction, so this
 * measures what each call was followed by.
 *
 * The replay is the live code, not a re-implementation of it. Every week, each
 * macro series is cut off at what had been published by that date - the
 * observation's own date plus the series' usual publication lag, so January's
 * M2 is not read in January - and the same model functions the page runs are
 * called on what is left: US and global liquidity, the dollar model with its
 * rate-divergence leg, the gold technical score on a year of closes, the
 * bitcoin technicals on ten years. Their outputs go through the same verdict
 * builder, and the call is followed forward 30, 90 and 180 days by the asset
 * the verdict is about. The shared evaluator holds out the newest 30%.
 *
 * The series themselves are today's vintage: a figure revised since it was
 * first printed is read as revised. Inputs with no long history - perpetual
 * funding and stablecoin supply in the bitcoin verdict - are left out of the
 * replay, and the verdict builder treats them as missing, exactly as it does
 * live when those feeds fail.
 */

import { calculateGlobalLiquidityModel, calculateTechnicalSnapshot, calculateUsdStrengthModel, calculateUsLiquidityModel, isPublished } from './analytics.js';
import { calculateBitcoinTechnicals } from './bitcoinTechnicals.js';
import { calculateRateDivergence } from './macroRates.js';
import { componentRecords, describeComponents } from './scorecard.js';
import { evaluateTrackRecord, ownHistoryBands } from './trackRecord.js';
import { buildCryptoVerdict, buildMetalsVerdict } from './verdict.js';

export const VERDICT_RECORD_VERSION = 'verdict-record-v1';
const DAY_MS = 86_400_000;
const HORIZON_DAYS = [30, 90, 180];
const READ_DAYS = 90;
// Every two weeks: for 30- to 180-day horizons the independent evidence is
// set by the span, not the step (overlapping windows are counted once), so a
// weekly replay would double the work for almost nothing.
const STEP_DAYS = 14;
// A year of readings before a leg is placed against its own past.
const LEG_HISTORY_MINIMUM = Math.round(365 / STEP_DAYS);
// Six years of each macro series is more than any score the verdicts read
// looks back: the longest are the dollar's 200-day average and the 91-day
// changes. Cutting the rest keeps each replayed week from re-reading decades.
const MACRO_TRAILING_DAYS = 6 * 365;

/**
 * Days between an observation's date and its first publication, by series.
 * Conservative: a lag a little long costs a few days of freshness; one too
 * short reads a number before anyone could have.
 */
export const PUBLICATION_LAG_DAYS = {
  // Monthly, dated the first of the month they cover.
  usM2: 56,
  bojBalanceSheet: 45,
  pbocBalanceSheet: 60,
  germany10y: 45,
  japan10y: 45,
  uk10y: 45,
  // Weekly releases a few days after the week they describe.
  ecbBalanceSheet: 5,
  financialConditions: 5,
};
const DEFAULT_LAG_DAYS = 1;

const LEG_BANDS = [
  { key: 'high', label: 'Top third of its own past' },
  { key: 'middle', label: 'Middle third' },
  { key: 'low', label: 'Bottom third' },
];

export function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + (days * DAY_MS)).toISOString().slice(0, 10);
}

/**
 * Sort each series once and note the day each observation became known, so
 * cutting the list at a date is a binary search rather than a filter.
 */
export function prepareSeriesList(seriesList, lags = PUBLICATION_LAG_DAYS) {
  return (seriesList ?? []).map((item) => {
    const history = [...(item.history ?? [])]
      .filter((point) => point?.date && Number.isFinite(point.value))
      .map((point) => ({ ...point, date: String(point.date).slice(0, 10) }))
      .sort((left, right) => left.date.localeCompare(right.date));
    const lag = lags[item.key] ?? DEFAULT_LAG_DAYS;
    return { item, history, knownFrom: history.map((point) => addDays(point.date, lag)) };
  });
}

function countKnownBy(sortedDates, date) {
  let low = 0;
  let high = sortedDates.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sortedDates[middle] <= date) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Every series as it could have been read on `date`, optionally only its
 * trailing `trailingDays`.
 */
export function seriesListAsOf(prepared, date, { trailingDays = null } = {}) {
  const earliest = trailingDays ? addDays(date, -trailingDays) : null;
  return prepared.map(({ item, history, knownFrom }) => {
    const end = countKnownBy(knownFrom, date);
    const start = earliest ? countKnownBy(history.map((point) => point.date), earliest) : 0;
    const kept = history.slice(Math.min(start, end), end);
    const last = kept.at(-1);
    return { ...item, history: kept, value: last?.value ?? null, date: last?.date ?? null };
  });
}

/** The closes dated after `date` minus `lookbackDays`, through `date` itself. */
export function closesAsOf(points, date, lookbackDays) {
  const dates = points.map((point) => point.date);
  const end = countKnownBy(dates, date);
  const start = countKnownBy(dates, addDays(date, -lookbackDays));
  return points.slice(start, end);
}

/** Percent move from the last close on or before `date` to the last close on or before `date + days`. */
export function forwardReturn(points, date, days) {
  const dates = points.map((point) => point.date);
  const target = addDays(date, days);
  if (!points.length || target > points.at(-1).date) return null;
  const start = points[countKnownBy(dates, date) - 1];
  const end = points[countKnownBy(dates, target) - 1];
  return start && end && start.value > 0 ? ((end.value / start.value) - 1) * 100 : null;
}

export function replayDates(from, to, stepDays = STEP_DAYS) {
  const dates = [];
  for (let date = from; date <= to; date = addDays(date, stepDays)) dates.push(date);
  return dates;
}

/** The macro models every verdict reads, as they stood on `date`. */
export function macroLegsAsOf(prepared, date, { trailingDays = MACRO_TRAILING_DAYS } = {}) {
  const list = seriesListAsOf(prepared, date, { trailingDays });
  const usLiquidity = calculateUsLiquidityModel(list);
  const globalLiquidity = calculateGlobalLiquidityModel(list);
  const usdStrength = calculateUsdStrengthModel(list, isPublished(usLiquidity) ? usLiquidity : null, { rateDivergence: calculateRateDivergence(list) });
  return {
    globalLiquidity: isPublished(globalLiquidity) ? globalLiquidity : null,
    usdStrength: isPublished(usdStrength) ? usdStrength : null,
  };
}

const asTimestamps = (points) => points.map((point) => ({ timestamp: `${point.date}T00:00:00.000Z`, value: point.value }));

/**
 * The verdicts that can be replayed, each as a function of one week's macro
 * legs and the asset's closes to that week.
 */
export const VERDICT_REPLAYS = {
  metals: {
    name: 'Gold verdict',
    asset: 'gold',
    assetLabel: 'gold',
    order: [{ key: 'Constructive', label: 'Constructive' }, { key: 'Neutral', label: 'Neutral' }, { key: 'Guarded', label: 'Guarded' }],
    verdictAt: (legs, closes, date) => buildMetalsVerdict({
      // The metals panel scores a year of front-month closes.
      goldTechnical: calculateTechnicalSnapshot(asTimestamps(closesAsOf(closes, date, 365)), { annualizationDays: 252 }),
      usdStrength: legs.usdStrength,
      globalLiquidity: legs.globalLiquidity,
    }),
    omitted: [],
  },
  crypto: {
    name: 'Bitcoin verdict',
    asset: 'bitcoin',
    assetLabel: 'bitcoin',
    order: [{ key: 'Constructive', label: 'Constructive' }, { key: 'Neutral', label: 'Neutral' }, { key: 'Guarded', label: 'Guarded' }],
    verdictAt: (legs, closes, date) => buildCryptoVerdict({
      // The bitcoin page reads ten years of daily closes; funding and
      // stablecoin supply have no history to replay, so they are absent.
      bitcoin: { technicals: calculateBitcoinTechnicals(closesAsOf(closes, date, 3650).map((point) => ({ date: point.date, value: point.value }))) },
      globalLiquidity: legs.globalLiquidity,
      usdStrength: legs.usdStrength,
    }),
    omitted: ['Perpetual funding (inverted)', 'Stablecoin supply'],
  },
};

/**
 * One section's record from its replayed weekly verdicts.
 *
 * @param {{ key: string, samples: Array<{ date: string, call: string, score: number, signals: Record<string, number|null>, signalNames: Record<string, string> }>, closes: Array<{date: string, value: number}> }} input
 */
export function calculateVerdictRecord({ key, samples, closes }) {
  const replay = VERDICT_REPLAYS[key];
  const version = VERDICT_RECORD_VERSION;
  if (!replay) return { version, key, status: 'unavailable', reason: `No replay is defined for the ${key} verdict.` };
  const observations = samples.map((sample) => ({
    date: sample.date,
    label: sample.call,
    returns: Object.fromEntries(HORIZON_DAYS.map((days) => [days, forwardReturn(closes, sample.date, days)])),
  }));
  const minimum = 2 * LEG_HISTORY_MINIMUM;
  if (observations.length < minimum) {
    return { version, key, name: replay.name, status: 'unavailable', reason: `The verdict could be replayed on ${observations.length} dates; two years of fortnightly readings (${minimum}) are needed.` };
  }
  const record = evaluateTrackRecord({ observations, order: replay.order, horizons: HORIZON_DAYS.map((days) => ({ days })), stepDays: STEP_DAYS });
  if (record.status !== 'calculated') return { version, key, name: replay.name, ...record };
  const readDays = readHorizonFor(record, replay.order);

  // Each leg on its own: its score placed in the top, middle or bottom third
  // of its own earlier weeks. Every leg is oriented so higher is more
  // constructive, which is the order the verdict assumes.
  const legKeys = [...new Set(samples.flatMap((sample) => Object.keys(sample.signals)))];
  const observationsByLeg = Object.fromEntries(legKeys.map((legKey) => {
    const bands = ownHistoryBands(samples.map((sample) => sample.signals[legKey] ?? null), LEG_HISTORY_MINIMUM);
    return [legKey, observations.flatMap((observation, index) => (bands[index] ? [{ ...observation, label: bands[index] }] : []))];
  }));
  const names = Object.assign({}, ...samples.map((sample) => sample.signalNames));
  const weights = Object.assign({}, ...samples.map((sample) => sample.signalWeights ?? {}));
  const legs = componentRecords({
    components: legKeys.map((legKey) => ({ key: legKey, label: names[legKey] ?? legKey, weight: Number.isFinite(weights[legKey]) ? Math.round(weights[legKey] * 100) : null })),
    observationsByComponent: observationsByLeg,
    order: LEG_BANDS,
    horizonDays: HORIZON_DAYS,
    days: readDays,
    stepDays: STEP_DAYS,
  });

  const counts = Object.fromEntries(replay.order.map((state) => [state.key, samples.filter((sample) => sample.call === state.key).length]));
  const result = {
    version,
    key,
    name: replay.name,
    status: 'calculated',
    from: samples[0].date,
    asOf: samples.at(-1).date,
    readings: samples.length,
    stepDays: STEP_DAYS,
    timeInCall: replay.order.map((state) => ({ key: state.key, label: state.label, readings: counts[state.key], sharePercent: Math.round((counts[state.key] / samples.length) * 1000) / 10 })),
    current: { call: samples.at(-1).call, score: samples.at(-1).score, date: samples.at(-1).date },
    omitted: replay.omitted,
    record: { ...record, readHorizonDays: readDays },
    legs,
    legNote: 'Each leg’s score is placed in the top, middle or bottom third of its own earlier readings, after a year of them, and tested in the order the verdict assumes - top third first. The legs share inputs (the dollar runs through both the liquidity and the dollar models), so their verdicts are not independent of one another.',
  };
  return {
    ...result,
    read: `${describeVerdictRecord(result, replay)}${describeComponents(legs, readDays, { unit: 'readings' })}`,
    methodology: `Every ${STEP_DAYS} days from ${result.from}, each macro series is cut off at what had been published by that date (its observation date plus its usual publication lag), trimmed to its trailing six years, and the page’s own model functions are run on what is left; their outputs go through the same verdict builder, and the call is followed forward ${HORIZON_DAYS.join(', ')} days by ${replay.assetLabel}’s return.${replay.omitted.length ? ` ${replay.omitted.join(' and ')} have no long history and are left out, as the builder does live when those feeds fail.` : ''}`,
    limits: 'Descriptive, not predictive. The series are today’s vintage, so revised figures are read as revised. A verdict stays in one call for months at a time, so its readings come in a few dozen runs however many there are, and the effective sample counts overlapping windows once.',
  };
}

function signed(value) {
  return `${value > 0 ? '+' : ''}${value}%`;
}

/**
 * The longest horizon at which both ends of the call - the most and least
 * constructive - have held-out evidence; 90 days when none has.
 */
function readHorizonFor(record, order) {
  const ends = [order[0].key, order.at(-1).key];
  const usable = [...record.horizons].sort((left, right) => right.days - left.days)
    .find((horizon) => ends.every((stateKey) => Number.isFinite(horizon.states.find((state) => state.key === stateKey)?.heldOut.stats.median)));
  return usable?.days ?? READ_DAYS;
}

function describeVerdictRecord(result, replay) {
  const days = result.record.readHorizonDays;
  const horizon = result.record.horizons.find((entry) => entry.days === days);
  const best = replay.order[0].key;
  const worst = replay.order.at(-1).key;
  const cell = (stateKey, block) => horizon.states.find((state) => state.key === stateKey)?.[block].stats.median;
  const block = [best, worst].every((stateKey) => Number.isFinite(cell(stateKey, 'heldOut'))) ? 'heldOut' : 'development';
  const when = block === 'heldOut' ? `Since ${result.record.holdoutFrom}` : `Before ${result.record.holdoutFrom}`;
  const high = cell(best, block);
  const low = cell(worst, block);
  const all = horizon[block].all.median;
  if (!Number.isFinite(high) || !Number.isFinite(low)) {
    return `Replayed every two weeks from ${result.from}, the verdict has spent too few independent readings in both ${best} and ${worst} to compare what followed them.`;
  }
  const ordering = horizon[block].ordering;
  const order = !Number.isFinite(ordering) ? '' : ordering >= 0.6 ? `; the calls ranked in the order the verdict assumes (${ordering > 0 ? '+' : ''}${ordering})` : ordering <= -0.2 ? `; the calls ranked against the order the verdict assumes (${ordering})` : `; the calls were only loosely in order (${ordering > 0 ? '+' : ''}${ordering})`;
  return `${when}, dates the ${replay.assetLabel} verdict called ${best} were followed by a median ${signed(high)} for ${replay.assetLabel} over ${days} days and dates it called ${worst} by ${signed(low)}, against ${signed(all)} for every date${order}. This describes what followed, not what will.`;
}

const yieldToEventLoop = () => new Promise((resolve) => { setImmediate(resolve); });

/**
 * Replay every defined verdict over the dates its inputs allow.
 *
 * Several hundred replayed dates take seconds of computation, so the loop
 * hands the event loop back every few dates: a server answering other
 * requests must not stall while one record is being built.
 *
 * @param {{ seriesList: object[], closes: Record<string, Array<{date: string, value: number}>>, from?: string, to?: string }} input
 */
export async function replayVerdicts({ seriesList, closes, from = null, to = null }) {
  const prepared = prepareSeriesList(seriesList);
  const keys = Object.keys(VERDICT_REPLAYS).filter((key) => (closes[VERDICT_REPLAYS[key].asset] ?? []).length > 260);
  if (!keys.length) return {};
  const sortedCloses = Object.fromEntries(Object.entries(closes).map(([asset, points]) => [asset, [...(points ?? [])].filter((point) => point?.date && point.value > 0).sort((left, right) => left.date.localeCompare(right.date))]));
  // Start a year into the earliest asset history: no verdict can score its
  // technicals on less, and the macro models need their own windows anyway.
  const start = from ?? addDays(keys.map((key) => sortedCloses[VERDICT_REPLAYS[key].asset][0].date).sort()[0], 365);
  const end = to ?? keys.map((key) => sortedCloses[VERDICT_REPLAYS[key].asset].at(-1).date).sort().at(-1);
  const samplesByKey = Object.fromEntries(keys.map((key) => [key, []]));
  const dates = replayDates(start, end);
  for (const [index, date] of dates.entries()) {
    if (index % 8 === 7) await yieldToEventLoop();
    const legs = macroLegsAsOf(prepared, date);
    for (const key of keys) {
      const assetCloses = sortedCloses[VERDICT_REPLAYS[key].asset];
      if (assetCloses[0].date > addDays(date, -365)) continue;
      const verdict = VERDICT_REPLAYS[key].verdictAt(legs, assetCloses, date);
      if (verdict?.status === 'unavailable' || !verdict?.call) continue;
      const signals = verdict.readings ?? [];
      samplesByKey[key].push({
        date,
        call: verdict.call,
        score: verdict.score,
        signals: Object.fromEntries(signals.map((signal) => [signal.key, signal.score])),
        signalNames: Object.fromEntries(signals.map((signal) => [signal.key, signal.name])),
        signalWeights: Object.fromEntries(signals.map((signal) => [signal.key, signal.weight])),
      });
    }
  }
  return Object.fromEntries(keys.map((key) => [key, calculateVerdictRecord({ key, samples: samplesByKey[key], closes: sortedCloses[VERDICT_REPLAYS[key].asset] })]));
}
