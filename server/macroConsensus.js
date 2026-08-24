import { mean, standardDeviation } from './statistics.js';
import { buildVerdict, buildVerdictFromModel } from './verdict.js';

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * A percentile is uniform by construction and reaches its own extremes often; a
 * driver composite is roughly normal and clusters near fifty. Placing both on
 * one axis untreated let the two percentile-derived readings pin to 0 and 100
 * and dominate the spread, generating contradictions against every other model
 * at once. Percentile signals are compressed to a 20-80 band so they stay
 * directional without being able to out-shout a composite by construction.
 */
const PERCENTILE_GAIN = 0.6;

function fromPercentile(percentile, { invert = true } = {}) {
  if (!Number.isFinite(percentile)) return null;
  const centred = invert ? 50 - percentile : percentile - 50;
  return Math.round(clamp(50 + (centred * PERCENTILE_GAIN)));
}

function published(model) {
  return Boolean(model) && model.status !== 'unavailable';
}

/**
 * Every reading placed on one axis: 0 is maximally risk-negative, 100 maximally
 * risk-positive. Models that do not carry a direction on that axis — the rate
 * path, which is ambiguous by construction, or the liquidity calendar, which is
 * a schedule — are deliberately absent rather than forced onto it.
 */
export function collectMacroSignals(models = {}) {
  const {
    macroRegime, liquidity, globalLiquidity, usdStrength, growthNowcast,
    dataSurprise, yieldCurve, termPremium, reserveScarcity, inflation, regimeHistory,
  } = models;

  const signals = [
    {
      key: 'macroRegime',
      name: 'Macro regime',
      score: published(macroRegime) && Number.isFinite(macroRegime.score) ? macroRegime.score : null,
      detail: macroRegime?.regime ?? null,
      family: 'composite',
    },
    {
      key: 'liquidity',
      name: 'US liquidity impulse',
      score: published(liquidity) && Number.isFinite(liquidity.score) ? liquidity.score : null,
      detail: liquidity?.regime ?? null,
      family: 'liquidity',
    },
    {
      key: 'globalLiquidity',
      name: 'Global liquidity impulse',
      score: published(globalLiquidity) && Number.isFinite(globalLiquidity.score) ? globalLiquidity.score : null,
      detail: globalLiquidity?.regime ?? null,
      family: 'liquidity',
    },
    {
      key: 'growth',
      name: 'Growth nowcast',
      score: published(growthNowcast) && Number.isFinite(growthNowcast.score) ? growthNowcast.score : null,
      detail: growthNowcast?.state ?? null,
      family: 'growth',
    },
    {
      key: 'dataSurprise',
      name: 'Data surprise',
      score: published(dataSurprise) && Number.isFinite(dataSurprise.score) ? dataSurprise.score : null,
      detail: dataSurprise?.state ?? null,
      family: 'growth',
    },
    {
      // An inverted curve is the market pricing a slowdown, so a negative
      // spread maps to the low end of the axis.
      key: 'curve',
      name: 'Yield curve',
      score: (() => {
        if (!published(yieldCurve)) return null;
        const spreads = (yieldCurve.spreads ?? []).filter((spread) => Number.isFinite(spread.spread));
        if (!spreads.length) return null;
        return Math.round(clamp(50 + (mean(spreads.map((spread) => spread.spread)) * 25)));
      })(),
      detail: yieldCurve?.state ?? null,
      family: 'rates',
    },
    {
      // A rising term premium is a headwind: duration is getting more expensive
      // to hold, which tightens conditions without any policy change.
      key: 'termPremium',
      name: 'Term premium',
      score: published(termPremium) ? fromPercentile(termPremium.percentile) : null,
      detail: termPremium?.driver ?? null,
      family: 'rates',
    },
    {
      key: 'reserves',
      name: 'Reserve scarcity',
      score: published(reserveScarcity) ? fromPercentile(reserveScarcity.percentile) : null,
      detail: reserveScarcity?.state ?? null,
      family: 'liquidity',
    },
    {
      // A strong dollar tightens global conditions, so the axis inverts it.
      key: 'dollar',
      name: 'Dollar (inverted)',
      score: published(usdStrength) && Number.isFinite(usdStrength.score) ? 100 - usdStrength.score : null,
      detail: usdStrength?.regime ? `${usdStrength.regime} dollar` : null,
      family: 'dollar',
    },
  ];

  // Cautions are not directions. Market pricing far from realized inflation is
  // a risk at either end, and a regime past its typical length is more likely
  // to turn whichever way it currently points. Scoring them on the risk axis
  // would pin a calm reading at 100 and read as maximally risk-positive, so
  // they are published separately and never averaged into it.
  const cautions = [
    {
      key: 'inflation',
      name: 'Inflation pricing balance',
      score: published(inflation) && Number.isFinite(inflation.gapVsRealized)
        ? Math.round(clamp(100 - (Math.abs(inflation.gapVsRealized) * 40)))
        : null,
      detail: inflation?.state ?? null,
      note: 'Distance between market-priced and realized inflation, in either direction.',
    },
    {
      key: 'regimeDwell',
      name: 'Regime maturity',
      score: (() => {
        if (!published(regimeHistory) || !Number.isFinite(regimeHistory.current?.runDays) || !Number.isFinite(regimeHistory.current?.typicalDwellDays)) return null;
        const ratio = regimeHistory.current.runDays / Math.max(regimeHistory.current.typicalDwellDays, 1);
        return Math.round(clamp(100 - ((ratio - 1) * 50)));
      })(),
      detail: regimeHistory?.current?.regime ?? null,
      note: 'How far the current regime has run against its own typical length.',
    },
  ];

  // Each signal carries the vintage of the model behind it. A reading built on
  // a six-week-old NFCI sitting unmarked beside one built on today's VIX makes
  // the two look equally current, which is the same misrepresentation the
  // regime model's own asOf was corrected for.
  const modelByKey = {
    macroRegime, liquidity, globalLiquidity, growth: growthNowcast, dataSurprise,
    curve: yieldCurve, termPremium, reserves: reserveScarcity, dollar: usdStrength,
    inflation, regimeDwell: regimeHistory,
  };
  const nowMs = Date.now();
  const withVintage = (signal) => {
    const source = modelByKey[signal.key] ?? null;
    // A model that publishes its own oldest binding input is more honest about
    // its age than its headline asOf, so that is preferred where it exists.
    const asOf = source?.vintage?.oldestInput?.date ?? source?.asOf ?? null;
    const ageDays = asOf ? Math.max(0, Math.round((nowMs - new Date(asOf).getTime()) / 86_400_000)) : null;
    return {
      ...signal,
      available: Number.isFinite(signal.score),
      asOf,
      ageDays,
      // Not a data-quality judgement: some of these series are monthly by
      // nature. It marks which readings are describing a different moment.
      lagging: Number.isFinite(ageDays) && ageDays > 21,
    };
  };

  return {
    directional: signals.map((signal) => withVintage({ ...signal, directional: true })),
    cautions: cautions.map((signal) => withVintage({ ...signal, directional: false })),
  };
}

