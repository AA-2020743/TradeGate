import { calculateChangeCorrelations, calculateTechnicalSnapshot, pearsonCorrelation } from './analytics.js';
import { mean, median, ordinal, percentileRank, standardDeviation } from './statistics.js';
import { resolveVintage } from './vintage.js';

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

const pearson = pearsonCorrelation;

function percentChange(values, periods) {
  const base = values.at(-(periods + 1));
  // A non-positive base makes the ratio meaningless, not merely undefined:
  // percent change from -50 to -25 computes as -50% when the move was upward.
  if (values.length <= periods || !Number.isFinite(base) || base <= 0) return null;
  return ((values.at(-1) / base) - 1) * 100;
}

function movingAverage(values, periods) {
  return values.length >= periods ? mean(values.slice(-periods)) : null;
}

function ema(values, period) {
  if (values.length < period) return [];
  const multiplier = 2 / (period + 1);
  const output = Array(values.length).fill(null);
  output[period - 1] = mean(values.slice(0, period));
  for (let index = period; index < values.length; index += 1) {
    output[index] = values[index] * multiplier + output[index - 1] * (1 - multiplier);
  }
  return output;
}

function normalizeHistory(points) {
  const normalized = points
    .filter((point) => Number.isFinite(point.value) && (point.timestamp || point.date))
    .map((point) => ({ ...point, date: (point.timestamp ?? point.date).slice(0, 10) }))
    .sort((left, right) => String(left.timestamp ?? left.date).localeCompare(String(right.timestamp ?? right.date)));
  return [...new Map(normalized.map((point) => [point.date, point])).values()];
}

function weightedModel(definitions, minimumCoverage, mandatory = []) {
  // Round each driver before weighting, so the published drivers reconstruct
  // the published score exactly. Weighting the unrounded values and then
  // rounding them for display left the two off by up to a point, which is the
  // same "shown number is not the used number" gap that broke the volatility
  // term-structure ratio.
  const rounded = definitions.map((driver) => ({
    ...driver,
    score: Number.isFinite(driver.score) ? Math.round(clamp(driver.score)) : driver.score,
  }));
  const available = rounded.filter((driver) => Number.isFinite(driver.score));
  const availableKeys = new Set(available.map((driver) => driver.key));
  const availableWeight = available.reduce((total, driver) => total + driver.weight, 0);
  const coverage = Math.round(availableWeight * 100);
  const missing = rounded.filter((driver) => !availableKeys.has(driver.key)).map((driver) => driver.name);
  const mandatoryPresent = mandatory.every((key) => availableKeys.has(key));
  const rawScore = availableWeight
    ? available.reduce((total, driver) => total + (driver.score * driver.weight), 0) / availableWeight
    : null;
  return {
    publishable: mandatoryPresent && availableWeight >= minimumCoverage,
    score: rawScore === null ? null : Math.round(clamp(rawScore)),
    coverage,
    missing,
    drivers: rounded.map((driver) => ({
      key: driver.key,
      name: driver.name,
      score: Number.isFinite(driver.score) ? driver.score : null,
      weight: driver.weight,
      source: driver.source,
    })),
  };
}

const REGIME_SETTINGS = {
  'Risk-on expansion': { trend: 30, momentum: 30, meanReversion: 5, defensive: 10, macro: 25, alertThreshold: 68, holdingPeriod: '20-60 sessions' },
  'Low-volatility expansion': { trend: 35, momentum: 20, meanReversion: 10, defensive: 10, macro: 25, alertThreshold: 65, holdingPeriod: '30-90 sessions' },
  Recovery: { trend: 20, momentum: 35, meanReversion: 10, defensive: 10, macro: 25, alertThreshold: 62, holdingPeriod: '10-40 sessions' },
  'Neutral / transition': { trend: 20, momentum: 15, meanReversion: 30, defensive: 15, macro: 20, alertThreshold: 72, holdingPeriod: '5-20 sessions' },
  'Mean-reverting / choppy': { trend: 10, momentum: 10, meanReversion: 45, defensive: 15, macro: 20, alertThreshold: 75, holdingPeriod: '2-15 sessions' },
  'High-volatility deleveraging': { trend: 10, momentum: 15, meanReversion: 5, defensive: 40, macro: 30, alertThreshold: 78, holdingPeriod: '1-10 sessions' },
  'Risk-off contraction': { trend: 10, momentum: 10, meanReversion: 10, defensive: 40, macro: 30, alertThreshold: 75, holdingPeriod: '5-30 sessions' },
};

/**
 * Breadth that publishes a score on a narrower base is still evidence. Taking
 * only "calculated" threw away a breadth read at, say, 80% universe coverage
 * and, because breadth is a mandatory leg, took the whole top-risk and
 * bottom-signal models down with it. A partial leg is used and the model that
 * used it is marked provisional, which is the honest middle.
 */
function usableBreadth(breadth) {
  if (!breadth || !Number.isFinite(breadth.score ?? breadth.topRisk ?? breadth.bottomScore)) return { leg: null, partial: false };
  if (breadth.status === 'calculated') return { leg: breadth, partial: false };
  if (breadth.status === 'partial' || breadth.status === 'provisional') return { leg: breadth, partial: true };
  return { leg: null, partial: false };
}

export function calculateEquityRegime({ technical, liquidity, breadth, credit, sentiment, positioning } = {}) {
  const volatility = technical?.indicators?.annualizedVolatility20d;
  const { leg: calculatedBreadth, partial: breadthPartial } = usableBreadth(breadth);
  const definitions = [
    { key: 'trend', name: 'Price trend', score: technical?.components?.trend, weight: 0.24, source: 'Provider close history' },
    { key: 'momentum', name: 'Price momentum', score: technical?.components?.momentum, weight: 0.18, source: 'Provider close history' },
    { key: 'breadth', name: 'Market breadth', score: calculatedBreadth?.score, weight: 0.18, source: calculatedBreadth?.source },
    { key: 'liquidity', name: 'Liquidity impulse', score: liquidity?.score, weight: 0.12, source: liquidity?.version },
    { key: 'credit', name: 'Credit conditions', score: credit?.score, weight: 0.1, source: credit?.source },
    { key: 'volatility', name: 'Volatility quality', score: technical?.components?.volatilityQuality, weight: 0.1, source: 'Provider close history' },
    { key: 'sentiment', name: 'Sentiment balance', score: sentiment?.score, weight: 0.04, source: sentiment?.source },
    { key: 'positioning', name: 'Positioning balance', score: positioning?.score, weight: 0.04, source: positioning?.source },
  ];
  const model = weightedModel(definitions, 0.5, ['trend', 'momentum', 'volatility']);
  if (!model.publishable) {
    return { version: 'equity-regime-v1', status: 'unavailable', asOf: technical?.asOf ?? null, ...model, score: null, regime: null, settings: null };
  }

  const trend = technical.components.trend;
  const momentum = technical.components.momentum;
  let regime = 'Neutral / transition';
  if (volatility >= 30 && model.score < 48) regime = 'High-volatility deleveraging';
  else if (model.score <= 35) regime = 'Risk-off contraction';
  else if (trend <= 45 && momentum >= 60 && model.score >= 50) regime = 'Recovery';
  else if (trend >= 65 && model.score >= 68 && volatility < 16) regime = 'Low-volatility expansion';
  else if (trend >= 65 && model.score >= 62) regime = 'Risk-on expansion';
  else if (trend >= 35 && trend <= 65 && Math.abs(momentum - 50) <= 18) regime = 'Mean-reverting / choppy';

  const directionalDrivers = model.drivers.filter((driver) => driver.score !== null);
  const agreement = directionalDrivers.filter((driver) => (driver.score >= 50) === (model.score >= 50)).length / directionalDrivers.length;
  const confidenceScore = Math.round((model.coverage * 0.65) + (agreement * 100 * 0.35));
  return {
    version: 'equity-regime-v1',
    status: model.coverage >= 75 && !breadthPartial ? 'calculated' : 'provisional',
    breadthPartial,
    asOf: technical.asOf,
    ...model,
    regime,
    confidence: confidenceScore >= 75 ? 'High' : confidenceScore >= 55 ? 'Medium' : 'Low',
    confidenceScore,
    settings: REGIME_SETTINGS[regime],
  };
}

// At least two of the three legs, so a single indicator cannot carry the read.
const MINIMUM_TECHNICAL_LEGS = 2;

function technicalLegAverage(legs) {
  const available = legs.filter(Number.isFinite);
  return available.length >= MINIMUM_TECHNICAL_LEGS ? mean(available) : null;
}

/**
 * A missing input is unavailable, not benign. Defaulting the extension to zero
 * and the MACD leg to its calm value meant an absent 200-day average or MACD
 * pulled the average toward "no risk", so the model read *lower* risk exactly
 * when it had least to go on — the one direction a risk score must not fail in.
 */
function technicalTopRisk(technical) {
  if (!technical) return null;
  const rsi = technical.indicators?.rsi14;
  const latest = technical.latest;
  const sma200 = technical.indicators?.sma200;
  const macdHistogram = technical.indicators?.macd?.histogram;
  const extension = Number.isFinite(sma200) && sma200 > 0 && Number.isFinite(latest) ? ((latest / sma200) - 1) * 100 : null;
  return technicalLegAverage([
    Number.isFinite(rsi) ? clamp(((rsi - 55) / 25) * 100) : null,
    extension === null ? null : clamp(extension * 4),
    Number.isFinite(macdHistogram) ? (macdHistogram < 0 ? 75 : 25) : null,
  ]);
}

/** Same rule as the top-risk legs: absent inputs drop out rather than reading calm. */
function technicalBottomScore(technical) {
  if (!technical) return null;
  const rsi = technical.indicators?.rsi14;
  const latest = technical.latest;
  const sma200 = technical.indicators?.sma200;
  const macdHistogram = technical.indicators?.macd?.histogram;
  const discount = Number.isFinite(sma200) && sma200 > 0 && Number.isFinite(latest) && latest > 0 ? ((sma200 / latest) - 1) * 100 : null;
  return technicalLegAverage([
    Number.isFinite(rsi) ? clamp(((45 - rsi) / 25) * 100) : null,
    discount === null ? null : clamp(discount * 5),
    Number.isFinite(macdHistogram) ? (macdHistogram > 0 ? 70 : 20) : null,
  ]);
}

/**
 * Participation across whatever ETF histories are fresh. Each average is only
 * counted for the ETFs that actually carry enough history for it: a 200-day
 * line computed from 60 closes is a 60-day line, and publishing it under the
 * 200-day label was the model quietly answering a question it had not asked.
 */
