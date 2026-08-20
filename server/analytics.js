const TRADING_DAYS = 252;

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function standardDeviation(values) {
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(values.reduce((total, value) => total + ((value - average) ** 2), 0) / (values.length - 1));
}

function simpleMovingAverage(values, period) {
  if (values.length < period) return null;
  return mean(values.slice(-period));
}

function emaSeries(values, period) {
  const result = Array(values.length).fill(null);
  if (values.length < period) return result;
  const multiplier = 2 / (period + 1);
  result[period - 1] = mean(values.slice(0, period));
  for (let index = period; index < values.length; index += 1) {
    result[index] = ((values[index] - result[index - 1]) * multiplier) + result[index - 1];
  }
  return result;
}

export function calculateRsi(values, period = 14) {
  if (values.length <= period) return null;
  let averageGain = 0;
  let averageLoss = 0;

  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain += Math.max(change, 0);
    averageLoss += Math.max(-change, 0);
  }
  averageGain /= period;
  averageLoss /= period;

  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = ((averageGain * (period - 1)) + Math.max(change, 0)) / period;
    averageLoss = ((averageLoss * (period - 1)) + Math.max(-change, 0)) / period;
  }

  if (averageLoss === 0 && averageGain === 0) return 50;
  if (averageLoss === 0) return 100;
  const relativeStrength = averageGain / averageLoss;
  return 100 - (100 / (1 + relativeStrength));
}

export function calculateMacd(values, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (values.length < slowPeriod + signalPeriod) return null;
  const fast = emaSeries(values, fastPeriod);
  const slow = emaSeries(values, slowPeriod);
  const macdValues = values.map((_, index) => fast[index] !== null && slow[index] !== null ? fast[index] - slow[index] : null);
  const validMacd = macdValues.filter((value) => value !== null);
  const signals = emaSeries(validMacd, signalPeriod).filter((value) => value !== null);
  const line = validMacd.at(-1);
  const signal = signals.at(-1);
  return { line, signal, histogram: line - signal };
}

export function pearsonCorrelation(leftValues, rightValues) {
  const length = Math.min(leftValues.length, rightValues.length);
  if (length < 3) return null;
  const left = leftValues.slice(-length);
  const right = rightValues.slice(-length);
  const leftMean = mean(left);
  const rightMean = mean(right);
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;

  for (let index = 0; index < length; index += 1) {
    const leftDifference = left[index] - leftMean;
    const rightDifference = right[index] - rightMean;
    covariance += leftDifference * rightDifference;
    leftVariance += leftDifference ** 2;
    rightVariance += rightDifference ** 2;
  }

  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator === 0 ? null : covariance / denominator;
}

