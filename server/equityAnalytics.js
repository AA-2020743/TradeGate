import { calculateChangeCorrelations, calculateTechnicalSnapshot } from './analytics.js';

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
  const normalized = points
    .filter((point) => Number.isFinite(point.value) && (point.timestamp || point.date))
    .map((point) => ({ ...point, date: (point.timestamp ?? point.date).slice(0, 10) }))
    .sort((left, right) => String(left.timestamp ?? left.date).localeCompare(String(right.timestamp ?? right.date)));
  return [...new Map(normalized.map((point) => [point.date, point])).values()];
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
  const calculatedBreadth = breadth?.status === 'calculated' ? breadth : null;
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

export function calculateSectorBreadthProxy(inputs) {
  const usable = (inputs ?? []).filter((input) => Array.isArray(input?.points) && input.points.length >= 60);
  if (!usable.length) {
    return { version: 'sector-breadth-proxy-v1', status: 'unavailable', source: 'Sector/subsector ETF participation proxy', missing: ['At least one ETF history with 60 or more sessions'] };
  }

  const stats = usable.map((input) => {
    const values = input.points.map((point) => point.value).filter(Number.isFinite);
    const latest = values.at(-1);
    const sma = (period) => values.length >= period ? mean(values.slice(-period)) : null;
    const sma50 = sma(50);
    const sma200 = sma(Math.min(200, values.length));
    const window60 = values.slice(-60);
    const high60 = Math.max(...window60);
    const low60 = Math.min(...window60);
    const past20 = values.at(-21);
    const pastThrust = values.length >= 71 ? values.at(-71) : values[0];
    const sma50Past = values.length >= 70 ? mean(values.slice(-70, -20)) : null;
    return {
      symbol: input.symbol,
      above50: Number.isFinite(sma50) && Number.isFinite(latest) ? latest > sma50 : false,
      above200: Number.isFinite(sma200) && Number.isFinite(latest) ? latest > sma200 : false,
      advancing: Number.isFinite(past20) && past20 > 0 && Number.isFinite(latest) ? ((latest / past20) - 1) > 0 : false,
      newHigh: Number.isFinite(latest) && latest >= (high60 * 0.98),
      newLow: Number.isFinite(latest) && latest <= (low60 * 1.02),
      thrustDelta: Number.isFinite(sma50Past) && sma50Past > 0 && Number.isFinite(sma50) ? (((sma50 / sma50Past) - 1) * 100) : null,
      asOf: input.points.at(-1)?.date ?? null,
    };
  });

  const count = (predicate) => stats.filter(predicate).length;
  const universeSize = stats.length;
  const pctAbove50 = Math.round((count((stat) => stat.above50) / universeSize) * 100);
  const pctAbove200 = Math.round((count((stat) => stat.above200) / universeSize) * 100);
  const advancersPct = Math.round((count((stat) => stat.advancing) / universeSize) * 100);
  const newHighs = count((stat) => stat.newHigh);
  const newLows = count((stat) => stat.newLow);
  const thrustValues = stats.map((stat) => stat.thrustDelta).filter(Number.isFinite);
  const thrust20 = thrustValues.length ? Number((thrustValues.reduce((total, value) => total + value, 0) / thrustValues.length).toFixed(2)) : null;
  const participation = (pctAbove50 * 0.6) + (pctAbove200 * 0.4);
  const topRisk = Math.round(clamp(100 - participation));
  const bottomScore = Math.round(clamp(((100 - participation) * 0.7) + (Math.max(thrust20 ?? 0, 0) * 3)));
  const asOf = stats.map((stat) => stat.asOf).filter(Boolean).sort().at(-1) ?? null;

  return {
    version: 'sector-breadth-proxy-v1',
    status: 'calculated',
    source: 'Sector/subsector ETF participation proxy',
    asOf,
    universeSize,
    pctAbove50,
    pctAbove200,
    advancersPct,
    newHighs,
    newLows,
    thrust20,
    topRisk,
    bottomScore,
    methodology: 'Participation proxy across sector and subsector ETF close histories; not a substitute for constituent-level breadth.',
  };
}

export function calculateTopRisk({ technical, breadth, sentiment, positioning, credit, liquidity, flows } = {}) {
  const calculatedBreadth = breadth?.status === 'calculated' ? breadth : null;
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
    status: model.publishable ? 'calculated' : 'unavailable',
    asOf: technical?.asOf ?? null,
    ...model,
    score,
    risk: score === null ? null : score >= 75 ? 'Extreme' : score >= 55 ? 'Elevated' : score >= 35 ? 'Watch' : 'Low',
  };
}

