import { calculateTechnicalSnapshot } from './analytics.js';
import { describeCurrentState, evaluateTrackRecord, forwardObservations } from './trackRecord.js';

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
    if (snapshot?.regime) samples.push({ index, label: snapshot.regime });
  }
  const horizons = HORIZON_DAYS.map((days) => ({ days, sessions: Math.max(1, Math.round(days * perDay)) }));
  const observations = forwardObservations({ dates: usable.map((point) => point.date), values: usable.map((point) => point.value), samples, horizons });
  const record = evaluateTrackRecord({ observations, order: ORDER, horizons, stepDays: 7 });
  // Today's regime from the same window the history was scored with, so the
  // current state and its record are one measurement.
  const today = calculateTechnicalSnapshot(series.slice(-window), { annualizationDays });
  return { ...record, observations, windowDays: WINDOW_DAYS, current: today ? { regime: today.regime, score: today.score } : null };
}

/** What followed the regime the asset is in now; see describeCurrentState. */
export function describeTechnicalRecord(record, name, regime) {
  return describeCurrentState(record, { name, state: regime, phrase: (state) => `weeks scored ${state}`, subject: 'regimes', best: 'Constructive', worst: 'Guarded' });
}

export { ORDER as TECHNICAL_REGIMES };