export function calculateSectorBreadthProxy(inputs, { minimumObservations = 60 } = {}) {
  const usable = (inputs ?? []).filter((input) => Array.isArray(input?.points) && input.points.length >= minimumObservations);
  if (!usable.length) {
    return { version: 'sector-breadth-proxy-v2', status: 'unavailable', source: 'Sector/subsector ETF participation proxy', missing: [`At least one ETF history with ${minimumObservations} or more sessions`] };
  }

  const stats = usable.map((input) => {
    const values = input.points.map((point) => point.value).filter(Number.isFinite);
    const latest = values.at(-1);
    const sma = (period) => (values.length >= period ? mean(values.slice(-period)) : null);
    const sma50 = sma(50);
    const sma200 = sma(200);
    const window60 = values.slice(-60);
    const high60 = Math.max(...window60);
    const low60 = Math.min(...window60);
    const past20 = values.at(-21);
    const sma50Past = values.length >= 70 ? mean(values.slice(-70, -20)) : null;
    return {
      symbol: input.symbol,
      above50: Number.isFinite(sma50) ? latest > sma50 : null,
      above200: Number.isFinite(sma200) ? latest > sma200 : null,
      advancing: Number.isFinite(past20) && past20 > 0 ? ((latest / past20) - 1) > 0 : null,
      newHigh: latest >= (high60 * 0.98),
      newLow: latest <= (low60 * 1.02),
      thrustDelta: Number.isFinite(sma50Past) && sma50Past > 0 && Number.isFinite(sma50) ? (((sma50 / sma50Past) - 1) * 100) : null,
      asOf: input.points.at(-1)?.date ?? null,
    };
  });

  // A metric is a share of the ETFs that could answer it, never of the whole
  // universe: mixing "cannot say" in with "no" reads as weakness that is not
  // in the data.
  const share = (key) => {
    const answered = stats.filter((stat) => stat[key] !== null);
    if (!answered.length) return { percent: null, eligible: 0 };
    return { percent: Math.round((answered.filter((stat) => stat[key]).length / answered.length) * 100), eligible: answered.length };
  };
  const above50 = share('above50');
  const above200 = share('above200');
  const advancers = share('advancing');
  const universeSize = stats.length;
  const newHighs = stats.filter((stat) => stat.newHigh).length;
  const newLows = stats.filter((stat) => stat.newLow).length;
  const thrustValues = stats.map((stat) => stat.thrustDelta).filter(Number.isFinite);
  const thrust20 = thrustValues.length ? Number(mean(thrustValues).toFixed(2)) : null;

  const participationLegs = [
    { value: above50.percent, weight: 0.6 },
    { value: above200.percent, weight: 0.4 },
  ].filter((leg) => Number.isFinite(leg.value));
  const participationWeight = participationLegs.reduce((total, leg) => total + leg.weight, 0);
  const participation = participationWeight
    ? participationLegs.reduce((total, leg) => total + (leg.value * leg.weight), 0) / participationWeight
    : null;
  const topRisk = participation === null ? null : Math.round(clamp(100 - participation));
  const bottomScore = participation === null ? null : Math.round(clamp(((100 - participation) * 0.7) + (Math.max(thrust20 ?? 0, 0) * 3)));
  // The stalest constituent sets the vintage; the freshest one hides the rest.
  const vintage = resolveVintage(stats.map((stat) => ({ name: stat.symbol ?? stat.name, asOf: stat.asOf })));
  const { asOf } = vintage;
  const missing = [
    ...(above200.eligible < universeSize ? [`${universeSize - above200.eligible} of ${universeSize} ETFs lack 200 sessions for the long-cycle line`] : []),
    ...(above50.eligible < universeSize ? [`${universeSize - above50.eligible} of ${universeSize} ETFs lack 50 sessions`] : []),
  ];

  return {
    ...vintage,
    version: 'sector-breadth-proxy-v2',
    status: participation === null ? 'unavailable' : missing.length ? 'provisional' : 'calculated',
    reason: participation === null ? 'No ETF in the universe carries enough history for a moving-average line.' : null,
    source: 'Sector/subsector ETF participation proxy',
    asOf,
    universeSize,
    pctAbove50: above50.percent,
    pctAbove200: above200.percent,
    advancersPct: advancers.percent,
    eligible: { above50: above50.eligible, above200: above200.eligible, advancers: advancers.eligible },
    newHighs,
    newLows,
    thrust20,
    topRisk,
    bottomScore,
    missing,
    methodology: `Participation across sector and subsector ETF close histories, requiring ${minimumObservations} sessions to enter the universe. Each moving-average line is a share of the ETFs carrying enough history for that specific average - the 200-day line is never computed from fewer than 200 closes - so a short-history universe reports a narrower base rather than a wrong number. Not a substitute for constituent-level breadth.`,
  };
}

export function calculateTopRisk({ technical, breadth, sentiment, positioning, credit, liquidity, flows } = {}) {
  const { leg: calculatedBreadth, partial: breadthPartial } = usableBreadth(breadth);
  const definitions = [
    { key: 'technical', name: 'Technical deterioration', score: technicalTopRisk(technical), weight: 0.25, source: 'Provider close history' },
    { key: 'breadth', name: 'Breadth deterioration', score: calculatedBreadth?.topRisk, weight: 0.2, source: calculatedBreadth?.source },
    { key: 'sentiment', name: 'Sentiment euphoria', score: sentiment?.euphoria, weight: 0.15, source: sentiment?.source },
    { key: 'positioning', name: 'Crowded positioning', score: positioning?.crowding, weight: 0.15, source: positioning?.source },
    { key: 'credit', name: 'Credit deterioration', score: credit?.deterioration, weight: 0.1, source: credit?.source },
    { key: 'liquidity', name: 'Liquidity contraction', score: Number.isFinite(liquidity?.score) ? 100 - liquidity.score : null, weight: 0.1, source: liquidity?.version },
    { key: 'flows', name: 'Distribution flows', score: flows?.distribution, weight: 0.05, source: flows?.source },
  ];
  const model = weightedModel(definitions, 0.55, ['technical', 'breadth']);
  const score = model.publishable ? model.score : null;
  return {
    version: 'equity-top-risk-v1',
    status: !model.publishable ? 'unavailable' : breadthPartial ? 'provisional' : 'calculated',
    breadthPartial,
    asOf: technical?.asOf ?? null,
    ...model,
    score,
    risk: score === null ? null : score >= 75 ? 'Extreme' : score >= 55 ? 'Elevated' : score >= 35 ? 'Watch' : 'Low',
  };
}

export function calculateBottomSignal({ technical, breadth, sentiment, positioning, credit, liquidity, flows } = {}) {
  const { leg: calculatedBreadth, partial: breadthPartial } = usableBreadth(breadth);
  const definitions = [
    { key: 'technical', name: 'Technical washout and turn', score: technicalBottomScore(technical), weight: 0.25, source: 'Provider close history' },
    { key: 'breadth', name: 'Breadth washout and thrust', score: calculatedBreadth?.bottomScore, weight: 0.2, source: calculatedBreadth?.source },
    { key: 'sentiment', name: 'Sentiment pessimism', score: sentiment?.pessimism, weight: 0.15, source: sentiment?.source },
    { key: 'positioning', name: 'Positioning underexposure', score: positioning?.underexposure, weight: 0.1, source: positioning?.source },
    { key: 'credit', name: 'Credit stabilization', score: credit?.stabilization, weight: 0.1, source: credit?.source },
    { key: 'liquidity', name: 'Liquidity turn', score: liquidity?.score, weight: 0.1, source: liquidity?.version },
    { key: 'flows', name: 'Capitulation flows', score: flows?.capitulation, weight: 0.1, source: flows?.source },
  ];
  const model = weightedModel(definitions, 0.55, ['technical', 'breadth']);
  const score = model.publishable ? model.score : null;
  const longTrendAvailable = Number.isFinite(technical?.indicators?.sma200) && Number.isFinite(technical?.latest);
  const belowLongTrend = longTrendAvailable && technical.latest < technical.indicators.sma200;
  const breadthConfirmed = Number.isFinite(calculatedBreadth?.bottomScore) && calculatedBreadth.bottomScore >= 60;
  return {
    version: 'equity-bottom-signal-v1',
    status: !model.publishable ? 'unavailable' : breadthPartial ? 'provisional' : 'calculated',
    breadthPartial,
    asOf: technical?.asOf ?? null,
    ...model,
    score,
    signal: score === null ? null : score >= 75 ? 'Capitulation reversal' : score >= 55 ? 'Bottoming watch' : score >= 35 ? 'Stabilizing' : 'Unconfirmed',
    bearMarketRallyRisk: model.publishable && longTrendAvailable ? belowLongTrend && !breadthConfirmed ? 'Elevated' : 'Normal' : null,
  };
}

const THRUST_OVERSOLD = 0.4;
const THRUST_TRIGGER = 0.615;
const THRUST_FORWARD_WINDOWS = [20, 60];
const THRUST_SETUP_SESSIONS = 10;

/**
 * Every point in a run of sessions where the ten-session advance ratio crossed
 * from below 40% to at or above 61.5%, with what the benchmark did next. A live
 * boolean says a thrust fired today and nothing about whether thrusts here have
 * meant anything; the log answers the second question, on however few episodes
 * the window happens to contain.
 *
 * `advanceRatios` and `benchmarkValues` are index-aligned session series. A
 * forward return is only measured where the benchmark extends past the event,
 * so a recent trigger reports a pending outcome rather than a truncated one.
 */
export function calculateThrustLog(advanceRatios, benchmarkValues = [], { dates = [] } = {}) {
  const ratios = advanceRatios ?? [];
  const events = [];
  const total = ratios.length;
  if (total < THRUST_SETUP_SESSIONS * 2) return events;
  const windowMean = (start, end) => {
    const slice = ratios.slice(start, end).filter(Number.isFinite);
    return slice.length === end - start ? mean(slice) : null;
  };

  let armed = true;
  for (let end = THRUST_SETUP_SESSIONS * 2; end <= total; end += 1) {
    const recent = windowMean(end - THRUST_SETUP_SESSIONS, end);
    const prior = windowMean(end - (THRUST_SETUP_SESSIONS * 2), end - THRUST_SETUP_SESSIONS);
    if (recent === null || prior === null) continue;
    if (prior >= THRUST_OVERSOLD) {
      // Re-arm only once the tape washes out again, so one sustained advance is
      // logged as a single episode rather than as ten consecutive ones.
      if (recent < THRUST_OVERSOLD) armed = true;
      continue;
    }
    if (!armed) continue;
    if (recent < THRUST_TRIGGER) continue;
    const index = end - 1;
    const start = benchmarkValues[index];
    const forward = Object.fromEntries(THRUST_FORWARD_WINDOWS.map((horizon) => {
      const finish = benchmarkValues[index + horizon];
      return [`forward${horizon}`, Number.isFinite(start) && start > 0 && Number.isFinite(finish)
        ? Math.round(((finish / start) - 1) * 1000) / 10
        : null];
    }));
    events.push({
      index,
      sessionsAgo: total - 1 - index,
      date: dates[index] ?? null,
      priorRatio: Math.round(prior * 1000) / 10,
      triggerRatio: Math.round(recent * 1000) / 10,
      ...forward,
      benchmarkCovered: Number.isFinite(start),
    });
    armed = false;
  }
  return events;
}