export function calculateBottomSignal({ technical, breadth, sentiment, positioning, credit, liquidity, flows } = {}) {
  const calculatedBreadth = breadth?.status === 'calculated' ? breadth : null;
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
    status: model.publishable ? 'calculated' : 'unavailable',
    asOf: technical?.asOf ?? null,
    ...model,
    score,
    signal: score === null ? null : score >= 75 ? 'Capitulation reversal' : score >= 55 ? 'Bottoming watch' : score >= 35 ? 'Stabilizing' : 'Unconfirmed',
    bearMarketRallyRisk: model.publishable && longTrendAvailable ? belowLongTrend && !breadthConfirmed ? 'Elevated' : 'Normal' : null,
  };
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
      advanceRatio: observed ? advances / observed : null,
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
  let advanceDeclineLine = 0;
  const history = daily.slice(-252).map((day) => {
    advanceDeclineLine += day.netAdvances;
    return { date: day.date, netAdvances: day.netAdvances, advanceDeclineLine };
  });
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
      line: netAdvances.reduce((total, value) => total + value, 0),
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
    thrustTriggered: previousThrust !== null && previousThrust < 0.4 && breadthThrust >= 0.615,
    history,
    unavailable,
    missing: unavailable,
  };
}

export function calculateMacroSensitivities(points, macroSeries) {
  const correlate = (history) => {
    if (!history?.length) return null;
    return calculateChangeCorrelations(points, history)?.correlations?.['60D'] ?? null;
  };
  return {
    dollar: correlate(macroSeries.dollar),
    realYield: correlate(macroSeries.realYield),
    vix: correlate(macroSeries.vix),
    credit: correlate(macroSeries.credit),
  };
}

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
    const leader = spread60 >= 0 ? pair.leftLeader : pair.rightLeader;
    const regime = Math.abs(spread60) < 1 && Math.abs(spread20) < 1 ? 'Balanced' : `${leader} leading`;
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
      regime,
    };
  });

  const calculatedCount = calculated.filter((pair) => pair.status === 'calculated').length;
  return {
    version: 'style-rotation-v1',
    status: calculatedCount ? 'calculated' : 'unavailable',
    asOf: calculated.map((pair) => pair.asOf).filter(Boolean).sort().at(-1) ?? null,
    pairs: calculated,
    methodology: 'Equal-weight basket returns over 20 and 60 synchronized sessions; the spread is left-basket minus right-basket return.',
  };
}

const ROTATION_LOOKBACK_SESSIONS = 20;

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
    const relative20 = return20 - percentChange(alignedBenchmarkValues, 20);
    const relative60 = return60 - percentChange(alignedBenchmarkValues, 60);
    const relativeScore = clamp(50 + (relative20 * 6) + (relative60 * 2));
    const score = Math.round((technical.score * 0.55) + (relativeScore * 0.45));
    const quadrant = rrgQuadrant(relative20, relative60);
    // Where the sector sat one lookback ago, so the tape can distinguish a
    // sector rotating into leadership from one rolling out of it.
    const previous = (() => {
      if (aligned.length <= 60 + ROTATION_LOOKBACK_SESSIONS) return null;
      const sectorPast = alignedSectorValues.slice(0, -ROTATION_LOOKBACK_SESSIONS);
      const benchmarkPast = alignedBenchmarkValues.slice(0, -ROTATION_LOOKBACK_SESSIONS);
      const past20 = percentChange(sectorPast, 20) - percentChange(benchmarkPast, 20);
      const past60 = percentChange(sectorPast, 60) - percentChange(benchmarkPast, 60);
      const pastQuadrant = rrgQuadrant(past20, past60);
      return pastQuadrant ? { relative20: past20, relative60: past60, quadrant: pastQuadrant } : null;
    })();
    const relativeShift = previous ? relative20 - previous.relative20 : null;
    const rotation = previous ? {
      lookbackSessions: ROTATION_LOOKBACK_SESSIONS,
      previousQuadrant: previous.quadrant,
      quadrant,
      moved: previous.quadrant !== quadrant,
      path: previous.quadrant === quadrant ? `Holding ${quadrant}` : `${previous.quadrant} → ${quadrant}`,
      relativeShift: Math.round(relativeShift * 100) / 100,
      direction: Math.abs(relativeShift) < 0.5 ? 'Flat' : relativeShift > 0 ? 'Strengthening' : 'Fading',
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
    asOf: calculated.map((sector) => sector.asOf).sort().at(-1) ?? null,
    benchmark: 'SPY',
    methodology: `20- and 60-session total-price momentum relative to SPY, combined with technical-v1. The relative-rotation quadrant reads the 60-session excess return as how strong a sector already is and the 20-session one as whether that strength is building. Each sector is also placed where it sat ${ROTATION_LOOKBACK_SESSIONS} sessions ago, so a sector rotating into leadership is distinguishable from one rolling out of it; the shift is the change in 20-session excess return over that window.`,
    rotationLookbackSessions: ROTATION_LOOKBACK_SESSIONS,
    enteringLeadership: calculated.filter((sector) => sector.rotation?.moved && sector.quadrant === 'Leading').map((sector) => sector.symbol),
    leavingLeadership: calculated.filter((sector) => sector.rotation?.moved && sector.rotation.previousQuadrant === 'Leading').map((sector) => sector.symbol),
    sectors: calculated,
    missing: calculated.length < sectors.length ? [`${sectors.length - calculated.length} sector histories`] : [],
  };
}