export function calculateCrossMarketRelationship(leftPoints, rightPoints) {
  const leftByDate = new Map(leftPoints.map((point) => [(point.date ?? point.timestamp).slice(0, 10), point.value]));
  const rightByDate = new Map(rightPoints.map((point) => [(point.date ?? point.timestamp).slice(0, 10), point.value]));
  const dates = [...leftByDate.keys()].filter((date) => rightByDate.has(date)).sort();
  if (dates.length < 22) return null;

  const leftValues = dates.map((date) => leftByDate.get(date));
  const rightValues = dates.map((date) => rightByDate.get(date));
  const leftReturns = [];
  const rightReturns = [];
  for (let index = 1; index < dates.length; index += 1) {
    leftReturns.push(Math.log(leftValues[index] / leftValues[index - 1]));
    rightReturns.push(Math.log(rightValues[index] / rightValues[index - 1]));
  }

  const correlations = {};
  for (const window of [20, 60, 252]) {
    correlations[window] = leftReturns.length >= window
      ? pearsonCorrelation(leftReturns.slice(-window), rightReturns.slice(-window))
      : null;
  }
  const activeCorrelation = correlations[60] ?? correlations[20];
  const momentumLookback = Math.min(20, leftValues.length - 1);
  const leftMomentum = ((leftValues.at(-1) / leftValues.at(-(momentumLookback + 1))) - 1) * 100;
  const rightMomentum = ((rightValues.at(-1) / rightValues.at(-(momentumLookback + 1))) - 1) * 100;
  const previousLeft = leftValues.slice(-(momentumLookback + 1), -1);
  const leftBreakout = leftValues.at(-1) > Math.max(...previousLeft)
    ? 'upside'
    : leftValues.at(-1) < Math.min(...previousLeft) ? 'downside' : 'none';

  return {
    version: 'cross-market-correlation-v1',
    asOf: dates.at(-1),
    observations: dates.length,
    correlations: {
      '20D': correlations[20],
      '60D': correlations[60],
      '1Y': correlations[252],
    },
    regime: activeCorrelation <= -0.4 ? 'Inverse' : activeCorrelation >= 0.4 ? 'Positive' : 'Unstable',
    momentum: { left: leftMomentum, right: rightMomentum },
    divergence: activeCorrelation <= -0.4
      ? Math.sign(leftMomentum) === Math.sign(rightMomentum) ? 'Inverse relationship diverging' : 'Inverse relationship aligned'
      : activeCorrelation >= 0.4 ? 'Positive relationship' : 'Relationship unstable',
    leftBreakout,
    interpretation: leftBreakout === 'upside' ? 'BTC headwind' : leftBreakout === 'downside' ? 'BTC tailwind' : 'No dollar breakout',
    history: {
      dates: dates.slice(-60),
      left: leftValues.slice(-60),
      right: rightValues.slice(-60),
    },
  };
}

export function calculateTechnicalSnapshot(inputPoints, options = {}) {
  const points = inputPoints
    .filter((point) => Number.isFinite(point.value) && point.timestamp)
    .sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
  const values = points.map((point) => point.value);
  if (values.length < 30) return null;

  const latest = values.at(-1);
  const sma20 = simpleMovingAverage(values, 20);
  const sma50 = simpleMovingAverage(values, 50);
  const sma200 = simpleMovingAverage(values, 200);
  const rsi = calculateRsi(values);
  const macd = calculateMacd(values);
  const momentumBase = values[Math.max(0, values.length - 21)];
  const momentumPercent = ((latest / momentumBase) - 1) * 100;
  const returns = values.slice(-21).slice(1).map((value, index) => Math.log(value / values.slice(-21)[index]));
  const annualizationDays = options.annualizationDays ?? TRADING_DAYS;
  const volatility = (standardDeviation(returns) ?? 0) * Math.sqrt(annualizationDays) * 100;
  const movingAverages = [sma20, sma50, sma200].filter(Number.isFinite);
  const trendScore = mean(movingAverages.map((average) => latest >= average ? 100 : 0)) ?? 50;
  const macdPercent = macd ? (macd.histogram / latest) * 100 : 0;
  const momentumScore = clamp(50 + (momentumPercent * 2.5) + (macdPercent * 40));
  const rsiScore = rsi === null ? 50 : clamp(((rsi - 30) / 40) * 100);
  const volatilityScore = clamp(100 - volatility);
  const score = Math.round((trendScore * 0.4) + (momentumScore * 0.35) + (rsiScore * 0.2) + (volatilityScore * 0.05));
  const regime = score >= 65 ? 'Constructive' : score <= 35 ? 'Guarded' : 'Neutral';

  return {
    version: 'technical-v1',
    asOf: points.at(-1).timestamp,
    observations: points.length,
    latest,
    score,
    regime,
    indicators: {
      rsi14: rsi,
      macd,
      sma20,
      sma50,
      sma200,
      momentum20d: momentumPercent,
      annualizedVolatility20d: volatility,
    },
    components: {
      trend: Math.round(trendScore),
      momentum: Math.round(momentumScore),
      rsi: Math.round(rsiScore),
      volatilityQuality: Math.round(volatilityScore),
    },
  };
}

function pointsForSeries(series) {
  return (series?.history ?? [])
    .filter((point) => Number.isFinite(point.value) && point.date)
    .map((point) => ({ date: point.date, value: point.value * (series.multiplier ?? 1) }))
    .sort((left, right) => new Date(left.date) - new Date(right.date));
}

