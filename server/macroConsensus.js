/**
 * Cross-model layer: what the macro models say when read against each other,
 * how much of what they say is genuinely independent, and which readings are
 * time-sensitive enough to raise.
 *
 * The workspace publishes around twenty-five macro models and nothing until now
 * compared them. A growth nowcast reading "Accelerating" beside an inverted
 * curve and a negative surprise index is the most informative thing on the page
 * and was invisible because each model only ever spoke for itself.
 */

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function deviation(values) {
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(values.reduce((total, value) => total + ((value - average) ** 2), 0) / (values.length - 1));
}

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

  return {
    directional: signals.map((signal) => ({ ...signal, directional: true, available: Number.isFinite(signal.score) })),
    cautions: cautions.map((signal) => ({ ...signal, directional: false, available: Number.isFinite(signal.score) })),
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
  const dispersion = deviation(scores);
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
    sameFamilyContradictions: contradictions.filter((entry) => entry.sameFamily).length,
    state,
    read: `${state}: ${available.length} of ${signals.length} models publish, averaging ${Math.round(average)}/100 across a ${Math.round(spread)}-point spread from ${ranked.at(-1).name} at ${ranked.at(-1).score} to ${ranked[0].name} at ${ranked[0].score}.${outliers.length ? ` ${outliers.map((entry) => entry.name).join(' and ')} ${outliers.length === 1 ? 'stands' : 'stand'} apart from the rest.` : contradictions.length ? ` ${contradictions.length} ${contradictions.length === 1 ? 'pair disagrees' : 'pairs disagree'} by ${gap} points or more.` : ''}`,
    methodology: `Each model is placed on one axis where 0 is maximally risk-negative and 100 maximally risk-positive; the dollar, term premium and reserve-scarcity readings are inverted onto it because a stronger dollar, a richer term premium and scarcer reserves all tighten conditions. Readings derived from a percentile are compressed to a 20-80 band before joining it, because a percentile is uniform by construction and reaches its extremes far more often than a driver composite does — untreated, those two would pin to 0 and 100 and contradict every other model at once purely from the shape of their own distribution. Models that carry no direction on that axis are absent from it: the rate path is ambiguous by construction and the liquidity calendar is a schedule, while inflation balance and regime maturity are cautions that peak when nothing is wrong and are published separately so a calm reading cannot masquerade as a risk-positive one. The average is published alongside the spread and the disagreeing pairs, never instead of them, because an average across contradicting models hides exactly what is worth knowing. Every disagreeing pair is published, but a model sitting far from the rest contradicts all of them and would fill that list with itself restated, so each model is also measured once against the median of the others and the ones that stand apart are named.`,
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
export function evaluateMacroAlerts(models = {}, { rules = ALERT_RULES } = {}) {
  const version = 'macro-alerts-v1';
  const entries = [];
  const skipped = [];
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
    entries.push({ key: rule.key, severity: rule.severity, model: rule.model, text: rule.text(model) });
  }
  const order = { high: 0, medium: 1, low: 2 };
  entries.sort((left, right) => order[left.severity] - order[right.severity]);
  return {
    version,
    status: entries.length ? 'calculated' : 'quiet',
    entries,
    skipped,
    counts: {
      high: entries.filter((entry) => entry.severity === 'high').length,
      medium: entries.filter((entry) => entry.severity === 'medium').length,
      low: entries.filter((entry) => entry.severity === 'low').length,
    },
    read: entries.length
      ? `${entries.length} macro ${entries.length === 1 ? 'condition is' : 'conditions are'} live${entries.filter((entry) => entry.severity === 'high').length ? `, ${entries.filter((entry) => entry.severity === 'high').length} of them high severity` : ''}.`
      : `No macro alert condition is live${skipped.length ? `; ${skipped.length} of ${rules.length} rules could not be evaluated because their model did not publish` : ''}.`,
    methodology: 'Each rule reads one published model. A rule whose model did not publish is skipped and listed rather than being treated as not firing, because "we cannot tell" and "it is not happening" are different answers and only one of them is safe to act on.',
  };
}