const CONTRADICTION_GAP = 35;

/**
 * Reads every signal on one axis and names the pairs that genuinely disagree.
 * A composite average across contradicting models hides exactly the information
 * that matters, so the spread and the disagreeing pairs are the output — the
 * average is reported alongside them, not instead of them.
 */
export function calculateModelConsensus(models = {}, { gap = CONTRADICTION_GAP } = {}) {
  const version = 'macro-consensus-v1';
  const { directional: signals, cautions } = collectMacroSignals(models);
  const available = signals.filter((signal) => signal.available);
  if (available.length < 3) {
    return {
      version,
      status: 'unavailable',
      reason: `Needs three published macro models to compare; ${available.length} available.`,
      signals,
      cautions,
      contradictions: [],
    };
  }

  const scores = available.map((signal) => signal.score);
  const average = mean(scores);
  const spread = Math.max(...scores) - Math.min(...scores);
  const dispersion = standardDeviation(scores);
  const ranked = [...available].sort((left, right) => right.score - left.score);

  const contradictions = [];
  for (let left = 0; left < available.length; left += 1) {
    for (let right = left + 1; right < available.length; right += 1) {
      const distance = Math.abs(available[left].score - available[right].score);
      // Two readings from the same family disagreeing is a data problem worth
      // seeing; two from different families disagreeing is the ordinary tension
      // between, say, liquidity and growth. Both are surfaced, labelled apart.
      if (distance < gap) continue;
      const higher = available[left].score >= available[right].score ? available[left] : available[right];
      const lower = higher === available[left] ? available[right] : available[left];
      contradictions.push({
        key: `${lower.key}-${higher.key}`,
        distance,
        sameFamily: lower.family === higher.family,
        family: lower.family === higher.family ? lower.family : null,
        higher: { key: higher.key, name: higher.name, score: higher.score, detail: higher.detail },
        lower: { key: lower.key, name: lower.name, score: lower.score, detail: lower.detail },
        read: `${higher.name} reads ${higher.score}/100${higher.detail ? ` (${higher.detail})` : ''} against ${lower.name} at ${lower.score}${lower.detail ? ` (${lower.detail})` : ''} — ${distance} points apart${lower.family === higher.family ? `, and both are ${lower.family} readings, so the disagreement is inside one family rather than between two views of the world` : ''}.`,
      });
    }
  }
  contradictions.sort((left, right) => right.distance - left.distance);

  // Pairs alone are repetitive: one reading sitting far from the rest
  // contradicts every one of them and fills the list with the same model
  // restated. What a reader wants is which model stands apart, so each is
  // measured against the median of the others and reported once.
  const median = (values) => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const outliers = available
    .map((signal) => {
      const others = available.filter((entry) => entry.key !== signal.key).map((entry) => entry.score);
      if (others.length < 2) return null;
      const centre = median(others);
      const distance = signal.score - centre;
      if (Math.abs(distance) < gap) return null;
      return {
        key: signal.key,
        name: signal.name,
        score: signal.score,
        detail: signal.detail,
        family: signal.family,
        medianOfOthers: Math.round(centre),
        distance: Math.round(distance),
        direction: distance > 0 ? 'more risk-positive' : 'more risk-negative',
        read: `${signal.name} reads ${signal.score}/100${signal.detail ? ` (${signal.detail})` : ''}, ${Math.abs(Math.round(distance))} points ${distance > 0 ? 'above' : 'below'} the median of the other ${others.length} models at ${Math.round(centre)}.`,
      };
    })
    .filter(Boolean)
    .sort((left, right) => Math.abs(right.distance) - Math.abs(left.distance));

  const dated = available.filter((signal) => Number.isFinite(signal.ageDays));
  const vintage = dated.length ? {
    oldest: dated.reduce((worst, signal) => (signal.ageDays > worst.ageDays ? signal : worst)),
    freshest: dated.reduce((best, signal) => (signal.ageDays < best.ageDays ? signal : best)),
    laggingCount: dated.filter((signal) => signal.lagging).length,
  } : null;

  const state = spread >= 60 ? 'Models sharply divided'
    : spread >= gap ? 'Models partly divided'
      : 'Models broadly agree';

  return {
    version,
    status: available.length === signals.length ? 'calculated' : 'provisional',
    signals,
    cautions,
    coverage: Math.round((available.length / signals.length) * 100),
    averageScore: Math.round(average),
    spread: Math.round(spread),
    dispersion: round(dispersion, 1),
    mostPositive: { key: ranked[0].key, name: ranked[0].name, score: ranked[0].score },
    mostNegative: { key: ranked.at(-1).key, name: ranked.at(-1).name, score: ranked.at(-1).score },
    contradictions,
    outliers,
    vintage: vintage ? {
      oldest: { key: vintage.oldest.key, name: vintage.oldest.name, asOf: vintage.oldest.asOf, ageDays: vintage.oldest.ageDays },
      freshest: { key: vintage.freshest.key, name: vintage.freshest.name, asOf: vintage.freshest.asOf, ageDays: vintage.freshest.ageDays },
      spreadDays: vintage.oldest.ageDays - vintage.freshest.ageDays,
      laggingCount: vintage.laggingCount,
    } : null,
    sameFamilyContradictions: contradictions.filter((entry) => entry.sameFamily).length,
    state,
    read: `${state}: ${available.length} of ${signals.length} models publish, averaging ${Math.round(average)}/100 across a ${Math.round(spread)}-point spread from ${ranked.at(-1).name} at ${ranked.at(-1).score} to ${ranked[0].name} at ${ranked[0].score}.${vintage?.laggingCount ? ` ${vintage.laggingCount} of them describe a moment more than three weeks old, the oldest being ${vintage.oldest.name} at ${vintage.oldest.ageDays} days.` : ''}${outliers.length ? ` ${outliers.map((entry) => entry.name).join(' and ')} ${outliers.length === 1 ? 'stands' : 'stand'} apart from the rest.` : contradictions.length ? ` ${contradictions.length} ${contradictions.length === 1 ? 'pair disagrees' : 'pairs disagree'} by ${gap} points or more.` : ''}`,
    methodology: `Each model is placed on one axis where 0 is maximally risk-negative and 100 maximally risk-positive; the dollar, term premium and reserve-scarcity readings are inverted onto it because a stronger dollar, a richer term premium and scarcer reserves all tighten conditions. Readings derived from a percentile are compressed to a 20-80 band before joining it, because a percentile is uniform by construction and reaches its extremes far more often than a driver composite does — untreated, those two would pin to 0 and 100 and contradict every other model at once purely from the shape of their own distribution. Models that carry no direction on that axis are absent from it: the rate path is ambiguous by construction and the liquidity calendar is a schedule, while inflation balance and regime maturity are cautions that peak when nothing is wrong and are published separately so a calm reading cannot masquerade as a risk-positive one. The average is published alongside the spread and the disagreeing pairs, never instead of them, because an average across contradicting models hides exactly what is worth knowing. Each signal carries the vintage of the model behind it, preferring that model's own oldest binding input over its headline date, so a reading describing a moment weeks ago is not shown as though it were current — that is a note about which moment a reading describes, not a judgement about the feed, since several of these series are monthly by nature. Every disagreeing pair is published, but a model sitting far from the rest contradicts all of them and would fill that list with itself restated, so each model is also measured once against the median of the others and the ones that stand apart are named.`,
  };
}

