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

/**
 * Names read mid-sentence, so they lowercase - except where the first word is
 * an acronym, which would turn "US yield advantage" into "us yield advantage".
 */
function midSentence(name) {
  const [first = ''] = String(name).split(' ');
  const isAcronym = first.length > 1 && first === first.toUpperCase() && /[A-Z]/.test(first);
  return isAcronym ? name : name.charAt(0).toLowerCase() + name.slice(1);
}

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

  // Name the requirement that actually failed. Stating both as one sentence
  // read as a contradiction whenever only one of them was the problem: "needs
  // 3 readings covering 50% of the weight; 2 available covering 80%" looks
  // like 80% was refused for being under 50%, when the count was the blocker
  // and the coverage was fine.
  const tooFew = scored.length < minimumSignals;
  const tooThin = coverage < minimumCoverage;
  if (tooFew || tooThin) {
    const shortfall = tooFew && tooThin
      ? `only ${scored.length} of the ${signals.length} inputs reported, covering ${Math.round(coverage * 100)}% of the weight - short of both the ${minimumSignals}-reading minimum and the ${Math.round(minimumCoverage * 100)}% coverage floor`
      : tooFew
        ? `${scored.length} of the ${signals.length} inputs reported and a verdict needs at least ${minimumSignals}. The ${scored.length} that did report cover ${Math.round(coverage * 100)}% of the weight, so it is the number of independent readings that is short, not the weight behind them`
        : `the ${scored.length === 1 ? 'single input that reported carries' : `${scored.length} inputs that reported carry`} only ${Math.round(coverage * 100)}% of the weight, against the ${Math.round(minimumCoverage * 100)}% a verdict needs`;
    return {
      version,
      title,
      status: 'unavailable',
      reason: `${shortfall}.${missing.length ? ` Missing: ${missing.map((entry) => entry.name).join(', ')}.` : ''}`,
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
  // How much of the verdict disagrees with it, by weight rather than by count.
  // Counting readings understates a single heavy dissenter: with three signals
  // one of them opposing is a 67% "majority" that still leaves a third of the
  // verdict arguing the other way.
  const dissentWeight = availableWeight > 0
    ? opposing.reduce((total, signal) => total + signal.weight, 0) / availableWeight
    : 0;

  const limits = [];
  if (coverage < 0.75) limits.push(`only ${Math.round(coverage * 100)}% of the evidence reported`);
  if (dissentWeight >= 0.2) limits.push(`${Math.round(dissentWeight * 100)}% of the weight argues the other way`);
  if (agreement < 60) limits.push(`the readings are split ${agreement}/${100 - agreement}`);
  if (spread >= 45) limits.push(`they span ${spread} points`);
  if (margin && margin.points <= 3) limits.push(`the call sits ${margin.points} ${margin.points === 1 ? 'point' : 'points'} from ${margin.becomes}`);
  if (stalest && stalest.ageDays >= 30) limits.push(`${stalest.name} is ${stalest.ageDays} days old`);
  const confidence = limits.length === 0 ? 'high' : limits.length === 1 ? 'moderate' : 'low';
  // "A, and B, and C" reads as a stammer; one "and", before the last item.
  const listed = limits.length <= 1
    ? limits.join('')
    : `${limits.slice(0, -1).join(', ')}${limits.length > 2 ? ',' : ''} and ${limits.at(-1)}`;

  const leadPhrase = callLean === 'flat'
    ? 'the evidence is balanced'
    : `${supporting.slice(0, 2).map((signal) => midSentence(signal.name)).join(' and ')} ${supporting.length === 1 ? 'carries' : 'carry'} it`;
  const againstPhrase = opposing.length
    ? ` against ${opposing.slice(0, 2).map((signal) => midSentence(signal.name)).join(' and ')}`
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
    dissentWeight: Math.round(dissentWeight * 100),
    spread,
    margin,
    supporting: supporting.map(({ pull, ...rest }) => rest),
    opposing: opposing.map(({ pull, ...rest }) => rest),
    missing,
    read: `${call} at ${score}/100${decisive ? `, ${meaning[callLean] ?? 'balanced'} on this scale` : `, only ${Math.abs(score - neutral)} ${Math.abs(score - neutral) === 1 ? 'point' : 'points'} off neutral`}. ${supporting.length ? `${supporting[0].name} is the strongest contributor at ${supporting[0].score}${supporting[0].detail ? ` (${supporting[0].detail})` : ''}.` : ''}${opposing.length ? ` ${opposing[0].name} argues the other way at ${opposing[0].score}${opposing[0].detail ? ` (${opposing[0].detail})` : ''}.` : ' No reading argues the other way.'}${margin ? ` ${withArticle(margin.points).replace(/^a/, 'A').replace(/^an/, 'An')}-point move ${margin.direction} would make this ${margin.becomes}.` : ''}${missing.length ? ` ${missing.length} input${missing.length === 1 ? '' : 's'} did not report: ${missing.map((entry) => entry.name).join(', ')}.` : ''}`,
    methodology: 'The score is a weighted average renormalised by the weight that actually reported, so a missing input cannot pull the verdict toward its own absence. Contributions are ranked by distance from neutral times weight - how much a reading is moving the verdict, not how extreme it is on its own. Confidence is the weakest link rather than an average: thin coverage, split readings, a wide spread, a call near its boundary, or a stale input each hold it back, and the reasons are listed. Readings pointing against the call are always published.',
  };
}

