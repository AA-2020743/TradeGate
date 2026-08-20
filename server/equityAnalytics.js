import { calculateTechnicalSnapshot } from './analytics.js';

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function percentChange(values, periods) {
  if (values.length <= periods || values.at(-(periods + 1)) === 0) return null;
  return ((values.at(-1) / values.at(-(periods + 1))) - 1) * 100;
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
  return points
    .filter((point) => Number.isFinite(point.value) && (point.timestamp || point.date))
    .map((point) => ({ ...point, date: (point.timestamp ?? point.date).slice(0, 10) }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function weightedModel(definitions, minimumCoverage, mandatory = []) {
  const available = definitions.filter((driver) => Number.isFinite(driver.score));
  const availableKeys = new Set(available.map((driver) => driver.key));
  const availableWeight = available.reduce((total, driver) => total + driver.weight, 0);
  const coverage = Math.round(availableWeight * 100);
  const missing = definitions.filter((driver) => !availableKeys.has(driver.key)).map((driver) => driver.name);
  const mandatoryPresent = mandatory.every((key) => availableKeys.has(key));
  const rawScore = availableWeight
    ? available.reduce((total, driver) => total + (driver.score * driver.weight), 0) / availableWeight
    : null;
  return {
    publishable: mandatoryPresent && availableWeight >= minimumCoverage,
    score: rawScore === null ? null : Math.round(clamp(rawScore)),
    coverage,
    missing,
    drivers: definitions.map((driver) => ({
      key: driver.key,
      name: driver.name,
      score: Number.isFinite(driver.score) ? Math.round(clamp(driver.score)) : null,
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

export function calculateEquityRegime({ technical, liquidity, breadth, credit, sentiment, positioning } = {}) {
  const volatility = technical?.indicators?.annualizedVolatility20d;
  const definitions = [
    { key: 'trend', name: 'Price trend', score: technical?.components?.trend, weight: 0.24, source: 'Provider close history' },
    { key: 'momentum', name: 'Price momentum', score: technical?.components?.momentum, weight: 0.18, source: 'Provider close history' },
    { key: 'breadth', name: 'Market breadth', score: breadth?.score, weight: 0.18, source: breadth?.source },
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
    status: model.coverage >= 75 ? 'calculated' : 'provisional',
    asOf: technical.asOf,
    ...model,
    regime,
    confidence: confidenceScore >= 75 ? 'High' : confidenceScore >= 55 ? 'Medium' : 'Low',
    confidenceScore,
    settings: REGIME_SETTINGS[regime],
  };
}

function technicalTopRisk(technical) {
  if (!technical) return null;
  const rsi = technical.indicators?.rsi14;
  const latest = technical.latest;
  const sma200 = technical.indicators?.sma200;
  const extension = Number.isFinite(sma200) && sma200 > 0 ? ((latest / sma200) - 1) * 100 : 0;
  const macdRisk = technical.indicators?.macd?.histogram < 0 ? 75 : 25;
  return mean([clamp(((rsi - 55) / 25) * 100), clamp(extension * 4), macdRisk].filter(Number.isFinite));
}

function technicalBottomScore(technical) {
  if (!technical) return null;
  const rsi = technical.indicators?.rsi14;
  const latest = technical.latest;
  const sma200 = technical.indicators?.sma200;
  const discount = Number.isFinite(sma200) && sma200 > 0 ? ((sma200 / latest) - 1) * 100 : 0;
  const macdTurn = technical.indicators?.macd?.histogram > 0 ? 70 : 20;
  return mean([clamp(((45 - rsi) / 25) * 100), clamp(discount * 5), macdTurn].filter(Number.isFinite));
}

export function calculateTopRisk({ technical, breadth, sentiment, positioning, credit, liquidity, flows } = {}) {
  const definitions = [
    { key: 'technical', name: 'Technical deterioration', score: technicalTopRisk(technical), weight: 0.25, source: 'Provider close history' },
    { key: 'breadth', name: 'Breadth deterioration', score: breadth?.topRisk, weight: 0.2, source: breadth?.source },
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
    status: model.publishable ? 'calculated' : 'unavailable',
    asOf: technical?.asOf ?? null,
    ...model,
    score,
    risk: score === null ? null : score >= 75 ? 'Extreme' : score >= 55 ? 'Elevated' : score >= 35 ? 'Watch' : 'Low',
  };
}

export function calculateBottomSignal({ technical, breadth, sentiment, positioning, credit, liquidity, flows } = {}) {
  const definitions = [
    { key: 'technical', name: 'Technical washout and turn', score: technicalBottomScore(technical), weight: 0.25, source: 'Provider close history' },
    { key: 'breadth', name: 'Breadth washout and thrust', score: breadth?.bottomScore, weight: 0.2, source: breadth?.source },
    { key: 'sentiment', name: 'Sentiment pessimism', score: sentiment?.pessimism, weight: 0.15, source: sentiment?.source },
    { key: 'positioning', name: 'Positioning underexposure', score: positioning?.underexposure, weight: 0.1, source: positioning?.source },
    { key: 'credit', name: 'Credit stabilization', score: credit?.stabilization, weight: 0.1, source: credit?.source },
    { key: 'liquidity', name: 'Liquidity turn', score: liquidity?.score, weight: 0.1, source: liquidity?.version },
    { key: 'flows', name: 'Capitulation flows', score: flows?.capitulation, weight: 0.1, source: flows?.source },
  ];
  const model = weightedModel(definitions, 0.55, ['technical', 'breadth']);
  const score = model.publishable ? model.score : null;
  const belowLongTrend = Number.isFinite(technical?.indicators?.sma200) && technical.latest < technical.indicators.sma200;
  const breadthConfirmed = Number.isFinite(breadth?.bottomScore) && breadth.bottomScore >= 60;
  return {
    version: 'equity-bottom-signal-v1',
    status: model.publishable ? 'calculated' : 'unavailable',
    asOf: technical?.asOf ?? null,
    ...model,
    score,
    signal: score === null ? null : score >= 75 ? 'Capitulation reversal' : score >= 55 ? 'Bottoming watch' : score >= 35 ? 'Stabilizing' : 'Unconfirmed',
    bearMarketRallyRisk: belowLongTrend && !breadthConfirmed ? 'Elevated' : 'Normal',
  };
}

export function calculateBreadth(constituents) {
  const histories = constituents.map((constituent) => ({ ...constituent, points: normalizeHistory(constituent.points ?? []) }));
  const eligible = histories.filter((constituent) => constituent.points.length >= 20);
  if (eligible.length < 20) {
    return {
      version: 'equity-breadth-v1',
      status: 'unavailable',
      asOf: null,
      constituents: eligible.length,
      minimumConstituents: 20,
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
    for (const constituent of eligible) {
      const index = constituent.points.findIndex((point) => point.date === date);
      if (index <= 0) continue;
      const point = constituent.points[index];
      const change = point.value - constituent.points[index - 1].value;
      if (Number.isFinite(point.volume)) volumeParticipants += 1;
      if (change > 0) {
        advances += 1;
        if (Number.isFinite(point.volume)) advanceVolume += point.volume;
      } else if (change < 0) {
        declines += 1;
        if (Number.isFinite(point.volume)) declineVolume += point.volume;
      }
    }
    const participating = advances + declines;
    return {
      date,
      advances,
      declines,
      netAdvances: advances - declines,
      advanceRatio: participating ? advances / participating : null,
      advanceVolume,
      declineVolume,
      volumeParticipants,
    };
  }).filter((day) => day.advances + day.declines >= Math.ceil(eligible.length * 0.7));
  if (daily.length < 19) {
    return { version: 'equity-breadth-v1', status: 'unavailable', asOf: daily.at(-1)?.date ?? null, constituents: eligible.length, minimumConstituents: 20, missing: ['Synchronized constituent observations'] };
  }

  const latestDate = daily.at(-1).date;
  const latestMetrics = { above20: 0, above50: 0, above200: 0, highs: 0, lows: 0, observed: 0 };
  for (const constituent of eligible) {
    const points = constituent.points.filter((point) => point.date <= latestDate);
    if (!points.length) continue;
    const values = points.map((point) => point.value);
    const latest = values.at(-1);
    latestMetrics.observed += 1;
    if (latest > movingAverage(values, 20)) latestMetrics.above20 += 1;
    if (values.length >= 50 && latest > movingAverage(values, 50)) latestMetrics.above50 += 1;
    if (values.length >= 200 && latest > movingAverage(values, 200)) latestMetrics.above200 += 1;
    if (values.length >= 252 && latest >= Math.max(...values.slice(-252))) latestMetrics.highs += 1;
    if (values.length >= 252 && latest <= Math.min(...values.slice(-252))) latestMetrics.lows += 1;
  }

  const netAdvances = daily.map((day) => day.netAdvances);
  const ema19 = ema(netAdvances, 19);
  const ema39 = ema(netAdvances, 39);
  const mcClellanHistory = daily.flatMap((day, index) => Number.isFinite(ema19[index]) && Number.isFinite(ema39[index])
    ? [{ date: day.date, value: ema19[index] - ema39[index] }]
    : []);
  const breadthThrust = daily.length >= 10
    ? mean(daily.slice(-10).map((day) => day.advanceRatio))
    : null;
  const previousThrust = daily.length >= 20
    ? mean(daily.slice(-20, -10).map((day) => day.advanceRatio))
    : null;
  const observed = latestMetrics.observed;
  const percentAbove20 = (latestMetrics.above20 / observed) * 100;
  const percentAbove50 = (latestMetrics.above50 / observed) * 100;
  const percentAbove200 = (latestMetrics.above200 / observed) * 100;
  const newHighLow = ((latestMetrics.highs - latestMetrics.lows) / observed) * 100;
  const score = Math.round(clamp((percentAbove20 * 0.25) + (percentAbove50 * 0.3) + (percentAbove200 * 0.3) + ((newHighLow + 100) / 2 * 0.15)));
  const latestAdvanceRatio = daily.at(-1).advanceRatio * 100;
  const topRisk = Math.round(clamp((100 - percentAbove20) * 0.35 + (100 - percentAbove50) * 0.35 + (100 - latestAdvanceRatio) * 0.3));
  const washout = clamp((35 - percentAbove20) * 2.5);
  const thrust = breadthThrust !== null && previousThrust !== null ? clamp((breadthThrust - previousThrust) * 500 + 50) : 50;
  const bottomScore = Math.round((washout * 0.55) + (thrust * 0.45));
  const hasVolume = daily.at(-1).volumeParticipants >= Math.ceil(eligible.length * 0.7);

  return {
    version: 'equity-breadth-v1',
    status: 'calculated',
    source: 'Constituent provider histories',
    asOf: latestDate,
    constituents: observed,
    score,
    topRisk,
    bottomScore,
    advanceDecline: {
      advances: daily.at(-1).advances,
      declines: daily.at(-1).declines,
      line: netAdvances.reduce((total, value) => total + value, 0),
      volume: hasVolume ? { advance: daily.at(-1).advanceVolume, decline: daily.at(-1).declineVolume } : null,
    },
    mcClellan: {
      oscillator: mcClellanHistory.at(-1)?.value ?? null,
      summation: mcClellanHistory.reduce((total, point) => total + point.value, 0),
    },
    percentAbove: { dma20: percentAbove20, dma50: percentAbove50, dma200: percentAbove200 },
    newHighs: latestMetrics.highs,
    newLows: latestMetrics.lows,
    breadthThrust: breadthThrust === null ? null : breadthThrust * 100,
    thrustTriggered: previousThrust !== null && previousThrust < 0.4 && breadthThrust >= 0.615,
    history: daily.slice(-252).map((day, index, values) => ({
      date: day.date,
      netAdvances: day.netAdvances,
      advanceDeclineLine: values.slice(0, index + 1).reduce((total, value) => total + value.netAdvances, 0),
    })),
    unavailable: [
      ...(!hasVolume ? ['Advance/Decline Volume'] : []),
      'Equal-weight vs cap-weight',
      'Sector breadth',
      'Small-cap vs large-cap participation',
    ],
  };
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
    const relative20 = return20 - percentChange(alignedBenchmarkValues, 20);
    const relative60 = return60 - percentChange(alignedBenchmarkValues, 60);
    const relativeScore = clamp(50 + (relative20 * 6) + (relative60 * 2));
    const score = Math.round((technical.score * 0.55) + (relativeScore * 0.45));
    const quadrant = relative20 >= 0 && relative60 >= 0
      ? 'Leading'
      : relative20 >= 0 ? 'Improving' : relative60 >= 0 ? 'Weakening' : 'Lagging';
    return [{
      symbol: sector.symbol,
      name: sector.name,
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
    }];
  }).sort((left, right) => right.score - left.score).map((sector, index) => ({ ...sector, rank: index + 1 }));

  return {
    version: 'sector-rotation-v1',
    status: calculated.length >= Math.ceil(sectors.length * 0.7) ? 'calculated' : calculated.length ? 'partial' : 'unavailable',
    asOf: calculated.map((sector) => sector.asOf).sort().at(-1) ?? null,
    benchmark: 'SPY',
    methodology: '20- and 60-session total-price momentum relative to SPY, combined with technical-v1.',
    sectors: calculated,
    missing: calculated.length < sectors.length ? [`${sectors.length - calculated.length} sector histories`] : [],
  };
}