/**
 * Which models actually move together, computed from their stored output
 * history. Several composites share inputs — the macro regime carries the
 * liquidity model as a driver — so a high correlation between them is expected
 * and a high one between models that share nothing is the finding.
 */
export function calculateModelCorrelationMatrix(outputsByModel = {}, { minimumObservations = 12 } = {}) {
  const version = 'macro-model-correlation-v1';
  const seriesByModel = Object.entries(outputsByModel).map(([modelId, outputs]) => {
    const points = (outputs ?? [])
      .map((entry) => ({
        date: String(entry?.output?.asOf ?? entry?.effective_at ?? '').slice(0, 10),
        value: Number(entry?.output?.score),
      }))
      .filter((point) => point.date && Number.isFinite(point.value))
      .sort((left, right) => left.date.localeCompare(right.date));
    // One reading per vintage: repeated runs over the same data would otherwise
    // stack identical points and inflate every correlation toward one.
    const deduped = [...new Map(points.map((point) => [point.date, point])).values()];
    return [modelId, deduped];
  }).filter(([, points]) => points.length >= minimumObservations);

  if (seriesByModel.length < 2) {
    return {
      version,
      status: 'unavailable',
      reason: `Needs two models with ${minimumObservations} stored readings each; ${seriesByModel.length} qualify. Model outputs accumulate only once PostgreSQL is configured and ingestion has run.`,
      pairs: [],
      models: seriesByModel.map(([modelId]) => modelId),
    };
  }

  const pairs = [];
  for (let left = 0; left < seriesByModel.length; left += 1) {
    for (let right = left + 1; right < seriesByModel.length; right += 1) {
      const [leftId, leftPoints] = seriesByModel[left];
      const [rightId, rightPoints] = seriesByModel[right];
      const rightByDate = new Map(rightPoints.map((point) => [point.date, point.value]));
      const shared = leftPoints.filter((point) => rightByDate.has(point.date));
      if (shared.length < minimumObservations) {
        pairs.push({ key: `${leftId}|${rightId}`, left: leftId, right: rightId, status: 'unavailable', reason: `Only ${shared.length} shared vintages.` });
        continue;
      }
      const leftValues = shared.map((point) => point.value);
      const rightValues = shared.map((point) => rightByDate.get(point.date));
      const leftMean = mean(leftValues);
      const rightMean = mean(rightValues);
      let covariance = 0;
      let leftVariance = 0;
      let rightVariance = 0;
      leftValues.forEach((value, index) => {
        covariance += (value - leftMean) * (rightValues[index] - rightMean);
        leftVariance += (value - leftMean) ** 2;
        rightVariance += (rightValues[index] - rightMean) ** 2;
      });
      const denominator = Math.sqrt(leftVariance * rightVariance);
      pairs.push({
        key: `${leftId}|${rightId}`,
        left: leftId,
        right: rightId,
        status: denominator > 0 ? 'calculated' : 'unavailable',
        reason: denominator > 0 ? null : 'One of the two scores never moved across the shared vintages.',
        correlation: denominator > 0 ? round(covariance / denominator, 3) : null,
        observations: shared.length,
      });
    }
  }

  const calculated = pairs.filter((pair) => pair.status === 'calculated');
  const redundant = calculated.filter((pair) => Math.abs(pair.correlation) >= 0.9);
  return {
    version,
    status: calculated.length ? 'calculated' : 'unavailable',
    reason: calculated.length ? null : 'No model pair shares enough vintages to correlate.',
    models: seriesByModel.map(([modelId]) => modelId),
    pairs,
    redundantPairs: redundant.map((pair) => pair.key),
    read: calculated.length
      ? `${calculated.length} of ${pairs.length} model pairs could be correlated across their shared vintages${redundant.length ? `; ${redundant.length} move at 0.9 or above, which is near-duplication rather than confirmation` : ', none of them above 0.9'}.`
      : 'No model pair shares enough stored vintages to correlate.',
    methodology: 'Correlation of published scores across the vintages two models share, with one reading kept per vintage so repeated runs over the same data cannot stack identical points and pull every correlation toward one. Several composites share inputs by design — the macro regime carries the liquidity model as a driver — so a high reading between those is expected; a high reading between models that share no input is the finding.',
  };
}