function clampScore(value) {
  return Math.min(100, Math.max(0, value));
}

/**
 * The bitcoin section's conclusion, on a "constructive for bitcoin" axis.
 *
 * Several of the cycle legs are deliberately left out, because their direction
 * depends on a horizon the verdict does not state:
 *
 * - MVRV valuation. A high reading means expensive, which is bearish over a
 *   cycle and bullish over a quarter. Scoring it either way asserts a horizon.
 * - Drawdown from the all-time high. Restrictive to a trend follower, an
 *   opportunity to a contrarian.
 * - Realized volatility. High volatility accompanies both capitulation and
 *   melt-up, so it is not directional on its own.
 *
 * They stay published in their own panels, where a reader supplies the horizon.
 * What is included has a direction that does not flip with the holding period.
 */
export function buildCryptoVerdict({ bitcoin, globalLiquidity, usdStrength } = {}) {
  const published = (model) => (model?.status === 'calculated' ? model : null);
  const technicals = published(bitcoin?.technicals);
  const leverage = published(bitcoin?.leverage);
  const stablecoins = published(bitcoin?.stablecoins);
  const liquidity = published(globalLiquidity);
  const dollar = published(usdStrength);

  const fundingPercentile = Number.isFinite(leverage?.percentile) ? leverage.percentile : null;
  const stablecoinChange = Number.isFinite(stablecoins?.change30dPercent) ? stablecoins.change30dPercent : null;

  return buildVerdict({
    title: 'Bitcoin conditions',
    version: 'crypto-verdict-v1',
    signals: [
      {
        key: 'technicals',
        name: 'Price technicals',
        score: Number.isFinite(technicals?.score) ? technicals.score : null,
        weight: 0.3,
        detail: technicals?.stance ? `${technicals.stance} tape` : null,
        reason: bitcoin?.technicals?.reason ?? 'No usable bitcoin close history',
      },
      {
        // Funding is what leveraged longs pay to stay long. An extreme is
        // crowding, and crowding is fragile, so the axis inverts it.
        key: 'funding',
        name: 'Perpetual funding (inverted)',
        score: fundingPercentile === null ? null : 100 - fundingPercentile,
        weight: 0.18,
        detail: Number.isFinite(leverage?.annualizedPercent) ? `${leverage.annualizedPercent}% annualized, ${fundingPercentile}th percentile` : null,
        reason: bitcoin?.leverage?.reason ?? 'No perpetual funding data',
      },
      {
        // Stablecoin supply is the cash sitting on exchanges. Expanding supply
        // is capital arriving, contracting supply is capital leaving.
        key: 'stablecoins',
        name: 'Stablecoin supply',
        score: stablecoinChange === null ? null : clampScore(50 + (stablecoinChange * 8)),
        weight: 0.15,
        detail: stablecoins?.state ? `${stablecoins.state}, ${stablecoinChange > 0 ? '+' : ''}${stablecoinChange}% over 30 days` : null,
        reason: bitcoin?.stablecoins?.reason ?? 'No stablecoin supply history',
      },
      {
        key: 'globalLiquidity',
        name: 'Global liquidity impulse',
        score: Number.isFinite(liquidity?.score) ? liquidity.score : null,
        weight: 0.2,
        detail: liquidity?.regime ?? null,
        reason: globalLiquidity?.reason ?? 'The global liquidity model did not publish',
      },
      {
        key: 'dollar',
        name: 'Dollar (inverted)',
        score: Number.isFinite(dollar?.score) ? 100 - dollar.score : null,
        weight: 0.17,
        detail: dollar?.regime ? `${dollar.regime} dollar` : null,
        reason: usdStrength?.reason ?? 'The dollar model did not publish',
      },
    ],
    meaning: { high: 'constructive for bitcoin', low: 'a headwind for bitcoin' },
  });
}

/**
 * The FX section's conclusion, on a "firm dollar" axis.
 *
 * Speculative positioning is left out on purpose. A crowded net-long dollar
 * describes support today and fragility tomorrow, so which way it points
 * depends on the horizon - the same reason perpetual funding is inverted
 * rather than counted straight in the bitcoin verdict, and the same reason
 * MVRV valuation is excluded from it. The COT panel publishes it beside this,
 * where the reader supplies the horizon.
 */
