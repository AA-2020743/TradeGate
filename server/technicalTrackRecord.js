import { calculateTechnicalSnapshot } from './analytics.js';
import { describeCurrentState, evaluateTrackRecord, forwardObservations } from './trackRecord.js';
import { describeComponents, verdictFor } from './scorecard.js';

/**
 * Whether technical-v1's regimes have meant anything.
 *
 * The score is trend and momentum, so its implicit claim is that a
 * Constructive reading precedes better returns than a Guarded one. This
 * re-scores the asset every week from the closes available that week, and
 * measures what followed each regime with the same disciplines as every
 * track record here: a held-out block, comparison with the base rate, and
 * effective sample size.
 *
 * Each weekly score is computed from a fixed trailing window rather than the
 * whole history to date. The live score is computed from whatever history a
 * panel happens to load, and RSI's smoothing and the 200-day average both
 * depend on depth, so a fixed window keeps every historical score comparable
 * with every other - the price is that it can differ by a point or two from
 * a live score computed on more history.
 */

const ORDER = [
  { key: 'Constructive', label: 'Constructive' },
  { key: 'Neutral', label: 'Neutral' },
  { key: 'Guarded', label: 'Guarded' },
];
const HORIZON_DAYS = [30, 90, 180];
// The score's four components at their weights in technical-v1, so each can
// be tested on its own: which part of the score, if any, carries what
// followed. Trend alignment is banded by the regime's own cutoffs; it scores
// 0, 33, 67 or 100 - above none, one, two or all three of its averages - so
// 65 and 35 split it at a majority. The other three are banded against the
// asset's own earlier weeks: momentum rarely crosses the regime's cutoffs,
// and volatility quality is a level that differs more between assets than
// over time, so fixed cutoffs would leave most weeks in one band or sort
// bitcoin from the S&P rather than a calm week from a rough one.
export const TECHNICAL_COMPONENTS = [
  { key: 'trend', label: 'Trend alignment', weight: 40, banding: 'fixed' },
  { key: 'momentum', label: 'Momentum', weight: 35, banding: 'own-history' },
  { key: 'rsi', label: 'RSI', weight: 20, banding: 'own-history' },
  { key: 'volatilityQuality', label: 'Volatility quality', weight: 5, banding: 'own-history' },
];
export const COMPONENT_BANDS = [
  { key: 'high', label: 'High' },
  { key: 'middle', label: 'Middle' },
  { key: 'low', label: 'Low' },
];
// A year of weekly readings before a week is placed against its own past.
const OWN_HISTORY_MINIMUM = 52;

/** The regime's cutoffs applied to one component: 65 and above high, 35 and below low. */
export function componentBand(value) {
  if (!Number.isFinite(value)) return null;
  return value >= 65 ? 'high' : value <= 35 ? 'low' : 'middle';
}

/**
 * Each reading's third within the readings before it - top, middle or bottom
 * - using only earlier weeks, so no label knows the future. Ties count half
 * below and half above, so a component pinned at 0 or 100 for weeks is not
 * pushed to one end by the tie alone.
 */
export function ownHistoryBands(values, minimum = OWN_HISTORY_MINIMUM) {
  const prior = [];
  return values.map((value) => {
    let band = null;
    if (Number.isFinite(value) && prior.length >= minimum) {
      const below = prior.filter((entry) => entry < value).length;
      const equal = prior.filter((entry) => entry === value).length;
      const share = (below + (equal / 2)) / prior.length;
      band = share >= 2 / 3 ? 'high' : share <= 1 / 3 ? 'low' : 'middle';
    }
    if (Number.isFinite(value)) prior.push(value);
    return band;
  });
}

const WINDOW_DAYS = 420;