const ALERT_RULES = [
  {
    key: 'curve-uninverted',
    model: 'yieldCurve',
    severity: 'high',
    test: (curve) => (curve.spreads ?? []).some((spread) => spread.unInverted && Number.isFinite(spread.sessionsSinceUnInversion) && spread.sessionsSinceUnInversion <= 20),
    text: (curve) => {
      const spread = (curve.spreads ?? []).find((entry) => entry.unInverted && entry.sessionsSinceUnInversion <= 20);
      return `${spread.name} un-inverted ${spread.sessionsSinceUnInversion} sessions ago after ${spread.trough ? `a trough of ${spread.trough.value}% on ${spread.trough.date}` : 'an inversion'}. The steepening out of an inversion is the nearer signal, not the inversion itself.`;
    },
  },
  {
    key: 'curve-inverted',
    model: 'yieldCurve',
    severity: 'medium',
    test: (curve) => (curve.spreads ?? []).some((spread) => spread.inverted && spread.sessionsInverted <= 20 && spread.sessionsInverted > 0),
    text: (curve) => {
      const spread = (curve.spreads ?? []).find((entry) => entry.inverted && entry.sessionsInverted <= 20);
      return `${spread.name} inverted ${spread.sessionsInverted} sessions ago and now sits at ${spread.spread}%.`;
    },
  },
  {
    key: 'reserves-tightening',
    model: 'reserveScarcity',
    severity: 'high',
    test: (scarcity) => scarcity.state === 'Reserves scarce' || scarcity.daysAboveThreshold >= 5,
    text: (scarcity) => `${scarcity.state}: SOFR is ${scarcity.spreadBasisPoints}bp over the reserve rate, with ${scarcity.daysAboveThreshold} of the last 21 sessions at or above ${scarcity.thresholdBasisPoints}bp.`,
  },
  {
    key: 'rrp-exhaustion',
    model: 'liquidityCalendar',
    severity: 'high',
    test: (calendar) => Number.isFinite(calendar.monthsOfCushion) && calendar.monthsOfCushion <= 6,
    text: (calendar) => `The reverse-repo facility has about ${calendar.monthsOfCushion} months of cushion left at the current drain, after which tightening reaches reserves undiluted.`,
  },
  {
    key: 'quarter-end',
    model: 'liquidityCalendar',
    severity: 'low',
    test: (calendar) => Number.isFinite(calendar.quarterEnd?.daysAway) && calendar.quarterEnd.daysAway <= 10,
    text: (calendar) => `Quarter-end is ${calendar.quarterEnd.daysAway} days away, which reliably pulls cash into the Treasury general account and out of reserves.`,
  },
  {
    key: 'regime-borderline',
    model: 'macroRegime',
    severity: 'medium',
    test: (regime) => regime.proximity?.borderline === true,
    text: (regime) => `The macro regime is ${regime.proximity.nearest.distance} ${regime.proximity.nearest.distance === 1 ? 'point' : 'points'} from ${regime.proximity.nearest.regime} at ${regime.score}/100 — one step from flipping.`,
  },
  {
    key: 'regime-overdue',
    model: 'regimeHistory',
    severity: 'low',
    test: (history) => Number.isFinite(history.current?.runDays) && Number.isFinite(history.current?.typicalDwellDays) && history.current.runDays >= history.current.typicalDwellDays * 1.5,
    text: (history) => `The tape has been in ${history.current.regime} for ${history.current.runDays} days against a ${history.current.typicalDwellDays}-day average for that regime in this history.`,
  },
  {
    key: 'term-premium-repricing',
    model: 'termPremium',
    severity: 'medium',
    test: (premium) => (premium.windows ?? []).some((entry) => entry.driver === 'term premium' && Math.abs(entry.premiumBasisPoints) >= 25),
    text: (premium) => {
      const entry = (premium.windows ?? []).find((window) => window.driver === 'term premium' && Math.abs(window.premiumBasisPoints) >= 25);
      return `The term premium moved ${entry.premiumBasisPoints > 0 ? '+' : ''}${entry.premiumBasisPoints}bp over ${entry.spanDays} days and drove the 10-year, which is a duration-demand repricing rather than a change in the expected path.`;
    },
  },
  {
    key: 'models-divided',
    model: 'consensus',
    severity: 'medium',
    test: (consensus) => consensus.state === 'Models sharply divided',
    text: (consensus) => `${consensus.read} The most divergent pair: ${consensus.contradictions[0]?.read ?? 'none published'}`,
  },
];

