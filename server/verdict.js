import { mean } from './statistics.js';

/**
 * The one-paragraph conclusion a section is actually trying to deliver.
 *
 * Every workspace already publishes a dozen honest readings and leaves the
 * reader to synthesise them. This does the synthesis explicitly and shows its
 * work: what the call is, how much of the evidence was available to make it,
 * which readings carry it, which ones argue against it, and what would have to
 * change for the call to change.
 *
 * Three rules keep it from becoming the confident-sounding filler these boxes
 * usually are:
 *
 * - Confidence is derived from coverage, agreement and vintage. It is never
 *   asserted, and a thin or divided or stale basis says so.
 * - Dissent is published. A verdict that lists only its supporting evidence is
 *   an advertisement, so the readings pointing the other way are always shown.
 * - The margin is published. A call two points from its boundary and a call
 *   thirty points inside it are different claims and must not read alike.
 */

const DEFAULT_BANDS = [
  { max: 35, label: 'Guarded' },
  { max: 65, label: 'Neutral' },
  { max: Infinity, label: 'Constructive' },
];

/** "an 11-point move", not "a 11-point move". */
function withArticle(count) {
  const leading = String(count);
  const needsAn = leading === '8' || leading === '11' || leading === '18' || leading.startsWith('8');
  return `${needsAn ? 'an' : 'a'} ${count}`;
}

function bandFor(score, bands) {
  return bands.find((band) => score <= band.max) ?? bands.at(-1);
}

/** How far the score can move before the label changes, and to what. */
function marginFor(score, bands) {
  const index = bands.findIndex((band) => score <= band.max);
  const current = bands[index] ?? bands.at(-1);
  const below = bands[index - 1] ?? null;
  const above = bands[index + 1] ?? null;

  const toAbove = Number.isFinite(current.max) ? (current.max - score) + 1 : null;
  const toBelow = below ? score - below.max : null;

  const candidates = [
    ...(toAbove !== null && above ? [{ points: toAbove, direction: 'up', becomes: above.label }] : []),
    ...(toBelow !== null && below ? [{ points: toBelow, direction: 'down', becomes: below.label }] : []),
  ].filter((entry) => Number.isFinite(entry.points) && entry.points >= 0);
  if (!candidates.length) return null;
  return candidates.reduce((nearest, entry) => (entry.points < nearest.points ? entry : nearest));
}