export function calculateBreadth(constituents, options = {}) {
  const histories = constituents.map((constituent) => {
    const points = normalizeHistory(constituent.points ?? []);
    return { ...constituent, points, pointIndexByDate: new Map(points.map((point, index) => [point.date, index])) };
  });
  const eligible = histories.filter((constituent) => constituent.points.length >= 20);
  const expectedConstituents = Math.max(constituents.length, options.expectedConstituents ?? constituents.length);
  const minimumConstituents = Math.max(20, Math.ceil(expectedConstituents * 0.7));
  if (eligible.length < minimumConstituents) {
    return {
      version: 'equity-breadth-v1',
      status: 'unavailable',
      asOf: null,
      constituents: eligible.length,
      expectedConstituents,
      minimumConstituents,
      coverage: expectedConstituents ? Math.round((eligible.length / expectedConstituents) * 100) : 0,
      missing: ['Constituent-level price history'],
    };
  }

  const dates = [...new Set(eligible.flatMap((constituent) => constituent.points.map((point) => point.date)))].sort();
  const daily = dates.slice(1).map((date) => {
    let advances = 0;
    let declines = 0;
    let advanceVolume = 0;
    let declineVolume = 0;
    let volumeParticipants = 0;
    let observed = 0;
    for (const constituent of eligible) {
      const index = constituent.pointIndexByDate.get(date) ?? -1;
      if (index <= 0) continue;
      const point = constituent.points[index];
      const change = point.value - constituent.points[index - 1].value;
      observed += 1;
      if (Number.isFinite(point.volume)) volumeParticipants += 1;
      if (change > 0) {
        advances += 1;
        if (Number.isFinite(point.volume)) advanceVolume += point.volume;
      } else if (change < 0) {
        declines += 1;
        if (Number.isFinite(point.volume)) declineVolume += point.volume;
      }
    }
    return {
      date,
      advances,
      declines,
      netAdvances: advances - declines,
      // Deliberately advances over every observed name, not over advances plus
      // declines as the classic Zweig ratio does. Excluding unchanged closes
      // reads 100% participation off a single riser in a flat tape; including
      // them costs a little precision and cannot invent breadth that is not
      // there. The published `ratioBasis` names which of the two this is.
      advanceRatio: observed ? advances / observed : null,
      unchanged: observed - advances - declines,
      advanceVolume,
      declineVolume,
      volumeParticipants,
      observed,
    };
  }).filter((day) => day.observed >= minimumConstituents);
  if (daily.length < 39) {
    return {
      version: 'equity-breadth-v1',
      status: 'unavailable',
      asOf: daily.at(-1)?.date ?? null,
      constituents: eligible.length,
      expectedConstituents,
      minimumConstituents,
      coverage: expectedConstituents ? Math.round((eligible.length / expectedConstituents) * 100) : 0,
      missing: ['At least 39 synchronized constituent observations'],
    };
  }

  const latestDate = daily.at(-1).date;
  const latestMetrics = { above20: 0, eligible20: 0, above50: 0, eligible50: 0, above200: 0, eligible200: 0, highs: 0, lows: 0, eligible252: 0 };
  for (const constituent of eligible) {
    const latestIndex = constituent.pointIndexByDate.get(latestDate);
    if (latestIndex === undefined) continue;
    const points = constituent.points.slice(0, latestIndex + 1);
    const values = points.map((point) => point.value);
    const latest = values.at(-1);
    if (values.length >= 20) {
      latestMetrics.eligible20 += 1;
      if (latest > movingAverage(values, 20)) latestMetrics.above20 += 1;
    }
    if (values.length >= 50) {
      latestMetrics.eligible50 += 1;
      if (latest > movingAverage(values, 50)) latestMetrics.above50 += 1;
    }
    if (values.length >= 200) {
      latestMetrics.eligible200 += 1;
      if (latest > movingAverage(values, 200)) latestMetrics.above200 += 1;
    }
    if (values.length >= 252) {
      latestMetrics.eligible252 += 1;
      if (latest >= Math.max(...values.slice(-252))) latestMetrics.highs += 1;
      if (latest <= Math.min(...values.slice(-252))) latestMetrics.lows += 1;
    }
  }

  const netAdvances = daily.map((day) => day.netAdvances);
  const ema19 = ema(netAdvances, 19);
  const ema39 = ema(netAdvances, 39);
  const mcClellanHistory = daily.flatMap((day, index) => Number.isFinite(ema19[index]) && Number.isFinite(ema39[index])
    ? [{ date: day.date, value: ema19[index] - ema39[index] }]
    : []);
  const meanAdvanceRatio = (days) => days.every((day) => Number.isFinite(day.advanceRatio)) ? mean(days.map((day) => day.advanceRatio)) : null;
  const breadthThrust = daily.length >= 10 ? meanAdvanceRatio(daily.slice(-10)) : null;
  const previousThrust = daily.length >= 20 ? meanAdvanceRatio(daily.slice(-20, -10)) : null;
  // The benchmark is mapped onto the same session index the advance ratios use,
  // so a forward return is never read off a session the breadth series skipped.
  const benchmarkByDate = new Map(normalizeHistory(options.benchmark ?? []).map((point) => [point.date, point.value]));
  const thrustEvents = calculateThrustLog(
    daily.map((day) => day.advanceRatio),
    daily.map((day) => benchmarkByDate.get(day.date) ?? null),
    { dates: daily.map((day) => day.date) },
  );
  const participation = (value, denominator) => denominator >= minimumConstituents ? (value / denominator) * 100 : null;
  const percentAbove20 = participation(latestMetrics.above20, latestMetrics.eligible20);
  const percentAbove50 = participation(latestMetrics.above50, latestMetrics.eligible50);
  const percentAbove200 = participation(latestMetrics.above200, latestMetrics.eligible200);
  const newHighLow = latestMetrics.eligible252 >= minimumConstituents ? ((latestMetrics.highs - latestMetrics.lows) / latestMetrics.eligible252) * 100 : null;
  const scoreComponents = [
    { value: percentAbove20, weight: 0.25 },
    { value: percentAbove50, weight: 0.3 },
    { value: percentAbove200, weight: 0.3 },
    { value: Number.isFinite(newHighLow) ? (newHighLow + 100) / 2 : null, weight: 0.15 },
  ].filter((component) => Number.isFinite(component.value));
  const scoreCoverage = scoreComponents.reduce((total, component) => total + component.weight, 0);
  const score = scoreCoverage >= 0.55 - 1e-9
    ? Math.round(clamp(scoreComponents.reduce((total, component) => total + (component.value * component.weight), 0) / scoreCoverage))
    : null;
  const latestAdvanceRatio = Number.isFinite(daily.at(-1).advanceRatio) ? daily.at(-1).advanceRatio * 100 : null;
  const topRisk = [percentAbove20, percentAbove50, latestAdvanceRatio].every(Number.isFinite)
    ? Math.round(clamp((100 - percentAbove20) * 0.35 + (100 - percentAbove50) * 0.35 + (100 - latestAdvanceRatio) * 0.3))
    : null;
  const washout = Number.isFinite(percentAbove20) ? clamp((35 - percentAbove20) * 2.5) : null;
  const thrust = breadthThrust !== null && previousThrust !== null ? clamp((breadthThrust - previousThrust) * 500 + 50) : null;
  const bottomScore = Number.isFinite(washout) && Number.isFinite(thrust) ? Math.round((washout * 0.55) + (thrust * 0.45)) : null;
  const hasVolume = daily.at(-1).volumeParticipants >= minimumConstituents;
  const mcClellanSummation = mcClellanHistory.length >= 20 ? mcClellanHistory.reduce((total, point) => total + point.value, 0) : null;
  const unavailable = [
    ...(!hasVolume ? ['Advance/Decline Volume'] : []),
    ...(!Number.isFinite(percentAbove50) ? ['% above 50DMA'] : []),
    ...(!Number.isFinite(percentAbove200) ? ['% above 200DMA'] : []),
    ...(!Number.isFinite(newHighLow) ? ['New highs/new lows'] : []),
    ...(!Number.isFinite(mcClellanSummation) ? ['McClellan Summation'] : []),
    'Equal-weight vs cap-weight',
    'Sector breadth',
    'Small-cap vs large-cap participation',
  ];
  // One cumulative line, and the chart is the tail of it. Summing the whole
  // series for the headline while restarting the chart's line at zero 252
  // sessions ago gave two different numbers for the same quantity.
  let advanceDeclineLine = 0;
  const cumulative = daily.map((day) => {
    advanceDeclineLine += day.netAdvances;
    return { date: day.date, netAdvances: day.netAdvances, advanceDeclineLine };
  });
  const history = cumulative.slice(-252);
  const universeCoverage = expectedConstituents ? Math.round((latestMetrics.eligible20 / expectedConstituents) * 100) : 0;

  return {
    version: 'equity-breadth-v1',
    status: scoreCoverage >= 0.85 - 1e-9 && universeCoverage >= 85 ? 'calculated' : 'partial',
    source: 'Constituent provider histories',
    asOf: latestDate,
    constituents: latestMetrics.eligible20,
    expectedConstituents,
    minimumConstituents,
    coverage: universeCoverage,
    scoreCoverage: Math.round(scoreCoverage * 100),
    metricCoverage: { dma20: latestMetrics.eligible20, dma50: latestMetrics.eligible50, dma200: latestMetrics.eligible200, highLow252: latestMetrics.eligible252 },
    score,
    topRisk,
    bottomScore,
    advanceDecline: {
      advances: daily.at(-1).advances,
      declines: daily.at(-1).declines,
      line: cumulative.at(-1).advanceDeclineLine,
      volume: hasVolume ? { advance: daily.at(-1).advanceVolume, decline: daily.at(-1).declineVolume } : null,
    },
    mcClellan: {
      oscillator: mcClellanHistory.at(-1)?.value ?? null,
      summation: mcClellanSummation,
    },
    percentAbove: { dma20: percentAbove20, dma50: percentAbove50, dma200: percentAbove200 },
    newHighs: latestMetrics.eligible252 >= minimumConstituents ? latestMetrics.highs : null,
    newLows: latestMetrics.eligible252 >= minimumConstituents ? latestMetrics.lows : null,
    breadthThrust: breadthThrust === null ? null : breadthThrust * 100,
    ratioBasis: 'advances / all observed constituents (unchanged closes included in the denominator)',
    unchanged: daily.at(-1).unchanged,
    thrustTriggered: previousThrust !== null && previousThrust < 0.4 && breadthThrust >= 0.615,
    thrustEvents,
    history,
    unavailable,
    missing: unavailable,
  };
}


/**
 * Asks whether participation confirms the index. An advance/decline line and a
 * price series are each ranked within the same window: a market pushing to the
 * top of its range while the A/D line sits far below the top of its own is a
 * rally carried by fewer and fewer names. Percentile ranks are used rather than
 * pivot detection, which is fragile on noisy daily data and can miss or invent
 * a peak depending on where the window happens to start.
 */
export function calculateBreadthDivergence(breadthLine, benchmarkValues, { lookback = 60, minObservations = 40, nearEdge = 80, minimumGap = 20 } = {}) {
  const breadth = (breadthLine ?? []).filter(Number.isFinite).slice(-lookback);
  const price = (benchmarkValues ?? []).filter(Number.isFinite).slice(-lookback);
  const observations = Math.min(breadth.length, price.length);
  if (observations < minObservations) {
    return { status: 'unavailable', reason: `Needs ${minObservations} aligned sessions of advance/decline and index history.`, observations };
  }
  const breadthWindow = breadth.slice(-observations);
  const priceWindow = price.slice(-observations);
  const pricePercentile = percentileRank(priceWindow, priceWindow.at(-1));
  const breadthPercentile = percentileRank(breadthWindow, breadthWindow.at(-1));
  // A window with no range cannot place today inside it. Left unguarded, null
  // failed the ">= 80" test and passed the "<= 20" one, so an index that had
  // gone nowhere reported "Breadth confirms the low" - a bearish reading
  // manufactured out of the absence of data.
  if (!Number.isFinite(pricePercentile) || !Number.isFinite(breadthPercentile)) {
    return {
      status: 'unavailable',
      reason: `Neither leg can be ranked: the ${observations}-session window shows no range in ${!Number.isFinite(pricePercentile) ? 'the index' : 'the advance/decline line'}.`,
      observations,
      pricePercentile,
      breadthPercentile,
    };
  }
  const gap = pricePercentile - breadthPercentile;
  const lowEdge = 100 - nearEdge;

  let state;
  if (pricePercentile >= nearEdge) state = gap >= minimumGap ? 'Negative divergence' : 'Breadth confirms the high';
  else if (pricePercentile <= lowEdge) state = gap <= -minimumGap ? 'Positive divergence' : 'Breadth confirms the low';
  else state = 'No divergence signal';

  const reads = {
    'Negative divergence': `The index sits in the ${ordinal(pricePercentile)} percentile of its ${observations}-session range while the advance/decline line is only in the ${ordinal(breadthPercentile)}: fewer names are carrying the advance.`,
    'Breadth confirms the high': `The index is in the ${ordinal(pricePercentile)} percentile of its ${observations}-session range and the advance/decline line is in the ${ordinal(breadthPercentile)}, so participation is coming with it.`,
    'Positive divergence': `The index sits in the ${ordinal(pricePercentile)} percentile of its ${observations}-session range while the advance/decline line holds the ${ordinal(breadthPercentile)}: fewer names are making the new lows.`,
    'Breadth confirms the low': `The index is in the ${ordinal(pricePercentile)} percentile of its ${observations}-session range and the advance/decline line is in the ${ordinal(breadthPercentile)}, so the decline is broad.`,
    'No divergence signal': `The index is mid-range at the ${ordinal(pricePercentile)} percentile of its ${observations} sessions, where a divergence against breadth carries no reliable message.`,
  };

  return {
    status: 'calculated',
    lookback: observations,
    observations,
    pricePercentile,
    breadthPercentile,
    gap,
    state,
    divergent: state === 'Negative divergence' || state === 'Positive divergence',
    read: reads[state],
  };
}