/**
 * Turns the time-sensitive readings into alert entries. The regime engine has
 * published an `alertThreshold` since it was written; the curve, the calendar
 * and reserve scarcity are the most time-sensitive models in the section and
 * have had no alerting path at all.
 *
 * A rule fires only from a model that published. Nothing here invents a
 * condition from a model that could not answer.
 */
export function evaluateMacroAlerts(models = {}, { rules = ALERT_RULES, previous = null } = {}) {
  const version = 'macro-alerts-v2';
  const entries = [];
  const skipped = [];
  // The set of conditions that were live at the last evaluation. A condition
  // that is still live is not news: without this the feed fills with the same
  // alert repeated once per ingestion run, and the database's own uniqueness
  // constraint cannot stop it because the timestamp differs each time.
  const previousKeys = new Set(Array.isArray(previous?.entries)
    ? previous.entries.map((entry) => entry.key)
    : Array.isArray(previous) ? previous : []);
  const previouslySkipped = new Set(Array.isArray(previous?.skipped) ? previous.skipped.map((entry) => entry.key) : []);
  for (const rule of rules) {
    const model = models[rule.model];
    if (!published(model)) {
      skipped.push({ key: rule.key, reason: `${rule.model} did not publish.` });
      continue;
    }
    let fired = false;
    try {
      fired = Boolean(rule.test(model));
    } catch {
      // A rule that throws on an unexpected shape is a rule that cannot be
      // trusted to have fired correctly, so it is skipped rather than assumed.
      skipped.push({ key: rule.key, reason: 'The rule could not be evaluated against the published shape.' });
      continue;
    }
    if (!fired) continue;
    entries.push({
      key: rule.key,
      severity: rule.severity,
      model: rule.model,
      text: rule.text(model),
      // New means it crossed into this state since the last evaluation. A
      // condition that could not be evaluated last time is treated as new when
      // it fires, because "was it live before" genuinely has no answer.
      isNew: !previousKeys.has(rule.key),
      unknownBefore: previouslySkipped.has(rule.key),
    });
  }

  // Conditions that were live and no longer are. A curve that un-inverted and
  // then settled is as much news as the un-inversion, and dropping it silently
  // leaves the last thing a reader saw standing after it stopped being true.
  const liveKeys = new Set(entries.map((entry) => entry.key));
  const resolved = [...previousKeys]
    .filter((key) => !liveKeys.has(key))
    .filter((key) => !skipped.some((entry) => entry.key === key))
    .map((key) => ({
      key,
      severity: rules.find((rule) => rule.key === key)?.severity ?? 'low',
      text: `The ${key.replace(/-/g, ' ')} condition is no longer live.`,
      clearedFrom: key,
    }));
  const order = { high: 0, medium: 1, low: 2 };
  entries.sort((left, right) => order[left.severity] - order[right.severity] || Number(right.isNew) - Number(left.isNew));
  const raised = entries.filter((entry) => entry.isNew);
  return {
    version,
    status: entries.length ? 'calculated' : 'quiet',
    entries,
    raised,
    resolved,
    hasPreviousState: previousKeys.size > 0 || previous !== null,
    skipped,
    counts: {
      high: entries.filter((entry) => entry.severity === 'high').length,
      medium: entries.filter((entry) => entry.severity === 'medium').length,
      low: entries.filter((entry) => entry.severity === 'low').length,
    },
    read: entries.length
      ? `${entries.length} macro ${entries.length === 1 ? 'condition is' : 'conditions are'} live${raised.length ? `, ${raised.length} newly` : ''}${entries.filter((entry) => entry.severity === 'high').length ? `, ${entries.filter((entry) => entry.severity === 'high').length} of them high severity` : ''}.${resolved.length ? ` ${resolved.length} ${resolved.length === 1 ? 'condition has' : 'conditions have'} cleared.` : ''}`
      : `No macro alert condition is live${resolved.length ? `; ${resolved.length} cleared since the last evaluation` : ''}${skipped.length ? `; ${skipped.length} of ${rules.length} rules could not be evaluated because their model did not publish` : ''}.`,
    methodology: 'Each rule reads one published model. A rule whose model did not publish is skipped and listed rather than being treated as not firing, because "we cannot tell" and "it is not happening" are different answers and only one of them is safe to act on. Alerts are raised on the transition into a condition rather than for every evaluation while it holds, and a condition that clears is published as resolved — a still-live alert is not news, and one that quietly disappears leaves the last thing a reader saw standing after it stopped being true.',
  };
}

