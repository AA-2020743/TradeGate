import { calculateTechnicalSnapshot } from './analytics.js';
import { describeCurrentState, evaluateTrackRecord, forwardObservations, ownHistoryBands } from './trackRecord.js';
import { componentRecords, describeComponents } from './scorecard.js';

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

/** The regime's cutoffs applied to one component: 65 and above high, 35 and below low. */
export function componentBand(value) {
  if (!Number.isFinite(value)) return null;
  return value >= 65 ? 'high' : value <= 35 ? 'low' : 'middle';
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
 * Each component's record with every asset's weeks pooled; see
 * componentRecords. High is the band the score favors, so the spread is high
 * minus low.
 */
export function pooledComponentRecords(observationsByComponent, { days = 90 } = {}) {
  return componentRecords({ components: TECHNICAL_COMPONENTS, observationsByComponent, order: COMPONENT_BANDS, horizonDays: HORIZON_DAYS, days });
}

/** The pooled components' verdicts as one sentence; see describeComponents. */
export function describeTechnicalComponents(components, days = 90) {
  return describeComponents(components, days, { unit: 'weeks' }).trim();
}

export { ORDER as TECHNICAL_REGIMES, ownHistoryBands };