/**
 * Correlation of an ETF's daily changes against each macro driver, with what
 * stands behind the number. The window is 60 aligned observations, and those
 * are only 60 sessions when both legs publish daily: against a weekly series
 * such as NFCI the same window spans more than a year, and labelling both "60D"
 * misreads the slower one by a factor of seven.
 */
export function calculateMacroSensitivities(points, macroSeries) {
  const measure = (history) => {
    if (!history?.length) {
      return { correlation: null, observations: 0, cadenceDays: null, windowLabel: null, asOf: null, status: 'unavailable', reason: 'No driver history.' };
    }
    const result = calculateChangeCorrelations(points, history);
    const correlation = result?.correlations?.['60D'];
    const cadenceDays = result?.leadLag?.barDays ?? null;
    const windowLabel = !Number.isFinite(cadenceDays) ? '60 aligned observations'
      : cadenceDays <= 2 ? '60 sessions'
        : cadenceDays <= 10 ? `60 observations, about ${Math.round((60 * cadenceDays) / 7)} weeks`
          : `60 observations, about ${Math.round(60 * cadenceDays)} days`;
    return {
      correlation: Number.isFinite(correlation) ? correlation : null,
      observations: result?.observations ?? 0,
      cadenceDays: Number.isFinite(cadenceDays) ? cadenceDays : null,
      windowLabel: Number.isFinite(correlation) ? windowLabel : null,
      asOf: result?.asOf ?? null,
      // A driver that only publishes weekly is not directly comparable with a
      // daily one over the same count of observations.
      daily: Number.isFinite(cadenceDays) ? cadenceDays <= 2 : null,
      status: Number.isFinite(correlation) ? 'calculated' : 'unavailable',
      reason: Number.isFinite(correlation) ? null : 'Fewer than 60 aligned changes against this driver.',
    };
  };
  const detail = {
    dollar: measure(macroSeries.dollar),
    realYield: measure(macroSeries.realYield),
    vix: measure(macroSeries.vix),
    credit: measure(macroSeries.credit),
  };
  return {
    dollar: detail.dollar.correlation,
    realYield: detail.realYield.correlation,
    vix: detail.vix.correlation,
    credit: detail.credit.correlation,
    detail,
  };
}

// Below this a spread is noise rather than leadership.
const BASKET_SPREAD_MINIMUM = 1;

export function calculateBasketRotation(pairs, historiesBySymbol) {
  const normalizedBySymbol = new Map([...historiesBySymbol.entries()].map(([symbol, points]) => {
    const normalized = normalizeHistory(points ?? []);
    return [symbol, new Map(normalized.map((point) => [point.date, point.value]))];
  }));

  const calculated = pairs.map((pair) => {
    const collectDates = (symbols) => {
      const maps = symbols.map((symbol) => normalizedBySymbol.get(symbol)).filter(Boolean);
      if (maps.length !== symbols.length) return null;
      const first = maps[0];
      const rest = maps.slice(1);
      return [...first.keys()].filter((date) => rest.every((map) => map.has(date))).sort();
    };
    const leftDates = collectDates(pair.leftSymbols);
    const rightDates = collectDates(pair.rightSymbols);
    if (!leftDates || !rightDates) {
      return { key: pair.key, left: pair.leftName, right: pair.rightName, status: 'unavailable', missing: [...pair.leftSymbols, ...pair.rightSymbols].filter((symbol) => !normalizedBySymbol.get(symbol)?.size) };
    }
    const sharedDates = new Set(leftDates.filter((date) => rightDates.includes(date)));
    const dates = [...sharedDates].sort();
    if (dates.length < 65) {
      return { key: pair.key, left: pair.leftName, right: pair.rightName, status: 'unavailable', missing: ['At least 65 synchronized sessions'] };
    }

    const basketReturn = (symbols, periods) => {
      const memberReturns = symbols.map((symbol) => {
        const map = normalizedBySymbol.get(symbol);
        const start = map.get(dates.at(-(periods + 1)));
        const end = map.get(dates.at(-1));
        return start > 0 ? ((end / start) - 1) * 100 : null;
      });
      const usable = memberReturns.filter(Number.isFinite);
      return usable.length === symbols.length ? mean(usable) : null;
    };

    const buildSide = (symbols) => ({
      return20: basketReturn(symbols, 20),
      return60: basketReturn(symbols, 60),
    });
    const left = buildSide(pair.leftSymbols);
    const right = buildSide(pair.rightSymbols);
    const spread20 = Number.isFinite(left.return20) && Number.isFinite(right.return20) ? left.return20 - right.return20 : null;
    const spread60 = Number.isFinite(left.return60) && Number.isFinite(right.return60) ? left.return60 - right.return60 : null;
    if (!Number.isFinite(spread20) || !Number.isFinite(spread60)) {
      return { key: pair.key, left: pair.leftName, right: pair.rightName, status: 'unavailable', missing: ['Synchronized price history for every basket member'] };
    }
    // Both horizons are measured, so both should be reported. Naming the
    // leader from the 60-session spread alone hid a live handoff: a basket
    // ahead by two points over 60 sessions but behind by two over 20 read as
    // plainly "leading" while the recent tape said the opposite.
    const decisive = (value) => Math.abs(value) >= BASKET_SPREAD_MINIMUM;
    const sideFor = (value) => (value >= 0 ? pair.leftLeader : pair.rightLeader);
    const established = sideFor(spread60);
    const recent = sideFor(spread20);
    const rotating = decisive(spread20) && decisive(spread60) && established !== recent;

    let regime;
    let leader;
    if (!decisive(spread20) && !decisive(spread60)) {
      regime = 'Balanced';
      leader = null;
    } else if (rotating) {
      regime = `${established} leading, ${recent} taking over`;
      leader = established;
    } else {
      leader = decisive(spread60) ? established : recent;
      regime = `${leader} leading`;
    }

    return {
      key: pair.key,
      left: pair.leftName,
      right: pair.rightName,
      status: 'calculated',
      asOf: dates.at(-1),
      observations: dates.length,
      spread20,
      spread60,
      leader,
      established: decisive(spread60) ? established : null,
      emerging: rotating ? recent : null,
      rotating,
      regime,
      read: regime === 'Balanced'
        ? `Neither basket leads by more than ${BASKET_SPREAD_MINIMUM} point over either window.`
        : rotating
          ? `${established} leads by ${Math.abs(spread60).toFixed(1)} points over 60 sessions, but ${recent} is ahead by ${Math.abs(spread20).toFixed(1)} over the last 20 — the leadership is changing hands.`
          : `${leader} leads by ${Math.abs(decisive(spread60) ? spread60 : spread20).toFixed(1)} points, with both windows pointing the same way.`,
    };
  });

  const calculatedCount = calculated.filter((pair) => pair.status === 'calculated').length;
  return {
    version: 'style-rotation-v1',
    status: calculatedCount ? 'calculated' : 'unavailable',
    ...resolveVintage(calculated.map((pair) => ({ name: pair.left ?? pair.key, asOf: pair.asOf }))),
    pairs: calculated,
    methodology: `Equal-weight basket returns over 20 and 60 synchronized sessions; the spread is left-basket minus right-basket return. A spread inside ${BASKET_SPREAD_MINIMUM} point either way is treated as noise. Leadership is named from the 60-session spread, but when the 20-session spread is decisively the other way the pair is reported as changing hands rather than as the older window alone would have it.`,
  };
}

const ROTATION_LOOKBACK_SESSIONS = 20;
// Five points spaced a lookback apart: the current position and four behind it.
const ROTATION_TRAIL_POINTS = 5;

/**
 * Relative-rotation quadrant. The 60-session excess return stands for how
 * strong a sector already is against the benchmark, the 20-session one for
 * whether that strength is currently building.
 */
export function rrgQuadrant(relative20, relative60) {
  if (!Number.isFinite(relative20) || !Number.isFinite(relative60)) return null;
  if (relative60 >= 0) return relative20 >= 0 ? 'Leading' : 'Weakening';
  return relative20 >= 0 ? 'Improving' : 'Lagging';
}