/**
 * Which drivers inside a composite are near-duplicates of each other, and what
 * the composite would score without the double-counting.
 *
 * The macro regime carries both the US and global liquidity impulses, and the
 * global pool contains the US one by construction — so two of its six drivers
 * are largely the same reading given two weights. That is not a bug in either
 * model; it is a weighting question that only becomes visible once the overlap
 * matrix has measured it, and the honest treatment is to publish the adjusted
 * score beside the headline rather than silently changing one of them.
 */
export function calculateWeightOverlap(model, correlationMatrix, { driverToModelId = {}, threshold = 0.9 } = {}) {
  const version = 'weight-overlap-v1';
  if (!published(model) || !Array.isArray(model.drivers)) {
    return { version, status: 'unavailable', reason: 'A composite publishing its drivers is required.', pairs: [] };
  }
  const scored = model.drivers.filter((driver) => Number.isFinite(driver.score) && Number.isFinite(driver.weight));
  if (scored.length < 2) {
    return { version, status: 'unavailable', reason: `The composite has ${scored.length} scored drivers; two are needed to overlap.`, pairs: [] };
  }
  const correlations = new Map((correlationMatrix?.pairs ?? [])
    .filter((pair) => pair.status === 'calculated')
    .flatMap((pair) => [[`${pair.left}|${pair.right}`, pair.correlation], [`${pair.right}|${pair.left}`, pair.correlation]]));
  if (!correlations.size) {
    return {
      version,
      status: 'unavailable',
      reason: 'No measured model correlations are available yet, so overlap cannot be distinguished from agreement.',
      pairs: [],
    };
  }

  // Two drivers moving together carry one factor under two weights, which the
  // composite adds twice. Two moving exactly opposite are not that: their
  // contributions offset, so dropping one would change the composite rather
  // than remove a duplication. Both are worth seeing and only the first is
  // double-counting, so they are separated and only the first is adjusted for.
  const pairs = [];
  const offsetting = [];
  for (let left = 0; left < scored.length; left += 1) {
    for (let right = left + 1; right < scored.length; right += 1) {
      const leftId = driverToModelId[scored[left].key];
      const rightId = driverToModelId[scored[right].key];
      if (!leftId || !rightId) continue;
      const correlation = correlations.get(`${leftId}|${rightId}`);
      if (!Number.isFinite(correlation) || Math.abs(correlation) < threshold) continue;
      const entry = {
        key: `${scored[left].key}|${scored[right].key}`,
        drivers: [scored[left].name, scored[right].name],
        correlation,
        combinedWeight: round(scored[left].weight + scored[right].weight, 3),
      };
      if (correlation > 0) {
        pairs.push({
          ...entry,
          // The lighter of the two is the one whose weight is redundant.
          redundantDriver: scored[left].weight <= scored[right].weight ? scored[left].key : scored[right].key,
          redundantWeight: Math.min(scored[left].weight, scored[right].weight),
        });
      } else {
        offsetting.push({
          ...entry,
          read: `${entry.drivers.join(' and ')} move almost exactly opposite at ${correlation}, so their contributions largely cancel inside the composite. That is one factor expressed twice with opposite signs, not the same factor counted twice, and the score is left alone.`,
        });
      }
    }
  }
  if (!pairs.length) {
    return {
      version,
      status: 'calculated',
      pairs: [],
      offsetting,
      headlineScore: model.score ?? null,
      adjustedScore: model.score ?? null,
      difference: 0,
      read: `No two drivers in ${model.version ?? 'this composite'} move together at ${threshold} or above, so nothing is being counted twice.${offsetting.length ? ` ${offsetting.length} ${offsetting.length === 1 ? 'pair moves' : 'pairs move'} almost exactly opposite instead, which offsets rather than duplicates.` : ''}`,
      methodology: `Driver pairs are checked against measured model-to-model correlations rather than assumed relationships. Only a positive pair at or above ${threshold} is treated as duplication: two drivers moving opposite carry one factor with opposite signs and their contributions cancel, which is a different problem and is reported separately rather than adjusted for.`,
    };
  }

  const redundantKeys = new Set(pairs.map((pair) => pair.redundantDriver));
  const kept = scored.filter((driver) => !redundantKeys.has(driver.key));
  const keptWeight = kept.reduce((total, driver) => total + driver.weight, 0);
  const adjusted = keptWeight > 0
    ? Math.round(kept.reduce((total, driver) => total + (driver.score * driver.weight), 0) / keptWeight)
    : null;

  return {
    version,
    status: 'calculated',
    pairs,
    offsetting,
    headlineScore: model.score ?? null,
    adjustedScore: adjusted,
    difference: Number.isFinite(adjusted) && Number.isFinite(model.score) ? adjusted - model.score : null,
    droppedDrivers: [...redundantKeys],
    read: `${pairs.length} driver ${pairs.length === 1 ? 'pair moves' : 'pairs move'} together at ${threshold} or above: ${pairs.map((pair) => pair.drivers.join(' and ')).join('; ')}. Dropping the lighter of each pair and reweighting gives ${adjusted}/100 against the published ${model.score}/100.${offsetting.length ? ` A further ${offsetting.length} ${offsetting.length === 1 ? 'pair moves' : 'pairs move'} almost exactly opposite, which offsets rather than duplicates and is left alone.` : ''}`,
    methodology: `Driver pairs are checked against measured model-to-model correlations rather than assumed relationships, so nothing is called duplication until it has been observed to be. Only a positive pair counts: two drivers moving opposite carry one factor with opposite signs and their contributions cancel inside the composite, which is a different problem and is reported separately rather than adjusted for. The adjusted score drops the lighter driver of each duplicating pair and renormalises the remaining weights. It is published beside the headline rather than replacing it: which of two correlated drivers deserves the weight is a modelling decision, not something the correlation can settle.`,
  };
}

