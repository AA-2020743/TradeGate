import { calculateTechnicalSnapshot } from './analytics.js';
import { evaluateTrackRecord, forwardObservations } from './trackRecord.js';

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

function signed(value) {
  return `${value > 0 ? '+' : ''}${value}%`;
}

/**
 * What followed the regime the asset is in now, at the longest horizon whose
 * held-out cell has evidence, and whether the regimes ranked as the score
 * assumes.
 */
export function describeTechnicalRecord(record, name, regime) {
  if (record?.status !== 'calculated') return { text: null, days: null };
  const byLength = [...record.horizons].sort((left, right) => right.days - left.days);
  const stateIn = (horizon) => horizon.states.find((state) => state.key === regime);
  const horizon = byLength.find((entry) => Number.isFinite(stateIn(entry)?.heldOut.stats.median))
    ?? byLength.find((entry) => Number.isFinite(stateIn(entry)?.development.stats.median))
    ?? byLength.at(-1);
  const state = stateIn(horizon);
  const parts = [];
  const legs = [];
  if (Number.isFinite(state?.development.stats.median)) legs.push(`${signed(state.development.stats.median)} before ${record.holdoutFrom} against ${signed(horizon.development.all.median)} for all weeks`);
  if (Number.isFinite(state?.heldOut.stats.median)) legs.push(`${signed(state.heldOut.stats.median)} since then against ${signed(horizon.heldOut.all.median)}`);
  parts.push(legs.length
    ? `${name} weeks scored ${regime} were followed over ${horizon.days} days by a median ${legs.join(', and ')}`
    : `${name} has spent too few independent weeks scored ${regime} to say what followed`);
  const ordered = horizon.heldOut.ordering ?? horizon.development.ordering;
  const block = Number.isFinite(horizon.heldOut.ordering) ? 'held-out block' : 'development history';
  if (Number.isFinite(ordered)) {
    if (ordered >= 0.6) parts.push(`across the ${block} the regimes ranked as the score assumes, Constructive followed by the best returns and Guarded by the worst`);
    else if (ordered <= -0.2) parts.push(`across the ${block} the regimes did not rank as the score assumes: Guarded weeks were followed by better returns than Constructive ones`);
    else parts.push(`across the ${block} the regimes ranked only loosely in the order the score assumes`);
  }
  const text = parts.join('; ');
  return { text: `${text.charAt(0).toUpperCase()}${text.slice(1)}. This describes what followed, not what will.`, days: horizon.days };
}

export { ORDER as TECHNICAL_REGIMES };