export function calculateSectorRotation(sectors, benchmarkPoints) {
  const benchmark = normalizeHistory(benchmarkPoints ?? []);
  if (benchmark.length < 65) return { version: 'sector-rotation-v1', status: 'unavailable', asOf: null, sectors: [], missing: ['Benchmark history'] };
  const benchmarkByDate = new Map(benchmark.map((point) => [point.date, point.value]));
  const calculated = sectors.flatMap((sector) => {
    const points = normalizeHistory(sector.points ?? []);
    if (points.length < 65) return [];
    const aligned = points.filter((point) => benchmarkByDate.has(point.date));
    if (aligned.length < 61) return [];
    const alignedSectorValues = aligned.map((point) => point.value);
    const alignedBenchmarkValues = aligned.map((point) => benchmarkByDate.get(point.date));
    const technical = calculateTechnicalSnapshot(points.map((point) => ({ timestamp: `${point.date}T00:00:00.000Z`, value: point.value })));
    if (!technical) return [];
    const return20 = percentChange(alignedSectorValues, 20);
    const return60 = percentChange(alignedSectorValues, 60);
    const benchmark20 = percentChange(alignedBenchmarkValues, 20);
    const benchmark60 = percentChange(alignedBenchmarkValues, 60);
    // percentChange refuses an unusable base by returning null, and `null - 5`
    // is -5 in JavaScript rather than an error - so a sector whose provider
    // returned zeros published the exact negation of the benchmark's return as
    // its own excess, a plausible number with nothing behind it. The trail
    // below already checked its four legs; the current position did not.
    if (![return20, return60, benchmark20, benchmark60].every(Number.isFinite)) return [];
    const relative20 = return20 - benchmark20;
    const relative60 = return60 - benchmark60;
    const relativeScore = clamp(50 + (relative20 * 6) + (relative60 * 2));
    const score = Math.round((technical.score * 0.55) + (relativeScore * 0.45));
    const quadrant = rrgQuadrant(relative20, relative60);
    // Where the sector sat at each earlier step, so the tape shows the arc a
    // sector travelled rather than only the point it currently occupies. One
    // prior reading cannot separate a sector arriving in leadership from one
    // that has been circling its edge for a quarter.
    const positionAt = (sessionsAgo) => {
      if (sessionsAgo && aligned.length <= 60 + sessionsAgo) return null;
      const sectorPast = sessionsAgo ? alignedSectorValues.slice(0, -sessionsAgo) : alignedSectorValues;
      const benchmarkPast = sessionsAgo ? alignedBenchmarkValues.slice(0, -sessionsAgo) : alignedBenchmarkValues;
      const past20 = percentChange(sectorPast, 20);
      const past60 = percentChange(sectorPast, 60);
      const base20 = percentChange(benchmarkPast, 20);
      const base60 = percentChange(benchmarkPast, 60);
      if (![past20, past60, base20, base60].every(Number.isFinite)) return null;
      const excess20 = past20 - base20;
      const excess60 = past60 - base60;
      const pastQuadrant = rrgQuadrant(excess20, excess60);
      return pastQuadrant
        ? {
          sessionsAgo,
          date: aligned.at(sessionsAgo ? -(sessionsAgo + 1) : -1).date,
          relative20: Math.round(excess20 * 100) / 100,
          relative60: Math.round(excess60 * 100) / 100,
          quadrant: pastQuadrant,
        }
        : null;
    };
    // Oldest first, so the trail reads left to right the way it happened.
    const trail = Array.from({ length: ROTATION_TRAIL_POINTS }, (_, step) => positionAt((ROTATION_TRAIL_POINTS - 1 - step) * ROTATION_LOOKBACK_SESSIONS))
      .filter(Boolean);
    const previous = positionAt(ROTATION_LOOKBACK_SESSIONS);
    const relativeShift = previous ? relative20 - previous.relative20 : null;
    const rotation = previous ? {
      lookbackSessions: ROTATION_LOOKBACK_SESSIONS,
      previousQuadrant: previous.quadrant,
      quadrant,
      moved: previous.quadrant !== quadrant,
      path: previous.quadrant === quadrant ? `Holding ${quadrant}` : `${previous.quadrant} → ${quadrant}`,
      relativeShift: Math.round(relativeShift * 100) / 100,
      direction: Math.abs(relativeShift) < 0.5 ? 'Flat' : relativeShift > 0 ? 'Strengthening' : 'Fading',
      trail,
      trailSpansSessions: trail.length > 1 ? (trail.length - 1) * ROTATION_LOOKBACK_SESSIONS : 0,
      quadrantsVisited: [...new Set(trail.map((point) => point.quadrant))].length,
    } : null;
    return [{
      symbol: sector.symbol,
      name: sector.name,
      group: sector.group ?? null,
      asOf: points.at(-1).date,
      score,
      quadrant,
      return20,
      return60,
      relative20,
      relative60,
      trend: technical.regime,
      technicalScore: technical.score,
      observations: points.length,
      rotation,
    }];
  }).sort((left, right) => right.score - left.score).map((sector, index) => ({ ...sector, rank: index + 1 }));

  return {
    version: 'sector-rotation-v1',
    status: calculated.length >= Math.ceil(sectors.length * 0.7) ? 'calculated' : calculated.length ? 'partial' : 'unavailable',
    ...resolveVintage(calculated.map((sector) => ({ name: sector.symbol ?? sector.name, asOf: sector.asOf }))),
    benchmark: 'SPY',
    methodology: `20- and 60-session total-price momentum relative to SPY, combined with technical-v1. The relative-rotation quadrant reads the 60-session excess return as how strong a sector already is and the 20-session one as whether that strength is building. Each sector is also placed where it sat ${ROTATION_LOOKBACK_SESSIONS} sessions ago, so a sector rotating into leadership is distinguishable from one rolling out of it; the shift is the change in 20-session excess return over that window. A trail of up to ${ROTATION_TRAIL_POINTS} points spaced ${ROTATION_LOOKBACK_SESSIONS} sessions apart carries the arc it travelled, oldest first; points the history cannot reach back far enough to place are dropped rather than repeated.`,
    rotationLookbackSessions: ROTATION_LOOKBACK_SESSIONS,
    enteringLeadership: calculated.filter((sector) => sector.rotation?.moved && sector.quadrant === 'Leading').map((sector) => sector.symbol),
    leavingLeadership: calculated.filter((sector) => sector.rotation?.moved && sector.rotation.previousQuadrant === 'Leading').map((sector) => sector.symbol),
    sectors: calculated,
    missing: calculated.length < sectors.length ? [`${sectors.length - calculated.length} sector histories`] : [],
  };
}

/**
 * How much of the tape is one trade. Two independent readings answer that: the
 * average pairwise correlation of daily sector changes, and the cross-sectional
 * spread of their returns. High correlation with low dispersion is a market
 * moving on a single macro factor, where sector selection buys almost nothing;
 * low correlation with wide dispersion is a market where it buys a great deal.
 *
 * Both are ranked against their own trailing history rather than against fixed
 * thresholds, because the baseline level of correlation drifts with the regime.
 */
export function calculateSectorDispersion(sectors, benchmarkPoints, { window = 60, returnWindow = 20, rankWindow = 252, minimumSectors = 5 } = {}) {
  const version = 'sector-dispersion-v1';
  const normalized = (sectors ?? [])
    .map((sector) => ({ symbol: sector.symbol, name: sector.name, points: normalizeHistory(sector.points ?? []) }))
    .filter((sector) => sector.points.length > window);
  if (normalized.length < minimumSectors) {
    return { version, status: 'unavailable', reason: `Needs ${minimumSectors} sector histories of more than ${window} sessions; ${normalized.length} available.`, sectors: normalized.length };
  }

  // Only dates every sector shares, so a correlation is never computed across a
  // gap one member had and the others did not.
  const valueMaps = normalized.map((sector) => new Map(sector.points.map((point) => [point.date, point.value])));
  const dates = [...valueMaps[0].keys()].filter((date) => valueMaps.every((map) => map.has(date))).sort();
  if (dates.length < window + 2) {
    return { version, status: 'unavailable', reason: `Needs ${window + 2} sessions shared by every sector; ${dates.length} available.`, sectors: normalized.length };
  }

  const changesBySector = valueMaps.map((map) => dates.slice(1).map((date, index) => {
    const previous = map.get(dates[index]);
    const current = map.get(date);
    return previous > 0 ? ((current / previous) - 1) * 100 : null;
  }));

  const meanPairwiseCorrelation = (endExclusive) => {
    const slices = changesBySector.map((changes) => changes.slice(endExclusive - window, endExclusive).filter(Number.isFinite));
    if (slices.some((slice) => slice.length < window)) return null;
    const correlations = [];
    for (let left = 0; left < slices.length; left += 1) {
      for (let right = left + 1; right < slices.length; right += 1) {
        const value = pearson(slices[left], slices[right]);
        if (Number.isFinite(value)) correlations.push(value);
      }
    }
    return correlations.length ? mean(correlations) : null;
  };

  const totalChanges = changesBySector[0].length;
  const correlation = meanPairwiseCorrelation(totalChanges);
  if (correlation === null) {
    return { version, status: 'unavailable', reason: 'Not enough overlapping daily changes to correlate every sector pair.', sectors: normalized.length };
  }
  const rollingCorrelations = [];
  for (let end = window; end <= totalChanges; end += 1) {
    if (end < totalChanges - rankWindow) continue;
    const value = meanPairwiseCorrelation(end);
    if (Number.isFinite(value)) rollingCorrelations.push(value);
  }

  const sectorReturns = normalized.map((sector, index) => {
    const map = valueMaps[index];
    const start = map.get(dates.at(-(returnWindow + 1)));
    const end = map.get(dates.at(-1));
    return { symbol: sector.symbol, name: sector.name, return: start > 0 ? ((end / start) - 1) * 100 : null };
  });
  const usableReturns = sectorReturns.map((entry) => entry.return).filter(Number.isFinite);
  const dispersion = usableReturns.length >= minimumSectors ? standardDeviation(usableReturns) : null;

  const benchmark = normalizeHistory(benchmarkPoints ?? []);
  const benchmarkMap = new Map(benchmark.map((point) => [point.date, point.value]));
  const benchmarkStart = benchmarkMap.get(dates.at(-(returnWindow + 1)));
  const benchmarkEnd = benchmarkMap.get(dates.at(-1));
  const benchmarkReturn = Number.isFinite(benchmarkStart) && benchmarkStart > 0 && Number.isFinite(benchmarkEnd)
    ? ((benchmarkEnd / benchmarkStart) - 1) * 100
    : null;
  const beating = benchmarkReturn === null
    ? null
    : sectorReturns.filter((entry) => Number.isFinite(entry.return) && entry.return > benchmarkReturn).length;
  const leadershipBreadth = beating === null ? null : Math.round((beating / usableReturns.length) * 100);

  const correlationPercentile = rollingCorrelations.length >= 40 ? percentileRank(rollingCorrelations, correlation) : null;
  const ranked = [...sectorReturns].filter((entry) => Number.isFinite(entry.return)).sort((left, right) => right.return - left.return);
  const highCorrelation = correlationPercentile === null ? correlation >= 0.7 : correlationPercentile >= 70;
  const lowCorrelation = correlationPercentile === null ? correlation <= 0.4 : correlationPercentile <= 30;
  const regime = highCorrelation ? 'One macro trade'
    : lowCorrelation ? "Stock-picker's tape"
      : 'Mixed';

  return {
    version,
    status: correlationPercentile === null || dispersion === null ? 'provisional' : 'calculated',
    asOf: dates.at(-1),
    sectors: normalized.length,
    observations: dates.length,
    window,
    returnWindow,
    correlation: Math.round(correlation * 1000) / 1000,
    correlationPercentile,
    rankedAgainst: rollingCorrelations.length,
    dispersion: dispersion === null ? null : Math.round(dispersion * 100) / 100,
    spread: ranked.length ? Math.round((ranked[0].return - ranked.at(-1).return) * 100) / 100 : null,
    leader: ranked[0] ?? null,
    laggard: ranked.at(-1) ?? null,
    benchmarkReturn: benchmarkReturn === null ? null : Math.round(benchmarkReturn * 100) / 100,
    sectorsBeatingBenchmark: beating,
    leadershipBreadth,
    regime,
    read: `Sectors move together at an average pairwise correlation of ${correlation.toFixed(2)}${correlationPercentile === null ? '' : `, the ${ordinal(correlationPercentile)} percentile of the last ${rollingCorrelations.length} readings`}${dispersion === null ? '' : `, and ${returnWindow}-session sector returns scattered ${dispersion.toFixed(1)} points either side of their average`}. ${regime === 'One macro trade' ? 'Sector selection is buying little here — the index is the trade.' : regime === "Stock-picker's tape" ? 'Sectors are moving on their own drivers, so selection carries real weight.' : 'Neither a single macro factor nor genuinely independent sectors.'}${leadershipBreadth === null ? '' : ` ${beating} of ${usableReturns.length} sectors are ahead of the benchmark over ${returnWindow} sessions.`}`,
    methodology: `Average pairwise Pearson correlation of daily percentage changes across every sector pair over ${window} sessions shared by all of them, ranked against its own last ${rankWindow} rolling readings. Dispersion is the standard deviation of ${returnWindow}-session sector returns. The regime is read from the correlation percentile rather than a fixed level, because the baseline drifts between regimes; with too little history to rank, it falls back to absolute thresholds and reports as provisional.`,
  };
}

/**
 * Where the index sits inside its own drawdown history: how far below the
 * running peak, how long it has been there, and how that depth ranks against
 * every drawdown the available history contains.
 */