/**
 * Recomputes a model's score at past dates and returns rows ready to store, so
 * the overlap matrix has something to correlate before three months of weekly
 * runs have accumulated.
 *
 * These rows are explicitly marked as backfilled and carry the current vintage
 * of their inputs. They are for measuring how two models move against each
 * other, which a consistent vintage serves fine; they are not evidence about
 * what either model would have said at the time, and nothing should read them
 * that way.
 */
export function buildBackfillRows(modelId, scoreAt, dates, { source = 'backfill' } = {}) {
  const rows = (dates ?? [])
    .map((date) => {
      let score = null;
      try {
        score = scoreAt(date);
      } catch {
        // A score function that throws on an early date has no answer there,
        // which is not the same as a score of zero.
        return null;
      }
      return Number.isFinite(score) ? { date, score: Math.round(score) } : null;
    })
    .filter(Boolean);
  return {
    modelId,
    source,
    backfilled: true,
    rows: rows.map((row) => ({
      asOf: row.date,
      output: { version: `${modelId}-backfill`, asOf: row.date, score: row.score, backfilled: true, source },
    })),
    read: rows.length
      ? `${rows.length} backfilled readings for ${modelId} between ${rows[0].date} and ${rows.at(-1).date}.`
      : `No date could be scored for ${modelId}.`,
  };
}