function latestAtOrBefore(points, date) {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (points[index].date <= date) return points[index];
  }
  return null;
}

function changeOverDays(points, days) {
  if (points.length < 2) return null;
  const latest = points.at(-1);
  const targetDate = new Date(latest.date);
  targetDate.setUTCDate(targetDate.getUTCDate() - days);
  const previous = latestAtOrBefore(points, targetDate.toISOString().slice(0, 10));
  if (!previous || previous.value === 0) return null;
  return ((latest.value / previous.value) - 1) * 100;
}

function boundedImpulse(change, scale, inverse = false) {
  if (!Number.isFinite(change)) return null;
  const impulse = Math.tanh(change / scale);
  return inverse ? -impulse : impulse;
}

export function calculateUsLiquidityModel(seriesList) {
  const series = Object.fromEntries(seriesList.map((item) => [item.key, item]));
  const fed = pointsForSeries(series.fedBalanceSheet);
  const treasury = pointsForSeries(series.treasuryGeneralAccount);
  const reverseRepo = pointsForSeries(series.reverseRepo);
  const m2 = pointsForSeries(series.usM2);
  const dollar = pointsForSeries(series.dxy);

  const netLiquidity = fed.flatMap((point) => {
    const treasuryPoint = latestAtOrBefore(treasury, point.date);
    const reverseRepoPoint = latestAtOrBefore(reverseRepo, point.date);
    return treasuryPoint && reverseRepoPoint
      ? [{ date: point.date, value: point.value - treasuryPoint.value - reverseRepoPoint.value }]
      : [];
  });

  const driverDefinitions = [
    { key: 'netLiquidity', name: 'Fed net liquidity', change: changeOverDays(netLiquidity, 91), scale: 3, weight: 0.55 },
    { key: 'usM2', name: 'US M2 growth', change: changeOverDays(m2, 91), scale: 2, weight: 0.25 },
    { key: 'dollar', name: 'Dollar transmission', change: changeOverDays(dollar, 91), scale: 3, weight: 0.2, inverse: true },
  ];
  const drivers = driverDefinitions.map((driver) => ({
    ...driver,
    impulse: boundedImpulse(driver.change, driver.scale, driver.inverse),
  })).filter((driver) => driver.impulse !== null);
  if (drivers.length !== driverDefinitions.length) return null;

  const availableWeight = drivers.reduce((total, driver) => total + driver.weight, 0);
  const composite = drivers.reduce((total, driver) => total + (driver.impulse * driver.weight), 0) / availableWeight;
  const positiveDrivers = drivers.filter((driver) => driver.impulse > 0.05).length;
  const negativeDrivers = drivers.filter((driver) => driver.impulse < -0.05).length;
  const agreement = Math.max(positiveDrivers, negativeDrivers) / drivers.length;
  const score = Math.round(clamp(50 + (composite * 50)));
  const regime = composite >= 0.15 ? 'Expansion' : composite <= -0.15 ? 'Contraction' : 'Neutral';
  const shortNetImpulse = boundedImpulse(changeOverDays(netLiquidity, 28), 1.5);
  const longNetImpulse = boundedImpulse(changeOverDays(netLiquidity, 91), 3);
  const momentum = shortNetImpulse === null || longNetImpulse === null
    ? 'Unavailable'
    : shortNetImpulse > longNetImpulse ? 'Accelerating' : 'Decelerating';
  const confidenceScore = Math.round(((availableWeight * 0.55) + (agreement * 0.45)) * 100);

  return {
    version: 'us-liquidity-v1',
    asOf: netLiquidity.at(-1)?.date ?? null,
    score,
    regime,
    momentum,
    confidence: confidenceScore >= 75 ? 'High' : confidenceScore >= 50 ? 'Medium' : 'Low',
    confidenceScore,
    breadth: { positive: positiveDrivers, negative: negativeDrivers, total: drivers.length },
    netLiquidity: netLiquidity.at(-1)?.value ?? null,
    history: netLiquidity,
    composite,
    drivers: drivers.map(({ key, name, change, impulse, weight }) => ({ key, name, changePercent: change, impulse, weight })),
  };
}