export function calculateDrawdownProfile(points, { minimumObservations = 250 } = {}) {
  const version = 'equity-drawdown-profile-v1';
  const history = normalizeHistory(points ?? []);
  if (history.length < minimumObservations) {
    return { version, status: 'unavailable', reason: `Needs ${minimumObservations} sessions to rank a drawdown against its own history; ${history.length} available.`, observations: history.length };
  }

  // A drawdown is a ratio to a running peak, so it means nothing on a series
  // that reaches zero or goes negative - and a zero peak makes it NaN, which
  // reached both the published percentage and the sentence describing it.
  const nonPositive = history.filter((point) => point.value <= 0).length;
  if (nonPositive) {
    return {
      version,
      status: 'unavailable',
      reason: `Drawdown is measured against a running peak, which requires positive closes; ${nonPositive} of ${history.length} observations are zero or negative.`,
      observations: history.length,
    };
  }

  let peak = -Infinity;
  let peakDate = null;
  const drawdowns = history.map((point) => {
    if (point.value > peak) {
      peak = point.value;
      peakDate = point.date;
    }
    return { date: point.date, drawdown: ((point.value / peak) - 1) * 100, peak, peakDate };
  });

  // Each completed episode: from the session the index left its peak to the one
  // it regained it. An episode still open is reported separately rather than
  // being counted as if it had already recovered.
  const episodes = [];
  let open = null;
  drawdowns.forEach((entry, index) => {
    if (entry.drawdown < 0 && !open) {
      open = { peakDate: entry.peakDate, startIndex: index, trough: entry.drawdown, troughDate: entry.date };
    } else if (open) {
      if (entry.drawdown < open.trough) {
        open.trough = entry.drawdown;
        open.troughDate = entry.date;
      }
      if (entry.drawdown >= 0) {
        episodes.push({ ...open, recoveredOn: entry.date, sessions: index - open.startIndex, recovered: true });
        open = null;
      }
    }
  });

  const current = drawdowns.at(-1);
  const sessionsSincePeak = drawdowns.length - 1 - drawdowns.findIndex((entry) => entry.date === current.peakDate);
  const completedTroughs = episodes.map((episode) => episode.trough);
  const deepest = episodes.length ? episodes.reduce((worst, episode) => (episode.trough < worst.trough ? episode : worst)) : null;
  const longest = episodes.length ? episodes.reduce((slowest, episode) => (episode.sessions > slowest.sessions ? episode : slowest)) : null;
  // Rank against every session's drawdown, so "how unusual is today" is answered
  // by the whole distribution rather than by the handful of completed episodes.
  const depthPercentile = percentileRank(drawdowns.map((entry) => entry.drawdown), current.drawdown);
  const underwaterShare = Math.round((drawdowns.filter((entry) => entry.drawdown < -1e-9).length / drawdowns.length) * 100);

  const state = current.drawdown >= -1 ? 'At the highs'
    : current.drawdown >= -5 ? 'Shallow pullback'
      : current.drawdown >= -10 ? 'Correction'
        : current.drawdown >= -20 ? 'Deep correction'
          : 'Bear-market drawdown';

  return {
    version,
    status: 'calculated',
    asOf: current.date,
    observations: history.length,
    drawdownPercent: Math.round(current.drawdown * 100) / 100,
    peak: Math.round(current.peak * 100) / 100,
    peakDate: current.peakDate,
    sessionsSincePeak,
    state,
    depthPercentile,
    underwaterSharePercent: underwaterShare,
    completedEpisodes: episodes.length,
    medianCompletedTrough: completedTroughs.length ? Math.round(median(completedTroughs) * 100) / 100 : null,
    deepest: deepest ? { trough: Math.round(deepest.trough * 100) / 100, troughDate: deepest.troughDate, peakDate: deepest.peakDate, recoverySessions: deepest.sessions } : null,
    slowestRecovery: longest ? { trough: Math.round(longest.trough * 100) / 100, sessions: longest.sessions, peakDate: longest.peakDate } : null,
    inDrawdown: current.drawdown < -1e-9,
    read: current.drawdown >= -1e-9
      ? `The index closed at a new high for this ${history.length}-session window, which has spent ${underwaterShare}% of its sessions below a prior peak.`
      : `${state}: ${Math.abs(current.drawdown).toFixed(1)}% below the ${current.peakDate} peak after ${sessionsSincePeak} ${sessionsSincePeak === 1 ? 'session' : 'sessions'}, deeper than ${depthPercentile}% of the sessions in this history.${deepest ? ` The worst completed episode here fell ${Math.abs(deepest.trough).toFixed(1)}% and took ${deepest.sessions} ${deepest.sessions === 1 ? 'session' : 'sessions'} to recover.` : ''}`,
    methodology: 'Drawdown is measured against the running peak of the available history, so it is window-dependent and states its window. A completed episode runs from the session the index left a peak to the session it regained it; an episode still open is reported as the current drawdown rather than counted among the completed ones. The depth percentile ranks today against every session in the history, not against the handful of completed episodes, which are too few to rank against.',
  };
}

/**
 * Up and down capture against the benchmark, plus how stable the relationship
 * is. A sector labelled defensive in a catalog is a claim; capture measured on
 * the days the benchmark actually fell is evidence. Beta is reported split by
 * direction and with the dispersion of its own rolling estimates, because a
 * single full-window beta hides a relationship that changed halfway through.
 */
export function calculateCaptureProfile(sectorPoints, benchmarkPoints, { window = 252, rollingWindow = 60, minimumDays = 20 } = {}) {
  const version = 'equity-capture-profile-v1';
  const sector = normalizeHistory(sectorPoints ?? []);
  const benchmark = normalizeHistory(benchmarkPoints ?? []);
  const benchmarkByDate = new Map(benchmark.map((point) => [point.date, point.value]));
  const aligned = sector.filter((point) => benchmarkByDate.has(point.date));
  if (aligned.length < minimumDays * 3) {
    return { version, status: 'unavailable', reason: `Needs ${minimumDays * 3} sessions shared with the benchmark; ${aligned.length} available.`, observations: aligned.length };
  }

  const slice = aligned.slice(-(window + 1));
  const returns = slice.slice(1).map((point, index) => {
    const previous = slice[index];
    const sectorReturn = previous.value > 0 ? ((point.value / previous.value) - 1) * 100 : null;
    const benchmarkPrevious = benchmarkByDate.get(previous.date);
    const benchmarkCurrent = benchmarkByDate.get(point.date);
    const benchmarkReturn = benchmarkPrevious > 0 ? ((benchmarkCurrent / benchmarkPrevious) - 1) * 100 : null;
    return Number.isFinite(sectorReturn) && Number.isFinite(benchmarkReturn) ? { sector: sectorReturn, benchmark: benchmarkReturn } : null;
  }).filter(Boolean);

  const upDays = returns.filter((entry) => entry.benchmark > 0);
  const downDays = returns.filter((entry) => entry.benchmark < 0);
  // Capture is only meaningful with enough days on that side of the tape; a
  // capture ratio built on four down days is arithmetic, not evidence.
  const capture = (days) => {
    if (days.length < minimumDays) return null;
    const benchmarkAverage = mean(days.map((entry) => entry.benchmark));
    return benchmarkAverage === 0 ? null : (mean(days.map((entry) => entry.sector)) / benchmarkAverage) * 100;
  };
  const upCapture = capture(upDays);
  const downCapture = capture(downDays);

  const betaOf = (days) => {
    if (days.length < minimumDays) return null;
    const benchmarkMean = mean(days.map((entry) => entry.benchmark));
    const sectorMean = mean(days.map((entry) => entry.sector));
    let covariance = 0;
    let variance = 0;
    days.forEach((entry) => {
      covariance += (entry.benchmark - benchmarkMean) * (entry.sector - sectorMean);
      variance += (entry.benchmark - benchmarkMean) ** 2;
    });
    return variance ? covariance / variance : null;
  };
  const beta = betaOf(returns);
  const upBeta = betaOf(upDays);
  const downBeta = betaOf(downDays);

  const rollingBetas = [];
  for (let end = rollingWindow; end <= returns.length; end += 1) {
    const value = betaOf(returns.slice(end - rollingWindow, end));
    if (Number.isFinite(value)) rollingBetas.push(value);
  }
  const betaDispersion = rollingBetas.length >= 5 ? standardDeviation(rollingBetas) : null;
  const betaRange = rollingBetas.length >= 5 ? { low: Math.min(...rollingBetas), high: Math.max(...rollingBetas) } : null;

  // A negative capture means the sector moves against the benchmark, not that
  // it defends. Reading "down capture below 85" without checking the sign
  // labelled an inverse relationship - one that rallies hard as the benchmark
  // falls - as Defensive, which is the opposite of what it is.
  const inverse = (upCapture !== null && upCapture < 0) || (downCapture !== null && downCapture < 0);
  const behaviour = upCapture === null || downCapture === null ? null
    : inverse ? 'Inverse to the benchmark'
      : downCapture < 85 && upCapture >= 85 ? 'Defends and participates'
        : downCapture < 85 ? 'Defensive'
          : upCapture > 110 && downCapture > 110 ? 'High beta'
            : upCapture < 85 && downCapture > 110 ? 'Worst of both'
              : 'Tracks the benchmark';

  const stability = betaDispersion === null ? null
    : betaDispersion <= 0.1 ? 'Stable'
      : betaDispersion <= 0.25 ? 'Drifting'
        : 'Unstable';

  return {
    version,
    status: upCapture === null || downCapture === null ? 'provisional' : betaDispersion === null ? 'provisional' : 'calculated',
    asOf: slice.at(-1).date,
    observations: returns.length,
    upDays: upDays.length,
    downDays: downDays.length,
    upCapture: upCapture === null ? null : Math.round(upCapture),
    downCapture: downCapture === null ? null : Math.round(downCapture),
    captureSpread: upCapture === null || downCapture === null ? null : Math.round(upCapture - downCapture),
    beta: beta === null ? null : Math.round(beta * 100) / 100,
    upBeta: upBeta === null ? null : Math.round(upBeta * 100) / 100,
    downBeta: downBeta === null ? null : Math.round(downBeta * 100) / 100,
    betaDispersion: betaDispersion === null ? null : Math.round(betaDispersion * 1000) / 1000,
    betaRange: betaRange ? { low: Math.round(betaRange.low * 100) / 100, high: Math.round(betaRange.high * 100) / 100 } : null,
    rollingWindows: rollingBetas.length,
    behaviour,
    inverse,
    stability,
    read: behaviour === null
      ? `Fewer than ${minimumDays} days on one side of the benchmark, so capture cannot be measured yet.`
      : `${behaviour}: ${Math.round(upCapture)}% of the benchmark's average up day across ${upDays.length} of them, ${Math.round(downCapture)}% of its average down day across ${downDays.length}.${inverse ? ' A negative ratio means it moves against the benchmark rather than defending inside it.' : ''}${stability ? ` Rolling ${rollingWindow}-session beta is ${stability.toLowerCase()}, ranging ${betaRange.low} to ${betaRange.high}.` : ''}`,
    methodology: `Up capture is the sector's average return on days the benchmark rose, divided by the benchmark's average return on those same days; down capture is the mirror. Each side needs ${minimumDays} days of its own before it publishes, so a quiet window reports nothing rather than a ratio built on a handful of sessions. Beta is reported for the whole window and separately for up and down days, alongside the standard deviation and range of rolling ${rollingWindow}-session estimates - a single number hides a relationship that changed inside the window. A negative capture ratio is an inverse relationship, reported as such rather than folded into the defensive band.`,
  };
}

const VOLATILITY_WINDOWS = [20, 60, 252];

/**
 * Realized volatility across three horizons, each ranked against its own past.
 * One 20-day number cannot say whether a market is calm or merely between
 * shocks; the term structure can, because a short window above a long one is a
 * different regime from the reverse.
 */