/**
 * How the consensus has moved. A spread that has been widening for a month is a
 * different signal from one that widened today, and the panel could only ever
 * show the latter.
 */
export function calculateConsensusHistory(outputs = [], { minimumObservations = 4 } = {}) {
  const version = 'macro-consensus-history-v1';
  const points = (outputs ?? [])
    .map((entry) => ({
      date: String(entry?.output?.asOf ?? entry?.effective_at ?? '').slice(0, 10),
      average: Number(entry?.output?.averageScore),
      spread: Number(entry?.output?.spread),
      state: entry?.output?.state ?? null,
    }))
    .filter((point) => point.date && Number.isFinite(point.average) && Number.isFinite(point.spread))
    .sort((left, right) => left.date.localeCompare(right.date));
  // One reading per vintage, so repeated runs over the same data cannot show as
  // movement that never happened.
  const deduped = [...new Map(points.map((point) => [point.date, point])).values()];
  if (deduped.length < minimumObservations) {
    return {
      version,
      status: 'unavailable',
      reason: `Needs ${minimumObservations} stored consensus readings; ${deduped.length} available. They accumulate once PostgreSQL is configured and ingestion has run.`,
      points: [],
    };
  }

  const latest = deduped.at(-1);
  const earliest = deduped[0];
  const spreadChange = latest.spread - earliest.spread;
  const averageChange = latest.average - earliest.average;
  // A run of consecutive readings moving the same way, which is what "has been
  // widening" means rather than "is wider than it was".
  let widenRun = 0;
  for (let index = deduped.length - 1; index >= 1; index -= 1) {
    if (deduped[index].spread > deduped[index - 1].spread) widenRun += 1;
    else break;
  }
  let narrowRun = 0;
  for (let index = deduped.length - 1; index >= 1; index -= 1) {
    if (deduped[index].spread < deduped[index - 1].spread) narrowRun += 1;
    else break;
  }
  const trend = widenRun >= 3 ? 'widening' : narrowRun >= 3 ? 'narrowing' : 'unchanged in direction';
  const stateChanges = deduped.slice(1).flatMap((point, index) => (point.state && point.state !== deduped[index].state
    ? [{ date: point.date, from: deduped[index].state, to: point.state }]
    : []));

  return {
    version,
    status: 'calculated',
    asOf: latest.date,
    observations: deduped.length,
    coveredFrom: earliest.date,
    points: deduped,
    spread: { latest: latest.spread, earliest: earliest.spread, change: Math.round(spreadChange), trend, consecutiveMoves: Math.max(widenRun, narrowRun) },
    average: { latest: latest.average, earliest: earliest.average, change: Math.round(averageChange) },
    stateChanges,
    read: `Across ${deduped.length} readings since ${earliest.date} the spread between models moved from ${earliest.spread} to ${latest.spread} and is ${trend}${Math.max(widenRun, narrowRun) >= 3 ? ` on ${Math.max(widenRun, narrowRun)} consecutive readings` : ''}. The average moved ${averageChange > 0 ? '+' : ''}${Math.round(averageChange)} points.${stateChanges.length ? ` ${stateChanges.length} state ${stateChanges.length === 1 ? 'change' : 'changes'}, the last from ${stateChanges.at(-1).from} to ${stateChanges.at(-1).to} on ${stateChanges.at(-1).date}.` : ''}`,
    methodology: 'Stored consensus readings, one per vintage so repeated runs over the same data cannot appear as movement. "Widening" means consecutive readings moving the same way rather than simply being wider than the first, because a single jump and a month of drift are different signals with the same endpoints.',
  };
}

/**
 * The macro section's conclusion.
 *
 * Derived from macro-regime-v1's own drivers rather than from a second set of
 * weights over a wider set of models. The wider version was tempting - it
 * reached growth, the curve and reserve scarcity - but it produced a second
 * number for a question the regime card on the same page already answers, and
 * two composites of overlapping inputs drift apart. The equity dashboard
 * carried exactly that fault for one commit.
 *
 * Growth, rates and surprise data are not lost: the consensus model below
 * compares all of them explicitly, which is the panel whose job is breadth.
 * This one's job is to state the call and show what carries it.
 *
 * The regime's components vote here, never the regime itself - a composite
 * sitting beside its own drivers would count one view of the world twice.
 */
export function calculateMacroVerdict(models = {}) {
  const { macroRegime } = models;
  if (!macroRegime || macroRegime.status === 'unavailable') {
    return buildVerdict({ title: 'Macro conditions', version: 'macro-verdict-v1', signals: [] });
  }
  return buildVerdictFromModel(macroRegime, {
    title: 'Macro conditions',
    version: 'macro-verdict-v1',
    meaning: { high: 'supportive of risk', low: 'restrictive' },
    details: {
      liquidity: models.liquidity?.regime ?? null,
      globalLiquidity: models.globalLiquidity?.regime ?? null,
      dollar: models.usdStrength?.regime ? `${models.usdStrength.regime} dollar, inverted` : 'inverted',
    },
  });
}