export function buildFxVerdict({ usdStrength, usdBreadth, rateDivergence } = {}) {
  const published = (model) => (model?.status === 'calculated' || model?.status === 'provisional' ? model : null);
  const strength = published(usdStrength);
  const divergence = published(rateDivergence);

  return buildVerdict({
    title: 'Dollar conditions',
    version: 'fx-verdict-v1',
    bands: [
      { max: 35, label: 'Soft dollar' },
      { max: 65, label: 'Rangebound dollar' },
      { max: Infinity, label: 'Firm dollar' },
    ],
    signals: [
      {
        key: 'strength',
        name: 'Broad dollar model',
        score: Number.isFinite(strength?.score) ? strength.score : null,
        weight: 0.45,
        detail: strength?.regime ?? null,
        reason: usdStrength?.reason ?? 'The broad-dollar model did not publish',
      },
      {
        // How many crosses agree, rather than how far the index moved: a
        // dollar rising against one currency is a story about that currency.
        key: 'breadth',
        name: 'Cross-rate breadth',
        score: Number.isFinite(usdBreadth?.pct20d) ? usdBreadth.pct20d : null,
        weight: 0.3,
        detail: usdBreadth ? `${usdBreadth.strong20d} of ${usdBreadth.total} crosses over 20 sessions` : null,
        reason: 'No FX cross published 20-session momentum',
      },
      {
        key: 'rateDivergence',
        name: 'US yield advantage',
        score: Number.isFinite(divergence?.score) ? divergence.score : null,
        weight: 0.25,
        detail: divergence?.state ?? null,
        reason: rateDivergence?.reason ?? 'No foreign long rate published a usable spread',
      },
    ],
    meaning: { high: 'a firm dollar', low: 'a soft dollar' },
  });
}

/**
 * The metals section's conclusion, on a "constructive for gold" axis.
 *
 * Real yields are gold's most direct driver and are deliberately *not* added
 * as their own signal: the broad-dollar model already carries a real-yield
 * driver, so counting both would weigh real yields twice under two names. The
 * dollar composite is the more complete of the two and subsumes it.
 *
 * Speculative positioning is excluded for the same reason as in the FX
 * verdict - a crowded net-long is support today and fragility tomorrow.
 */
export function buildMetalsVerdict({ goldTechnical, usdStrength, globalLiquidity } = {}) {
  const dollarScore = Number.isFinite(usdStrength?.score) ? usdStrength.score : null;
  const liquidityScore = Number.isFinite(globalLiquidity?.score) ? globalLiquidity.score : null;

  return buildVerdict({
    title: 'Gold conditions',
    version: 'metals-verdict-v1',
    signals: [
      {
        key: 'technicals',
        name: 'Gold technicals',
        score: Number.isFinite(goldTechnical?.score) ? goldTechnical.score : null,
        weight: 0.5,
        detail: goldTechnical?.regime ?? null,
        reason: 'No usable gold futures close history',
      },
      {
        // Gold is priced in dollars and competes with the real yield a dollar
        // earns, both of which this model already carries.
        key: 'dollar',
        name: 'Dollar (inverted)',
        score: dollarScore === null ? null : 100 - dollarScore,
        weight: 0.3,
        detail: usdStrength?.regime ? `${usdStrength.regime} dollar` : null,
        reason: 'The broad-dollar model did not publish',
      },
      {
        key: 'globalLiquidity',
        name: 'Global liquidity impulse',
        score: liquidityScore,
        weight: 0.2,
        detail: globalLiquidity?.regime ?? null,
        reason: 'The global liquidity model did not publish',
      },
    ],
    meaning: { high: 'constructive for gold', low: 'a headwind for gold' },
  });
}

/**
 * A verdict built from a model that has already done the weighting.
 *
 * Recomputing a section's score from a second, slightly different set of
 * weights produces a second number for the same question. The equity dashboard
 * did exactly that for one commit: its regime panel and its verdict banner
 * drifted up to 8 points apart and landed in different bands about one time in
 * twelve, so the same page could say "Neutral" in one place and "Constructive"
 * in another.
 *
 * Passing the model's own drivers through means the verdict cannot disagree
 * with the panel beneath it: `weightedModel` and `buildVerdict` renormalise by
 * available weight the same way, so the score is identical by construction
 * rather than by coincidence.
 */
export function buildVerdictFromModel(model, { title, version, bands, meaning, details = {}, reasons = {} } = {}) {
  const signals = (model?.drivers ?? []).map((driver) => ({
    key: driver.key,
    name: driver.name,
    score: Number.isFinite(driver.score) ? driver.score : null,
    weight: driver.weight,
    detail: details[driver.key] ?? null,
    reason: reasons[driver.key] ?? driver.source ?? null,
  }));
  return buildVerdict({ title, version, bands, meaning, signals });
}