export function technicalTrackRecord({ points, annualizationDays = 252 }) {
  const usable = (points ?? [])
    .filter((point) => Number.isFinite(point?.value) && point.value > 0 && point?.date)
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));
  if (usable.length < 500) return { status: 'unavailable', reason: `Needs 500 daily closes to score the past and follow it forward; ${usable.length} available.` };

  const spanDays = (Date.parse(usable.at(-1).date) - Date.parse(usable[0].date)) / 86_400_000;
  const perDay = spanDays > 0 ? (usable.length - 1) / spanDays : 1;
  const window = Math.round(WINDOW_DAYS * perDay);
  const step = Math.max(1, Math.round(7 * perDay));
  const series = usable.map((point) => ({ timestamp: `${point.date}T00:00:00.000Z`, value: point.value }));

  const samples = [];
  for (let index = window - 1; index < usable.length; index += step) {
    const snapshot = calculateTechnicalSnapshot(series.slice(index - window + 1, index + 1), { annualizationDays });
    if (snapshot?.regime) samples.push({ index, label: snapshot.regime, components: snapshot.components ?? {} });
  }
  const horizons = HORIZON_DAYS.map((days) => ({ days, sessions: Math.max(1, Math.round(days * perDay)) }));
  const dates = usable.map((point) => point.date);
  const values = usable.map((point) => point.value);
  const observations = forwardObservations({ dates, values, samples, horizons });
  const componentObservations = Object.fromEntries(TECHNICAL_COMPONENTS.map((component) => {
    const readings = samples.map((sample) => sample.components[component.key]);
    const bands = component.banding === 'fixed' ? readings.map(componentBand) : ownHistoryBands(readings);
    return [component.key, forwardObservations({ dates, values, samples: samples.map((sample, at) => ({ index: sample.index, label: bands[at] })), horizons })];
  }));
  const record = evaluateTrackRecord({ observations, order: ORDER, horizons, stepDays: 7 });
  // Today's regime from the same window the history was scored with, so the
  // current state and its record are one measurement.
  const today = calculateTechnicalSnapshot(series.slice(-window), { annualizationDays });
  return { ...record, observations, componentObservations, windowDays: WINDOW_DAYS, current: today ? { regime: today.regime, score: today.score } : null };
}

/** What followed the regime the asset is in now; see describeCurrentState. */
export function describeTechnicalRecord(record, name, regime) {
  return describeCurrentState(record, { name, state: regime, phrase: (state) => `weeks scored ${state}`, subject: 'regimes', best: 'Constructive', worst: 'Guarded' });
}

/**
 * Each component's record with every asset's weeks pooled, and a one-line
 * summary at `days`: its ordering before and after the cutoff, the held-out
 * spread between its high and low bands, and the scorecard's verdict.
 */
export function pooledComponentRecords(observationsByComponent, { days = 90 } = {}) {
  return TECHNICAL_COMPONENTS.map((component) => {
    const observations = observationsByComponent[component.key] ?? [];
    const record = evaluateTrackRecord({ observations, order: COMPONENT_BANDS, horizons: HORIZON_DAYS.map((horizonDays) => ({ days: horizonDays })), stepDays: 7 });
    const horizon = record.status === 'calculated' ? record.horizons.find((entry) => entry.days === days) : null;
    const high = horizon?.states.find((state) => state.key === 'high')?.heldOut.stats.median;
    const low = horizon?.states.find((state) => state.key === 'low')?.heldOut.stats.median;
    return {
      key: component.key,
      label: component.label,
      weight: component.weight,
      summary: horizon ? {
        days,
        developmentOrdering: horizon.development.ordering,
        heldOutOrdering: horizon.heldOut.ordering,
        heldOutSpread: Number.isFinite(high) && Number.isFinite(low) ? Math.round((high - low) * 100) / 100 : null,
        verdict: verdictFor(horizon.development.ordering, horizon.heldOut.ordering),
      } : null,
      record: record.status === 'calculated' ? { ...record, readHorizonDays: days } : record,
    };
  });
}

/** The pooled components' verdicts as one sentence; see describeComponents. */
export function describeTechnicalComponents(components, days = 90) {
  return describeComponents(components, days, { unit: 'weeks' }).trim();
}

export { ORDER as TECHNICAL_REGIMES };