export function calculateVolatilityTermStructure(points, { windows = VOLATILITY_WINDOWS, rankWindow = 756, annualizationDays = 252 } = {}) {
  const version = 'equity-volatility-term-v1';
  const history = normalizeHistory(points ?? []);
  const longest = Math.max(...windows);
  if (history.length < longest + 2) {
    return { version, status: 'unavailable', reason: `Needs ${longest + 2} sessions for a ${longest}-session window; ${history.length} available.`, observations: history.length, terms: [] };
  }
  const values = history.map((point) => point.value);
  const logReturns = values.slice(1).map((value, index) => (values[index] > 0 && value > 0 ? Math.log(value / values[index]) : null));

  const annualized = (endExclusive, size) => {
    const slice = logReturns.slice(endExclusive - size, endExclusive).filter(Number.isFinite);
    if (slice.length < size) return null;
    const sigma = standardDeviation(slice);
    return sigma === null ? null : sigma * Math.sqrt(annualizationDays) * 100;
  };

  const rawByWindow = new Map();
  const terms = windows.map((size) => {
    const current = annualized(logReturns.length, size);
    rawByWindow.set(size, current);
    const rolling = [];
    for (let end = size; end <= logReturns.length; end += 1) {
      if (end < logReturns.length - rankWindow) continue;
      const value = annualized(end, size);
      if (Number.isFinite(value)) rolling.push(value);
    }
    return {
      window: size,
      annualizedPercent: current === null ? null : Math.round(current * 10) / 10,
      percentile: rolling.length >= 60 ? percentileRank(rolling, current) : null,
      rankedAgainst: rolling.length,
      status: current === null ? 'unavailable' : rolling.length >= 60 ? 'calculated' : 'provisional',
    };
  });

  const published = terms.filter((term) => Number.isFinite(term.annualizedPercent));
  if (!published.length) {
    return { version, status: 'unavailable', reason: 'No volatility window could be filled from the available history.', observations: history.length, terms };
  }
  const short = terms.find((term) => term.window === Math.min(...windows));
  const long = terms.find((term) => term.window === Math.max(...windows));
  // Built from the measured volatilities, not the values rounded for display: a
  // genuinely quiet market whose long window rounds to 0.0% would otherwise
  // lose its term structure entirely to a divide-by-zero guard.
  const rawShort = rawByWindow.get(short?.window);
  const rawLong = rawByWindow.get(long?.window);
  const ratio = Number.isFinite(rawShort) && Number.isFinite(rawLong) && rawLong > 0
    ? rawShort / rawLong
    : null;
  const slope = ratio === null ? null : ratio >= 1.2 ? 'inverted' : ratio <= 0.8 ? 'upward' : 'flat';
  const state = slope === null ? null
    : slope === 'inverted' ? 'Shock in progress'
      : slope === 'upward' ? 'Calm relative to its own year'
        : 'Volatility in line with its own year';

  return {
    version,
    status: terms.every((term) => term.status === 'calculated') ? 'calculated' : published.length ? 'provisional' : 'unavailable',
    asOf: history.at(-1).date,
    observations: history.length,
    terms,
    ratio: ratio === null ? null : Math.round(ratio * 100) / 100,
    slope,
    state,
    read: state === null
      ? `Realized volatility publishes at ${published.map((term) => `${term.window}-session ${term.annualizedPercent}%`).join(', ')}, but the term structure needs both ends of the curve.`
      : `${state}: ${short.annualizedPercent}% over ${short.window} sessions against ${long.annualizedPercent}% over ${long.window}, a ${ratio.toFixed(2)} ratio.${Number.isFinite(short.percentile) ? ` The short window sits at the ${ordinal(short.percentile)} percentile of its own last ${short.rankedAgainst} readings.` : ''}`,
    methodology: `Annualized standard deviation of daily log returns over each window, each ranked against its own last ${rankWindow} rolling readings rather than against the other windows or a fixed level. The short-over-long ratio is the term structure: above 1.2 the near tape is more violent than its year, which is a shock in progress rather than a high-volatility regime; below 0.8 it is genuinely calmer than its own recent history.`,
  };
}

/**
 * Earnings-revision breadth: are analysts raising or cutting estimates, and
 * across how much of the universe. Nothing else in the equity section knows
 * anything about fundamentals, so this is the one leg that can disagree with
 * price for a reason other than positioning.
 *
 * Two readings, because they answer different questions. The diffusion index
 * is the share of names with more raises than cuts - how broad the revision is.
 * The aggregate ratio pools every revision - how large. A handful of megacaps
 * being raised hard while everything else is cut moves the second and not the
 * first, and that gap is the signal.
 */
export function calculateRevisionBreadth(rows, { requested = null, minimumCovered = 20 } = {}) {
  const version = 'equity-revision-breadth-v1';
  const covered = (rows ?? []).filter((row) => Number.isFinite(row?.up) && Number.isFinite(row?.down) && (row.up + row.down) > 0);
  const universe = requested ?? (rows ?? []).length;
  if (covered.length < minimumCovered) {
    return {
      version,
      status: 'unavailable',
      reason: `Needs ${minimumCovered} names carrying an analyst revision count; ${covered.length} of ${universe} available.`,
      covered: covered.length,
      universe,
      coverage: universe ? Math.round((covered.length / universe) * 100) : 0,
    };
  }

  const scored = covered.map((row) => ({
    symbol: row.symbol,
    name: row.name ?? row.symbol,
    up: row.up,
    down: row.down,
    net: Math.round((((row.up - row.down) / (row.up + row.down)) * 100) * 10) / 10,
  }));
  const raised = scored.filter((row) => row.net > 0).length;
  const cut = scored.filter((row) => row.net < 0).length;
  const diffusion = Math.round((raised / scored.length) * 100);
  const totalUp = scored.reduce((total, row) => total + row.up, 0);
  const totalDown = scored.reduce((total, row) => total + row.down, 0);
  const aggregate = Math.round((((totalUp - totalDown) / (totalUp + totalDown)) * 100) * 10) / 10;
  const coverage = universe ? Math.round((covered.length / universe) * 100) : 100;
  const ranked = [...scored].sort((left, right) => right.net - left.net);
  // Diffusion is a share of names, the aggregate a share of revisions, so the
  // two are not on one scale and cannot be differenced. What is meaningful is
  // whether they point opposite ways with real force behind the pooled number:
  // that is a few heavily covered names carrying the direction alone.
  const diffusionTilt = diffusion - 50;
  const narrow = Math.abs(aggregate) >= 10 && diffusionTilt !== 0 && (diffusionTilt > 0) !== (aggregate > 0);

  const state = diffusion >= 60 && aggregate > 0 ? 'Broad upgrades'
    : diffusion <= 40 && aggregate < 0 ? 'Broad downgrades'
      : aggregate > 10 ? 'Upgrades concentrated in a few names'
        : aggregate < -10 ? 'Downgrades concentrated in a few names'
          : 'Balanced';

  return {
    version,
    status: coverage >= 85 ? 'calculated' : 'provisional',
    covered: covered.length,
    universe,
    coverage,
    diffusion,
    aggregate,
    raised,
    cut,
    unchangedNames: scored.length - raised - cut,
    totalUp,
    totalDown,
    narrow,
    state,
    mostRaised: ranked.slice(0, 3),
    mostCut: ranked.slice(-3).reverse(),
    // Scored 0-100 on the same axis the other equity drivers use, so it can
    // join a weighted model without rescaling at the call site.
    score: Math.round(clamp(50 + (aggregate / 2))),
    read: `${state}: ${raised} of ${scored.length} names carry more raises than cuts (${diffusion}% diffusion) against a ${aggregate > 0 ? '+' : ''}${aggregate}% aggregate revision balance across ${totalUp + totalDown} revisions.${narrow ? ' The two disagree, which means a few heavily covered names are carrying the direction rather than the universe.' : ''}`,
    methodology: `Per name, revisions are netted as (raises - cuts) / (raises + cuts) over the provider's trailing revision window. Diffusion is the share of names with a positive net - how broad. The aggregate pools every revision across the universe - how large. A name with no revisions at all is excluded from both rather than counted as unchanged, because no coverage is not the same as no opinion. The model reports provisional below 85% universe coverage.`,
  };
}

/**
 * How far the index can travel over a horizon, and whether that band has
 * actually held.
 *
 * A one-sigma cone drawn from realised volatility is easy to publish and easy
 * to believe. The number that makes it research rather than decoration is the
 * second one: taking the same rule back through history - estimating from data
 * available at the time and checking where price actually landed - and
 * reporting how often it was right. A Gaussian band on daily equity returns is
 * expected to hold about 68% of the time and generally does not, because the
 * tails are fatter than the assumption, so a band that held 61% of the time is
 * the honest headline and the 68% is the claim being tested.
 *
 * Calibration windows are non-overlapping. Overlapping ones share most of
 * their observations, which inflates the sample count without adding
 * independent evidence and makes a thin study look settled.
 */