export function buildVerdict({
  title = 'Verdict',
  version = 'verdict-v1',
  signals = [],
  bands = DEFAULT_BANDS,
  minimumCoverage = 0.5,
  minimumSignals = 3,
  neutral = 50,
  meaning = { high: 'supportive', low: 'restrictive' },
} = {}) {
  const scored = signals.filter((signal) => Number.isFinite(signal?.score));
  const totalWeight = signals.reduce((total, signal) => total + (signal?.weight ?? 1), 0);
  const availableWeight = scored.reduce((total, signal) => total + (signal.weight ?? 1), 0);
  const coverage = totalWeight > 0 ? availableWeight / totalWeight : 0;
  const missing = signals
    .filter((signal) => !Number.isFinite(signal?.score))
    .map((signal) => ({ key: signal?.key ?? null, name: signal?.name ?? 'Unnamed input', reason: signal?.reason ?? null }));

  if (scored.length < minimumSignals || coverage < minimumCoverage) {
    return {
      version,
      title,
      status: 'unavailable',
      reason: `A verdict needs ${minimumSignals} readings covering ${Math.round(minimumCoverage * 100)}% of the weight; ${scored.length} available covering ${Math.round(coverage * 100)}%.`,
      coverage: Math.round(coverage * 100),
      score: null,
      call: null,
      headline: null,
      confidence: null,
      confidenceReason: null,
      margin: null,
      read: null,
      supporting: [],
      opposing: [],
      missing,
    };
  }

  // Renormalised by the weight that actually reported, so a missing input
  // cannot drag the score toward its own absence.
  const score = Math.round(scored.reduce((total, signal) => total + (signal.score * (signal.weight ?? 1)), 0) / availableWeight);
  const call = bandFor(score, bands).label;
  const margin = marginFor(score, bands);

  const withLean = scored.map((signal) => ({
    key: signal.key,
    name: signal.name,
    score: signal.score,
    weight: signal.weight ?? 1,
    detail: signal.detail ?? null,
    ageDays: Number.isFinite(signal.ageDays) ? signal.ageDays : null,
    lean: signal.score > neutral ? 'high' : signal.score < neutral ? 'low' : 'flat',
    // Distance from neutral times weight: how much this reading is actually
    // moving the verdict, rather than merely how extreme it is.
    pull: Math.abs(signal.score - neutral) * (signal.weight ?? 1),
  }));

  const callLean = score > neutral ? 'high' : score < neutral ? 'low' : 'flat';
  // Close to neutral, naming a direction oversells it: "Neutral at 55, supportive"
  // reads as a contradiction rather than a nuance.
  const decisive = Math.abs(score - neutral) >= 10;
  const byPull = [...withLean].sort((left, right) => right.pull - left.pull);
  const supporting = byPull.filter((signal) => signal.lean === callLean && signal.lean !== 'flat');
  const opposing = byPull.filter((signal) => signal.lean !== callLean && signal.lean !== 'flat');

  const agreement = withLean.length
    ? Math.round((withLean.filter((signal) => signal.lean === callLean).length / withLean.length) * 100)
    : 0;
  const scores = withLean.map((signal) => signal.score);
  const spread = Math.max(...scores) - Math.min(...scores);
  const dated = withLean.filter((signal) => signal.ageDays !== null);
  const stalest = dated.length ? dated.reduce((worst, signal) => (signal.ageDays > worst.ageDays ? signal : worst)) : null;

  // Confidence is the weakest link, not an average of comforts.
  const limits = [];
  if (coverage < 0.75) limits.push(`only ${Math.round(coverage * 100)}% of the evidence reported`);
  if (agreement < 60) limits.push(`the readings are split ${agreement}/${100 - agreement}`);
  if (spread >= 50) limits.push(`they span ${spread} points`);
  if (margin && margin.points <= 3) limits.push(`the call sits ${margin.points} ${margin.points === 1 ? 'point' : 'points'} from ${margin.becomes}`);
  if (stalest && stalest.ageDays >= 30) limits.push(`${stalest.name} is ${stalest.ageDays} days old`);
  const confidence = limits.length === 0 ? 'high' : limits.length === 1 ? 'moderate' : 'low';
  // "A, and B, and C" reads as a stammer; one "and", before the last item.
  const listed = limits.length <= 1
    ? limits.join('')
    : `${limits.slice(0, -1).join(', ')}${limits.length > 2 ? ',' : ''} and ${limits.at(-1)}`;

  const leadPhrase = callLean === 'flat'
    ? 'the evidence is balanced'
    : `${supporting.slice(0, 2).map((signal) => signal.name.toLowerCase()).join(' and ')} ${supporting.length === 1 ? 'carries' : 'carry'} it`;
  const againstPhrase = opposing.length
    ? ` against ${opposing.slice(0, 2).map((signal) => signal.name.toLowerCase()).join(' and ')}`
    : ', with nothing arguing the other way';

  return {
    version,
    title,
    status: coverage >= 0.75 && !missing.length ? 'calculated' : 'provisional',
    score,
    call,
    meaning: callLean === 'high' ? meaning.high : callLean === 'low' ? meaning.low : 'balanced',
    headline: `${call}: ${leadPhrase}${againstPhrase}.`,
    confidence,
    confidenceReason: limits.length
      ? `Held back because ${listed}.`
      : `The readings that reported broadly agree and the call is not near a boundary${missing.length ? `, though ${missing.length} input${missing.length === 1 ? '' : 's'} did not report` : ''}.`,
    coverage: Math.round(coverage * 100),
    agreement,
    spread,
    margin,
    supporting: supporting.map(({ pull, ...rest }) => rest),
    opposing: opposing.map(({ pull, ...rest }) => rest),
    missing,
    read: `${call} at ${score}/100${decisive ? `, ${meaning[callLean] ?? 'balanced'} on this scale` : `, only ${Math.abs(score - neutral)} ${Math.abs(score - neutral) === 1 ? 'point' : 'points'} off neutral`}. ${supporting.length ? `${supporting[0].name} is the strongest contributor at ${supporting[0].score}${supporting[0].detail ? ` (${supporting[0].detail})` : ''}.` : ''}${opposing.length ? ` ${opposing[0].name} argues the other way at ${opposing[0].score}${opposing[0].detail ? ` (${opposing[0].detail})` : ''}.` : ' No reading argues the other way.'}${margin ? ` ${withArticle(margin.points).replace(/^a/, 'A').replace(/^an/, 'An')}-point move ${margin.direction} would make this ${margin.becomes}.` : ''}${missing.length ? ` ${missing.length} input${missing.length === 1 ? '' : 's'} did not report: ${missing.map((entry) => entry.name).join(', ')}.` : ''}`,
    methodology: 'The score is a weighted average renormalised by the weight that actually reported, so a missing input cannot pull the verdict toward its own absence. Contributions are ranked by distance from neutral times weight - how much a reading is moving the verdict, not how extreme it is on its own. Confidence is the weakest link rather than an average: thin coverage, split readings, a wide spread, a call near its boundary, or a stale input each hold it back, and the reasons are listed. Readings pointing against the call are always published.',
  };
}