export function calculateExpectedMove(points, { horizons = [5, 21, 63], lookback = 252, minimumCalibrationSamples = 20 } = {}) {
  const version = 'equity-expected-move-v1';
  const history = normalizeHistory(points ?? []).filter((point) => point.value > 0);
  const longestHorizon = Math.max(...horizons);
  const required = lookback + longestHorizon;
  if (history.length < required) {
    return {
      version,
      status: 'unavailable',
      reason: `Needs ${lookback} sessions to estimate volatility plus ${longestHorizon} to test the band against; ${history.length} available.`,
      observations: history.length,
      horizons: [],
    };
  }

  const values = history.map((point) => point.value);
  const logReturns = values.slice(1).map((value, index) => Math.log(value / values[index]));

  /** Daily sigma from the `lookback` returns ending at `endIndex` (exclusive). */
  const sigmaEndingAt = (endIndex) => {
    const window = logReturns.slice(Math.max(0, endIndex - lookback), endIndex);
    return window.length >= Math.min(lookback, 60) ? standardDeviation(window) : null;
  };

  const latestSigma = sigmaEndingAt(logReturns.length);
  if (!Number.isFinite(latestSigma) || latestSigma <= 0) {
    return {
      version,
      status: 'unavailable',
      reason: 'Realised volatility over the estimation window is zero, so there is no band to draw.',
      observations: history.length,
      horizons: [],
    };
  }

  const spot = values.at(-1);
  const asOf = history.at(-1).date;

  // Excess kurtosis measures tail weight directly. The share of moves beyond
  // two sigma looks like the obvious measure and is not: sample sigma is
  // itself inflated by the outliers, so a fatter-tailed series can show a
  // *smaller* share beyond two of its own sigmas. Zero is normal; positive
  // means more weight in both the peak and the tails than a normal has.
  const recentReturns = logReturns.slice(-lookback);
  const returnMean = mean(recentReturns);
  const fourthMoment = mean(recentReturns.map((value) => (value - returnMean) ** 4));
  const excessKurtosis = latestSigma > 0 ? (fourthMoment / (latestSigma ** 4)) - 3 : null;

  const built = horizons.map((horizon) => {
    const horizonSigma = latestSigma * Math.sqrt(horizon);
    const upperPercent = (Math.exp(horizonSigma) - 1) * 100;
    const lowerPercent = (Math.exp(-horizonSigma) - 1) * 100;

    // Walk forward in non-overlapping steps: estimate from what was known at
    // the start of each window, then look at where price actually went.
    let held = 0;
    let tested = 0;
    const breachSigmas = [];
    for (let start = lookback; start + horizon < values.length; start += horizon) {
      const sigma = sigmaEndingAt(start);
      if (!Number.isFinite(sigma) || sigma <= 0) continue;
      const move = Math.log(values[start + horizon] / values[start]);
      const band = sigma * Math.sqrt(horizon);
      tested += 1;
      if (Math.abs(move) <= band) held += 1;
      // How far past the band price went, in multiples of the band itself.
      // Frequency alone hides the failure that matters: a band breached 30% of
      // the time by a hair is a different instrument from one breached 30% of
      // the time by three sigma.
      else breachSigmas.push(Math.abs(move) / band);
    }
    const heldPercent = tested ? Math.round((held / tested) * 1_000) / 10 : null;
    const medianBreach = breachSigmas.length ? Math.round(median(breachSigmas) * 100) / 100 : null;
    const worstBreach = breachSigmas.length ? Math.round(Math.max(...breachSigmas) * 100) / 100 : null;

    return {
      horizon,
      sigmaPercent: Math.round(horizonSigma * 1_000) / 10,
      upperPercent: Math.round(upperPercent * 100) / 100,
      lowerPercent: Math.round(lowerPercent * 100) / 100,
      upper: Math.round(spot * Math.exp(horizonSigma) * 100) / 100,
      lower: Math.round(spot * Math.exp(-horizonSigma) * 100) / 100,
      heldPercent,
      testedWindows: tested,
      // 68.3% is what a one-sigma Gaussian band claims. The gap is the finding.
      calibrationGap: heldPercent === null ? null : Math.round((heldPercent - 68.3) * 10) / 10,
      medianBreachSigmas: medianBreach,
      worstBreachSigmas: worstBreach,
      breachedWindows: breachSigmas.length,
      status: tested >= minimumCalibrationSamples ? 'calculated' : 'provisional',
    };
  });

  const calibrated = built.filter((entry) => entry.status === 'calculated');
  const worst = calibrated.length
    ? calibrated.reduce((furthest, entry) => (Math.abs(entry.calibrationGap) > Math.abs(furthest.calibrationGap) ? entry : furthest))
    : null;

  return {
    version,
    status: calibrated.length === built.length ? 'calculated' : calibrated.length ? 'provisional' : 'unavailable',
    asOf,
    observations: history.length,
    spot: Math.round(spot * 100) / 100,
    annualizedVolatilityPercent: Math.round(latestSigma * Math.sqrt(252) * 1_000) / 10,
    estimationWindow: lookback,
    excessKurtosis: excessKurtosis === null ? null : Math.round(excessKurtosis * 100) / 100,
    horizons: built,
    read: worst
      ? `A one-sigma band from ${lookback} sessions of realised volatility puts the next ${built[0].horizon} sessions inside ${built[0].lower} to ${built[0].upper}. Tested in non-overlapping windows across this history, the ${worst.horizon}-session band held ${worst.heldPercent}% of the time against the 68.3% a normal distribution claims, over ${worst.testedWindows} independent windows.${worst.worstBreachSigmas ? ` When it broke, the median break ran ${worst.medianBreachSigmas}x the band and the worst ran ${worst.worstBreachSigmas}x - the frequency is the smaller half of the story.` : ''}${excessKurtosis > 1 ? ` Daily returns carry excess kurtosis of ${Math.round(excessKurtosis * 100) / 100}, so the moves that escape this band escape it by more than a normal would allow.` : ''}`
      : 'Not enough independent windows to test the band against its own history.',
    methodology: 'Sigma is the standard deviation of daily log returns over the estimation window, scaled by the square root of the horizon. The band is a one-sigma range centred on the current price, not a forecast and not a bound. It carries no drift term, so a strongly trending market breaks it asymmetrically and the hit rate falls below what volatility alone would imply - which is the calibration doing its job rather than failing. Calibration re-estimates sigma from data available at the start of each historical window and steps forward in non-overlapping blocks, so the sample count reflects independent evidence rather than reused observations. A one-sigma band on equity returns usually holds more often than 68.3%, not less: the return distribution is peaked as well as fat-tailed, so it is the shoulders that are thin. The band understates risk through the size of the moves that escape it rather than their frequency, which is why the median and worst breach are reported beside the hit rate.',
  };
}

const CONCENTRATION_WINDOWS = [
  { key: 'short', sessions: 20, label: '20 sessions' },
  { key: 'medium', sessions: 60, label: '60 sessions' },
  { key: 'long', sessions: 252, label: '252 sessions' },
];
const CONCENTRATION_RANK_WINDOW = 756;
// Below this the two are doing the same thing and naming a leader is noise.
const CONCENTRATION_NOISE_POINTS = 0.75;

/**
 * What the cap-weighted index is not telling you.
 *
 * A cap-weighted index is a portfolio of its members weighted by size; an
 * equal-weight version of the same members is the average member. The gap
 * between them is therefore not a curiosity - it is the part of the index
 * return that came from its largest holdings rather than from the market.
 *
 * The distinction matters for evaluating a tape because the headline index can
 * make new highs while most of its members are falling, and it will not look
 * broken while that happens. Reading the two together separates "the market is
 * rising" from "a handful of very large companies are rising".
 *
 * Three honest limits, all published with the model. These are two ETFs, so
 * the ratio carries their fee and rebalancing differences as well as the
 * concentration signal - it is a good relative measure and a poor absolute
 * one. The equal-weight fund rebalances quarterly, so it is not a pure average
 * member between rebalances. And the closes are aligned by position rather
 * than by date, because the batch endpoint returns closes without them, so a
 * missing bar on one side shifts the pairing; the observation counts are
 * published so a mismatch is visible.
 */
export function calculateBreadthConcentration(equalWeightCloses, capWeightCloses, {
  windows = CONCENTRATION_WINDOWS,
  rankWindow = CONCENTRATION_RANK_WINDOW,
  noisePoints = CONCENTRATION_NOISE_POINTS,
} = {}) {
  const version = 'equity-concentration-v1';
  const equal = (equalWeightCloses ?? []).filter((value) => Number.isFinite(value) && value > 0);
  const cap = (capWeightCloses ?? []).filter((value) => Number.isFinite(value) && value > 0);
  const shortest = Math.min(equal.length, cap.length);
  const longestWindow = Math.max(...windows.map((window) => window.sessions));

  if (shortest <= Math.min(...windows.map((window) => window.sessions))) {
    return {
      version,
      status: 'unavailable',
      reason: `Needs more than ${Math.min(...windows.map((window) => window.sessions))} aligned sessions of both the equal-weight and cap-weighted history; ${shortest} available.`,
      observations: shortest,
      windows: [],
    };
  }

  // Trimmed from the front so both end on the same session.
  const equalAligned = equal.slice(equal.length - shortest);
  const capAligned = cap.slice(cap.length - shortest);
  const ratio = equalAligned.map((value, index) => value / capAligned[index]);

  const measured = windows.flatMap((window) => {
    if (shortest <= window.sessions) {
      return [{ ...window, status: 'unavailable', reason: `Needs ${window.sessions + 1} sessions; ${shortest} available.` }];
    }
    const capReturn = percentChange(capAligned, window.sessions);
    const equalReturn = percentChange(equalAligned, window.sessions);
    if (!Number.isFinite(capReturn) || !Number.isFinite(equalReturn)) {
      return [{ ...window, status: 'unavailable', reason: 'One of the two histories has no usable base for this window.' }];
    }
    // Positive means the cap-weighted index outran the average member, which
    // is leadership concentrating into the largest holdings.
    const spread = capReturn - equalReturn;
    return [{
      ...window,
      status: 'calculated',
      capReturnPercent: Math.round(capReturn * 100) / 100,
      equalReturnPercent: Math.round(equalReturn * 100) / 100,
      spreadPoints: Math.round(spread * 100) / 100,
      leader: Math.abs(spread) < noisePoints ? 'neither' : spread > 0 ? 'cap-weighted' : 'equal-weight',
    }];
  });

  const published = measured.filter((window) => window.status === 'calculated');
  if (!published.length) {
    return { version, status: 'unavailable', reason: 'No window could be measured from the aligned histories.', observations: shortest, windows: measured };
  }

  // Where today's ratio sits against its own past: a wide gap that is normal
  // for this pair is a different finding from one that is unprecedented.
  const rankSlice = ratio.slice(-rankWindow);
  const ratioPercentile = percentileRank(rankSlice, ratio.at(-1));

  // How far each sits below its own high over the longest window available.
  const drawdownOf = (values) => {
    const slice = values.slice(-Math.min(values.length, longestWindow));
    const peak = Math.max(...slice);
    return peak > 0 ? ((slice.at(-1) / peak) - 1) * 100 : null;
  };
  const capDrawdown = drawdownOf(capAligned);
  const equalDrawdown = drawdownOf(equalAligned);
  const drawdownGap = Number.isFinite(capDrawdown) && Number.isFinite(equalDrawdown)
    ? Math.round((equalDrawdown - capDrawdown) * 100) / 100
    : null;

  const medium = published.find((window) => window.key === 'medium') ?? published.at(-1);
  const narrowing = published.filter((window) => window.leader === 'cap-weighted').length;
  const broadening = published.filter((window) => window.leader === 'equal-weight').length;
  const state = narrowing > broadening ? 'Narrowing'
    : broadening > narrowing ? 'Broadening'
      : 'Balanced';

  // The case the model exists for: the index near its high while the average
  // member is not. Nothing about the index level shows this.
  const maskedWeakness = Number.isFinite(capDrawdown) && Number.isFinite(equalDrawdown)
    && capDrawdown > -3 && equalDrawdown < -8;

  return {
    version,
    status: published.length === windows.length ? 'calculated' : 'provisional',
    observations: shortest,
    equalWeightObservations: equal.length,
    capWeightObservations: cap.length,
    // A large mismatch means position alignment paired different sessions.
    alignmentDroppedSessions: Math.abs(equal.length - cap.length),
    ratio: Math.round(ratio.at(-1) * 10_000) / 10_000,
    ratioPercentile,
    rankedAgainst: rankSlice.length,
    windows: measured,
    state,
    capDrawdownPercent: Number.isFinite(capDrawdown) ? Math.round(capDrawdown * 100) / 100 : null,
    equalDrawdownPercent: Number.isFinite(equalDrawdown) ? Math.round(equalDrawdown * 100) / 100 : null,
    drawdownGapPoints: drawdownGap,
    maskedWeakness,
    read: `${state}: over ${medium.label} the cap-weighted index returned ${medium.capReturnPercent > 0 ? '+' : ''}${medium.capReturnPercent}% against ${medium.equalReturnPercent > 0 ? '+' : ''}${medium.equalReturnPercent}% for the average member, a gap of ${Math.abs(medium.spreadPoints)} points ${medium.leader === 'neither' ? 'that is inside the noise band' : `in favour of the ${medium.leader}`}.${
      medium.leader === 'cap-weighted' ? ' That part of the index return came from its largest holdings rather than from the market.' : medium.leader === 'equal-weight' ? ' The average member is outrunning the index, so the advance does not depend on its largest holdings.' : ''
    }${maskedWeakness ? ` The index sits ${Math.abs(capDrawdown).toFixed(1)}% from its high while the average member is ${Math.abs(equalDrawdown).toFixed(1)}% below its own - the index level is not showing what most of the market is doing.` : ''}${
      ratioPercentile === null ? ' The ratio has no usable range to rank today against.' : ` Today's ratio sits at the ${ordinal(ratioPercentile)} percentile of the last ${rankSlice.length} sessions.`
    }`,
    methodology: 'Equal-weight against cap-weighted closes for the same index. The spread is the cap-weighted return minus the equal-weight return over each window: positive means the index outran its average member, which is leadership concentrating into the largest holdings. Both are ETFs, so the ratio carries their fee and rebalancing differences as well as the concentration signal - it is a good relative measure and a poor absolute one, and the equal-weight fund rebalances quarterly rather than continuously. Closes are aligned by position because the batch endpoint returns them without dates, so a missing bar on one side shifts the pairing; the two observation counts and the size of any mismatch are published. A gap inside the noise band is reported as neither side leading rather than as a small lead.',
  };
}
