const TRADING_DAYS = 252;
const DAY_MS = 86_400_000;

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
  const recentValues = values.slice(-21);
  const returns = recentValues.slice(1).map((value, index) => {
    const base = recentValues[index];
    return base > 0 && value > 0 ? Math.log(value / base) : null;
  }).filter(Number.isFinite);
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

function absoluteChangeOverDays(points, days) {
  if (points.length < 2) return null;
  const latest = points.at(-1);
  const targetDate = new Date(latest.date);
  targetDate.setUTCDate(targetDate.getUTCDate() - days);
  const previous = latestAtOrBefore(points, targetDate.toISOString().slice(0, 10));
  return previous ? latest.value - previous.value : null;
}

function driverComposite(drivers, minimumCoverage, minimumDrivers = 1) {
  const available = drivers.filter((driver) => Number.isFinite(driver.score));
  const availableWeight = available.reduce((total, driver) => total + driver.weight, 0);
  const coverage = Math.round(availableWeight * 100);
  const score = availableWeight
    ? Math.round(clamp(available.reduce((total, driver) => total + (driver.score * driver.weight), 0) / availableWeight))
    : null;
  return {
    publishable: availableWeight >= minimumCoverage - 1e-9 && available.length >= minimumDrivers,
    score,
    coverage,
    missing: drivers.filter((driver) => !Number.isFinite(driver.score)).map((driver) => driver.name),
    drivers: drivers.map((driver) => ({
      key: driver.key,
      name: driver.name,
      score: Number.isFinite(driver.score) ? Math.round(clamp(driver.score)) : null,
      weight: driver.weight,
      value: Number.isFinite(driver.value) ? driver.value : null,
      change: Number.isFinite(driver.change) ? driver.change : null,
      source: driver.source,
    })),
  };
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

const GLOBAL_LIQUIDITY_MAX_GAP_DAYS = 35;

function alignedUsdLeg(points, fxPoints, conversion) {
  const legs = [];
  for (const point of points) {
    const fxPoint = latestAtOrBefore(fxPoints, point.date);
    if (!fxPoint) continue;
    const gapDays = (new Date(point.date) - new Date(fxPoint.date)) / DAY_MS;
    if (gapDays > GLOBAL_LIQUIDITY_MAX_GAP_DAYS) continue;
    const value = conversion(point.value, fxPoint.value);
    if (Number.isFinite(value) && value > 0) legs.push({ date: point.date, value });
  }
  return legs;
}

function sumSeries(basePoints, overlayPoints) {
  const merged = new Map(basePoints.map((point) => [point.date, point.value]));
  for (const point of overlayPoints) merged.set(point.date, (merged.get(point.date) ?? 0) + point.value);
  return [...merged.entries()].map(([date, value]) => ({ date, value })).sort((left, right) => new Date(left.date) - new Date(right.date));
}

function sumAlignedSeries(legs) {
  const usableLegs = legs.filter((leg) => leg.length);
  if (usableLegs.length !== legs.length) return [];
  const dates = [...new Set(usableLegs.flat().map((point) => point.date))].sort((left, right) => new Date(left) - new Date(right));
  const output = [];
  for (const date of dates) {
    let total = 0;
    let complete = true;
    for (const leg of usableLegs) {
      const point = latestAtOrBefore(leg, date);
      const gapDays = point ? (new Date(date) - new Date(point.date)) / DAY_MS : Number.POSITIVE_INFINITY;
      if (!point || gapDays > GLOBAL_LIQUIDITY_MAX_GAP_DAYS) {
        complete = false;
        break;
      }
      total += point.value;
    }
    if (complete) output.push({ date, value: total });
  }
  return output;
}

export function calculateGlobalLiquidityModel(seriesList) {
  const series = Object.fromEntries(seriesList.map((item) => [item.key, item]));
  const fed = pointsForSeries(series.fedBalanceSheet);
  const treasury = pointsForSeries(series.treasuryGeneralAccount);
  const reverseRepo = pointsForSeries(series.reverseRepo);
  const m2 = pointsForSeries(series.usM2);
  const ecb = pointsForSeries(series.ecbBalanceSheet);
  const boj = pointsForSeries(series.bojBalanceSheet);
  const pboc = pointsForSeries(series.pbocBalanceSheet);
  const eurUsd = pointsForSeries(series.eurUsd);
  const yenPerUsd = pointsForSeries(series.yenPerUsd);
  const yuanPerUsd = pointsForSeries(series.yuanPerUsd);
  const dollar = pointsForSeries(series.dxy);

  const usLeg = fed.flatMap((point) => {
    const treasuryPoint = latestAtOrBefore(treasury, point.date);
    const reverseRepoPoint = latestAtOrBefore(reverseRepo, point.date);
    if (!treasuryPoint || !reverseRepoPoint) return [];
    const value = point.value - treasuryPoint.value - reverseRepoPoint.value;
    return Number.isFinite(value) && value > 0 ? [{ date: point.date, value }] : [];
  });
  const ecbLeg = alignedUsdLeg(ecb, eurUsd, (value, rate) => value * rate);
  const bojLeg = alignedUsdLeg(boj, yenPerUsd, (value, rate) => (value * 100) / rate);
  const pbocLeg = alignedUsdLeg(pboc, yuanPerUsd, (value, rate) => (value * 1000) / rate);
  if (!usLeg.length || !ecbLeg.length || !bojLeg.length) return null;

  const globalLiquidity = sumAlignedSeries([usLeg, ecbLeg, bojLeg, ...(pbocLeg.length ? [pbocLeg] : [])]);
  if (!globalLiquidity.length) return null;

  const exUs = sumAlignedSeries([ecbLeg, bojLeg]);
  const driverDefinitions = [
    { key: 'globalCentralBank', name: 'Global central-bank impulse', change: changeOverDays(globalLiquidity, 91), scale: 3, weight: 0.3 },
    { key: 'usM2', name: 'US M2 growth', change: changeOverDays(m2, 91), scale: 2, weight: 0.2 },
    { key: 'exUsCentralBank', name: 'ECB + BoJ impulse', change: changeOverDays(exUs, 91), scale: 3, weight: 0.15 },
    { key: 'dollar', name: 'Dollar transmission', change: changeOverDays(dollar, 91), scale: 3, weight: 0.2, inverse: true },
    ...(pbocLeg.length >= 13 ? [{ key: 'pbocCentralBank', name: 'PBoC impulse', change: changeOverDays(pbocLeg, 91), scale: 3, weight: 0.15 }] : []),
  ];
  const coreDriverKeys = ['globalCentralBank', 'usM2', 'exUsCentralBank', 'dollar'];
  const drivers = driverDefinitions.map((driver) => ({
    ...driver,
    impulse: boundedImpulse(driver.change, driver.scale, driver.inverse),
  })).filter((driver) => driver.impulse !== null);
  if (!coreDriverKeys.every((key) => drivers.some((driver) => driver.key === key))) return null;

  const availableWeight = drivers.reduce((total, driver) => total + driver.weight, 0);
  const composite = drivers.reduce((total, driver) => total + (driver.impulse * driver.weight), 0) / availableWeight;
  const positiveDrivers = drivers.filter((driver) => driver.impulse > 0.05).length;
  const negativeDrivers = drivers.filter((driver) => driver.impulse < -0.05).length;
  const agreement = Math.max(positiveDrivers, negativeDrivers) / drivers.length;
  const score = Math.round(clamp(50 + (composite * 50)));
  const regime = composite >= 0.15 ? 'Expansion' : composite <= -0.15 ? 'Contraction' : 'Neutral';
  const shortImpulse = boundedImpulse(changeOverDays(globalLiquidity, 28), 1.5);
  const longImpulse = boundedImpulse(changeOverDays(globalLiquidity, 91), 3);
  const momentum = shortImpulse === null || longImpulse === null
    ? 'Unavailable'
    : shortImpulse > longImpulse ? 'Accelerating' : 'Decelerating';
  const confidenceScore = Math.round(((availableWeight * 0.55) + (agreement * 0.45)) * 100);

  const latestTotal = globalLiquidity.at(-1)?.value ?? null;
  const rankedHistory = globalLiquidity.filter((point) => Number.isFinite(point.value)).map((point) => point.value);
  const cyclePercentile = latestTotal === null || rankedHistory.length < 2
    ? null
    : Math.round((rankedHistory.filter((value) => value <= latestTotal).length / rankedHistory.length) * 100);
  const legSummary = [
    { key: 'us', name: 'United States (net liquidity)', points: usLeg },
    { key: 'ecb', name: 'European Central Bank', points: ecbLeg },
    { key: 'boj', name: 'Bank of Japan', points: bojLeg },
    ...(pbocLeg.length ? [{ key: 'pboc', name: "People's Bank of China", points: pbocLeg, source: 'BIS WS_CBTA (publication lag)' }] : []),
  ].map((leg) => {
    const latest = leg.points.at(-1)?.value ?? null;
    return {
      key: leg.key,
      name: leg.name,
      ...(leg.source ? { source: leg.source } : {}),
      valueUsdMillions: latest,
      sharePercent: latest !== null && latestTotal ? Math.round((latest / latestTotal) * 100) : null,
      change91d: changeOverDays(leg.points, 91),
      change365d: changeOverDays(leg.points, 365),
      asOf: leg.points.at(-1)?.date ?? null,
    };
  });

  return {
    version: 'global-liquidity-v1',
    asOf: globalLiquidity.at(-1)?.date ?? null,
    score,
    regime,
    momentum,
    confidence: confidenceScore >= 75 ? 'High' : confidenceScore >= 50 ? 'Medium' : 'Low',
    confidenceScore,
    breadth: { positive: positiveDrivers, negative: negativeDrivers, total: drivers.length },
    globalLiquidityUsdMillions: latestTotal,
    cyclePercentile,
    centralBanks: legSummary,
    composite,
    history: globalLiquidity,
    drivers: drivers.map(({ key, name, change, impulse, weight }) => ({ key, name, changePercent: change, impulse, weight })),
  };
}

export function buildHeatmapRow({ symbol, name, group, technical, alignment, crowdingPercentile }) {
  if (!technical) return { symbol, name, group, status: 'unavailable' };
  const vol = technical.indicators?.annualizedVolatility20d;
  const trendParts = technical.indicators ?? {};
  const trend = !Number.isFinite(trendParts.sma50) ? 'Unavailable'
    : trendParts.sma50 > trendParts.sma200 ? 'Uptrend'
      : technical.latest > trendParts.sma50 ? 'Recovering'
        : technical.latest < trendParts.sma200 ? 'Downtrend' : 'Range';
  return {
    symbol,
    name,
    group,
    status: 'calculated',
    asOf: technical.asOf,
    score: technical.score,
    regime: technical.score >= 65 ? 'Risk-on' : technical.score >= 55 ? 'Constructive' : technical.score <= 35 ? 'Stress' : 'Neutral',
    trend,
    momentum20d: Number.isFinite(technical.indicators?.momentum20d) ? Number((technical.indicators.momentum20d).toFixed(1)) : null,
    volatility: Number.isFinite(vol) ? vol < 15 ? 'Low' : vol < 25 ? 'Moderate' : 'High' : 'Unavailable',
    annualizedVolatility: Number.isFinite(vol) ? Number(vol.toFixed(1)) : null,
    alignment: Number.isFinite(alignment) ? Math.abs(alignment) >= 0.6 ? 'High' : Math.abs(alignment) >= 0.3 ? 'Medium' : 'Low' : 'Unavailable',
    alignmentValue: Number.isFinite(alignment) ? Number(alignment.toFixed(2)) : null,
    crowding: crowdingPercentile === null || crowdingPercentile === undefined ? 'Unavailable'
      : crowdingPercentile >= 90 ? 'Crowded' : crowdingPercentile >= 70 ? 'Elevated' : crowdingPercentile <= 10 ? 'Light' : 'Balanced',
    crowdingPercentile: crowdingPercentile ?? null,
  };
}

export function calculatePositioningModel(reports) {
  const usable = reports.filter((report) => Array.isArray(report.history) && report.history.length >= 26);
  const contracts = usable.map((report) => {
    const history = [...report.history].sort((left, right) => new Date(left.date) - new Date(right.date));
    const latest = history.at(-1);
    const previous = history.at(-2);
    const nets = history.map((point) => point.netNoncomm).filter(Number.isFinite);
    const percentile = nets.length >= 2 && Number.isFinite(latest.netNoncomm)
      ? Math.round((nets.filter((value) => value <= latest.netNoncomm).length / nets.length) * 100)
      : null;
    const weeklyChange = Number.isFinite(latest.netNoncomm) && Number.isFinite(previous?.netNoncomm)
      ? latest.netNoncomm - previous.netNoncomm
      : null;
    const stance = !Number.isFinite(latest.netNoncomm) ? null
      : latest.netNoncomm > 0 ? 'Leveraged funds net long' : 'Leveraged funds net short';
    const crowd = percentile === null ? null
      : percentile >= 90 ? 'Crowded long' : percentile <= 10 ? 'Crowded short' : 'Unextended';
    return {
      key: report.key,
      name: report.name,
      asOf: latest.date,
      netNoncomm: latest.netNoncomm ?? null,
      weeklyChange,
      percentile,
      stance,
      crowd,
      openInterest: latest.openInterest ?? null,
      observations: history.length,
    };
  });
  const calculatedCount = contracts.filter((contract) => contract.percentile !== null).length;
  return {
    version: 'positioning-cot-v1',
    status: calculatedCount ? 'calculated' : 'unavailable',
    asOf: contracts.map((contract) => contract.asOf).sort().at(-1) ?? null,
    coverage: Math.round((calculatedCount / Math.max(reports.length, 1)) * 100),
    contracts,
    methodology: 'CFTC Commitments of Traders, legacy futures-only report. Net non-commercial position with three-year percentile rank; weekly change versus the prior Tuesday report.',
  };
}

export function calculateChangeCorrelations(leftPoints, rightPoints) {
  const leftByDate = new Map(leftPoints.map((point) => [(point.date ?? point.timestamp).slice(0, 10), point.value]));
  const rightByDate = new Map(rightPoints.map((point) => [(point.date ?? point.timestamp).slice(0, 10), point.value]));
  const dates = [...leftByDate.keys()].filter((date) => Number.isFinite(leftByDate.get(date)) && Number.isFinite(rightByDate.get(date))).sort();
  if (dates.length < 22) return null;

  const leftChanges = [];
  const rightChanges = [];
  for (let index = 1; index < dates.length; index += 1) {
    const leftChange = leftByDate.get(dates[index]) - leftByDate.get(dates[index - 1]);
    const rightChange = rightByDate.get(dates[index]) - rightByDate.get(dates[index - 1]);
    if (!Number.isFinite(leftChange) || !Number.isFinite(rightChange)) continue;
    leftChanges.push(leftChange);
    rightChanges.push(rightChange);
  }
  if (leftChanges.length < 21) return null;

  const correlations = {};
  for (const [key, window] of [['20D', 20], ['60D', 60], ['1Y', 252]]) {
    correlations[key] = leftChanges.length >= window
      ? pearsonCorrelation(leftChanges.slice(-window), rightChanges.slice(-window))
      : null;
  }
  return { correlations, observations: leftChanges.length, asOf: dates.at(-1) };
}

export function buildLiquidityNarrative(usOutputs = [], globalOutputs = []) {
  const entries = [];
  const usLatest = usOutputs[0]?.output ?? null;
  const usPrevious = usOutputs[1]?.output ?? null;
  const globalLatest = globalOutputs[0]?.output ?? null;
  const globalPrevious = globalOutputs[1]?.output ?? null;
  const hasRunPairs = Boolean((usLatest && usPrevious) || (globalLatest && globalPrevious));

  if (usLatest && usPrevious && Number.isFinite(usLatest.score) && Number.isFinite(usPrevious.score)) {
    const delta = usLatest.score - usPrevious.score;
    if (Math.abs(delta) >= 1) entries.push({ key: 'usScore', text: `US liquidity score moved ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} points to ${usLatest.score}/100 since the previous run.` });
    if (usLatest.regime !== usPrevious.regime) entries.push({ key: 'usRegime', text: `US regime shifted from ${usPrevious.regime} to ${usLatest.regime}.` });
  }
  if (globalLatest && globalPrevious && Number.isFinite(globalLatest.score) && Number.isFinite(globalPrevious.score)) {
    const delta = globalLatest.score - globalPrevious.score;
    if (Math.abs(delta) >= 1) entries.push({ key: 'globalScore', text: `Global liquidity score moved ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} points to ${globalLatest.score}/100 since the previous run.` });
    if (globalLatest.regime !== globalPrevious.regime) entries.push({ key: 'globalRegime', text: `Global regime shifted from ${globalPrevious.regime} to ${globalLatest.regime}.` });
    if (Number.isFinite(globalLatest.globalLiquidityUsdMillions) && Number.isFinite(globalPrevious.globalLiquidityUsdMillions) && globalPrevious.globalLiquidityUsdMillions > 0) {
      const changePercent = ((globalLatest.globalLiquidityUsdMillions / globalPrevious.globalLiquidityUsdMillions) - 1) * 100;
      if (Math.abs(changePercent) >= 0.05) entries.push({ key: 'globalPool', text: `Pooled central-bank liquidity ${changePercent > 0 ? 'rose' : 'fell'} ${Math.abs(changePercent).toFixed(2)}% to ${formatUsdBillions(globalLatest.globalLiquidityUsdMillions)}.` });
    }
  }

  if (entries.length) return { status: 'updated', entries };
  return { status: hasRunPairs ? 'stable' : 'insufficient-history', entries: [] };
}

const WORKSPACE_VITALS = {
  'market-heatmap': (workspace) => {
    const scores = (workspace.assets ?? []).map((asset) => asset.score).filter(Number.isFinite);
    return scores.length ? [{ key: 'avgScore', label: 'heatmap average score', value: Math.round(scores.reduce((total, score) => total + score, 0) / scores.length), threshold: 2 }] : [];
  },
  'metals-workspace': (workspace) => [
    ...(Number.isFinite(workspace.cot?.percentile) ? [{ key: 'goldCot', label: 'gold COT percentile', value: workspace.cot.percentile, threshold: 3 }] : []),
    ...(Number.isFinite(workspace.ratios?.goldSilver?.ratio) ? [{ key: 'goldSilver', label: 'gold/silver ratio', value: workspace.ratios.goldSilver.ratio, threshold: 1 }] : []),
  ],
  'fx-workspace': (workspace) => Number.isFinite(workspace.usdCot?.percentile) ? [{ key: 'usdCot', label: 'USD index COT percentile', value: workspace.usdCot.percentile, threshold: 3 }] : [],
  'sentiment-snapshot': (workspace) => [
    ...(Number.isFinite(workspace.fearGreed?.score) ? [{ key: 'fearGreedScore', label: 'CNN Fear & Greed score', value: workspace.fearGreed.score, threshold: 3 }] : []),
    ...(workspace.fearGreed?.rating ? [{ key: 'fearGreedRating', label: 'Fear & Greed rating', string: workspace.fearGreed.rating }] : []),
  ],
  'bitcoin-cycle': (workspace) => [
    ...(Number.isFinite(workspace.valuation?.mvrvZ) ? [{ key: 'mvrvZ', label: 'MVRV Z-score', value: workspace.valuation.mvrvZ, threshold: 0.05 }] : []),
    ...(Number.isFinite(workspace.leverage?.annualizedPercent) ? [{ key: 'fundingApr', label: 'aggregate funding APR %', value: workspace.leverage.annualizedPercent, threshold: 0.5 }] : []),
  ],
  'equity-risk': (workspace) => [
    ...(Number.isFinite(workspace.spxBreadth?.pctAbove200) ? [{ key: 'pctAbove200', label: '% of S&P 500 above 200-day', value: workspace.spxBreadth.pctAbove200, threshold: 2 }] : []),
    ...(Number.isFinite(workspace.creditStress?.level) ? [{ key: 'hyOas', label: 'high-yield OAS', value: workspace.creditStress.level, threshold: 0.1 }] : []),
  ],
};

export function buildWorkspaceNarrative(outputsByKey = {}) {
  const entries = [];
  let hasPairs = false;
  for (const [modelId, outputs] of Object.entries(outputsByKey)) {
    const latest = outputs?.[0]?.output ?? null;
    const previous = outputs?.[1]?.output ?? null;
    if (!latest || !previous) continue;
    hasPairs = true;
    const extract = WORKSPACE_VITALS[modelId];
    if (!extract) continue;
    const latestVitals = extract(latest);
    const previousVitals = extract(previous);
    for (const vital of latestVitals) {
      const before = previousVitals.find((candidate) => candidate.key === vital.key);
      if (!before) continue;
      if (vital.string !== undefined) {
        if (vital.string !== before.string) entries.push({ key: `${modelId}:${vital.key}`, text: `${vital.label} shifted from ${before.string} to ${vital.string}.` });
      } else if (Number.isFinite(vital.value) && Number.isFinite(before.value)) {
        const delta = Math.round((vital.value - before.value) * 100) / 100;
        if (Math.abs(delta) >= vital.threshold) entries.push({ key: `${modelId}:${vital.key}`, text: `${vital.label} ${delta > 0 ? 'rose' : 'fell'} ${Math.abs(delta)} to ${vital.value}.` });
      }
    }
  }
  if (entries.length) return { status: 'updated', entries };
  return { status: hasPairs ? 'stable' : 'insufficient-history', entries: [] };
}

function formatUsdBillions(valueInMillions) {
  const billions = valueInMillions / 1000;
  return billions >= 1000 ? `$${(billions / 1000).toFixed(2)}T` : `$${billions.toFixed(1)}B`;
}

export function calculateUsdStrengthModel(seriesList, liquidityModel = null) {
  const series = Object.fromEntries(seriesList.map((item) => [item.key, item]));
  const dollar = pointsForSeries(series.dxy);
  const dollarTechnical = calculateTechnicalSnapshot(dollar.map((point) => ({ timestamp: `${point.date}T00:00:00.000Z`, value: point.value })));
  if (!dollarTechnical) return null;

  const realYield = pointsForSeries(series.realYield10y);
  const frontEndYield = pointsForSeries(series.us2yYield);
  const financialConditions = pointsForSeries(series.financialConditions);
  const volatility = pointsForSeries(series.vix);
  const realYieldChange = absoluteChangeOverDays(realYield, 91);
  const frontEndChange = absoluteChangeOverDays(frontEndYield, 91);
  const financialConditionsChange = absoluteChangeOverDays(financialConditions, 91);
  const vixLatest = volatility.at(-1)?.value ?? null;
  const financialConditionsLatest = financialConditions.at(-1)?.value ?? null;
  const stressScores = [
    Number.isFinite(vixLatest) ? clamp(50 + ((vixLatest - 20) * 3)) : null,
    Number.isFinite(financialConditionsLatest) ? clamp(50 + (financialConditionsLatest * 35) + ((financialConditionsChange ?? 0) * 25)) : null,
  ].filter(Number.isFinite);
  const drivers = [
    { key: 'dollarTrend', name: 'Broad-dollar trend', score: dollarTechnical.components.trend, weight: 0.3, value: dollarTechnical.latest, change: dollarTechnical.indicators.momentum20d, source: 'FRED DTWEXBGS' },
    { key: 'dollarMomentum', name: 'Broad-dollar momentum', score: dollarTechnical.components.momentum, weight: 0.15, value: dollarTechnical.indicators.rsi14, change: dollarTechnical.indicators.momentum20d, source: 'FRED DTWEXBGS' },
    { key: 'realYield', name: '10Y real-yield impulse', score: realYieldChange === null ? null : clamp(50 + (Math.tanh(realYieldChange / 0.5) * 50)), weight: 0.15, value: realYield.at(-1)?.value, change: realYieldChange, source: 'FRED DFII10' },
    { key: 'frontEnd', name: '2Y yield impulse', score: frontEndChange === null ? null : clamp(50 + (Math.tanh(frontEndChange / 0.75) * 50)), weight: 0.1, value: frontEndYield.at(-1)?.value, change: frontEndChange, source: 'FRED DGS2' },
    { key: 'stress', name: 'Dollar-smile stress support', score: stressScores.length ? mean(stressScores) : null, weight: 0.15, value: vixLatest, change: financialConditionsChange, source: 'FRED VIXCLS / NFCI' },
    { key: 'liquidity', name: 'Inverse dollar-liquidity impulse', score: Number.isFinite(liquidityModel?.score) ? 100 - liquidityModel.score : null, weight: 0.15, value: liquidityModel?.score, change: liquidityModel?.composite, source: liquidityModel?.version },
  ];
  const model = driverComposite(drivers, 0.45, 2);
  if (!model.publishable) return null;
  const regime = model.score >= 70 ? 'Strong' : model.score >= 58 ? 'Firm' : model.score <= 30 ? 'Weak' : model.score <= 42 ? 'Soft' : 'Neutral';
  const confidenceScore = Math.round((model.coverage * 0.8) + (Math.min(dollarTechnical.observations / 252, 1) * 20));
  const dollarSmile = vixLatest >= 25
    ? 'Global stress support'
    : Number.isFinite(vixLatest) && Number.isFinite(realYieldChange)
      ? realYieldChange > 0 && dollarTechnical.components.trend >= 50 ? 'U.S. real-yield support' : 'Balanced / inactive'
      : null;
  return {
    version: 'usd-strength-v1',
    status: model.coverage >= 75 ? 'calculated' : 'provisional',
    asOf: dollar.at(-1)?.date ?? null,
    source: 'FRED broad U.S. dollar index and U.S. macro drivers',
    proxy: 'DTWEXBGS is a broad trade-weighted dollar index, not the ICE DXY level.',
    score: model.score,
    regime,
    coverage: model.coverage,
    confidence: confidenceScore >= 80 ? 'High' : confidenceScore >= 60 ? 'Medium' : 'Low',
    confidenceScore,
    dollarSmile,
    missing: model.missing,
    drivers: model.drivers,
    indicators: dollarTechnical.indicators,
    observations: dollarTechnical.observations,
    history: dollar,
  };
}

const MACRO_REGIME_SETTINGS = {
  'Expansion / risk-on': { riskBudget: 'High', alertThreshold: 68, holdingPeriod: '20-60 sessions', emphasis: 'Trend and cyclical beta' },
  Constructive: { riskBudget: 'Moderate-high', alertThreshold: 65, holdingPeriod: '15-45 sessions', emphasis: 'Quality growth and selective cyclicals' },
  'Transition / choppy': { riskBudget: 'Moderate', alertThreshold: 72, holdingPeriod: '5-20 sessions', emphasis: 'Relative value and mean reversion' },
  'Contraction / risk-off': { riskBudget: 'Low', alertThreshold: 75, holdingPeriod: '5-30 sessions', emphasis: 'Defensive quality and liquidity' },
  'Stress / deleveraging': { riskBudget: 'Minimal', alertThreshold: 80, holdingPeriod: '1-10 sessions', emphasis: 'Capital preservation and convexity' },
};

export function calculateMacroRegimeModel(seriesList, liquidityModel = null, usdStrengthModel = null, globalLiquidityModel = null) {
  const series = Object.fromEntries(seriesList.map((item) => [item.key, item]));
  const financialConditions = pointsForSeries(series.financialConditions);
  const credit = pointsForSeries(series.highYieldSpread);
  const volatility = pointsForSeries(series.vix);
  const financialLatest = financialConditions.at(-1)?.value ?? null;
  const creditLatest = credit.at(-1)?.value ?? null;
  const vixLatest = volatility.at(-1)?.value ?? null;
  const financialChange = absoluteChangeOverDays(financialConditions, 91);
  const creditChange = absoluteChangeOverDays(credit, 91);
  const drivers = [
    { key: 'liquidity', name: 'US liquidity impulse', score: liquidityModel?.score, weight: 0.25, value: liquidityModel?.score, change: liquidityModel?.composite, source: liquidityModel?.version },
    { key: 'globalLiquidity', name: 'Global liquidity impulse', score: globalLiquidityModel?.score, weight: 0.15, value: globalLiquidityModel?.score, change: globalLiquidityModel?.composite, source: globalLiquidityModel?.version },
    { key: 'financialConditions', name: 'Financial conditions', score: Number.isFinite(financialLatest) ? clamp(50 - (financialLatest * 40) - ((financialChange ?? 0) * 30)) : null, weight: 0.2, value: financialLatest, change: financialChange, source: 'FRED NFCI' },
    { key: 'credit', name: 'High-yield credit', score: Number.isFinite(creditLatest) ? clamp(80 - ((creditLatest - 3) * 15) - ((creditChange ?? 0) * 20)) : null, weight: 0.18, value: creditLatest, change: creditChange, source: 'FRED BAMLH0A0HYM2' },
    { key: 'volatility', name: 'Equity volatility', score: Number.isFinite(vixLatest) ? clamp(100 - ((vixLatest - 12) * 3.5)) : null, weight: 0.12, value: vixLatest, change: absoluteChangeOverDays(volatility, 28), source: 'FRED VIXCLS' },
    { key: 'dollar', name: 'Inverse dollar pressure', score: Number.isFinite(usdStrengthModel?.score) ? 100 - usdStrengthModel.score : null, weight: 0.1, value: usdStrengthModel?.score, change: usdStrengthModel?.indicators?.momentum20d, source: usdStrengthModel?.version },
  ];
  const model = driverComposite(drivers, 0.4, 2);
  if (!model.publishable) {
    return { version: 'macro-regime-v1', status: 'unavailable', asOf: null, score: null, regime: null, settings: null, coverage: model.coverage, panicConfirmed: null, missing: model.missing, drivers: model.drivers };
  }
  const panicInputsAvailable = [vixLatest, creditLatest, financialLatest].every(Number.isFinite);
  const panicConfirmed = panicInputsAvailable ? vixLatest >= 35 && creditLatest >= 5 && financialLatest >= 0.5 : null;
  const regime = panicConfirmed
    ? 'Stress / deleveraging'
    : model.score >= 70 ? 'Expansion / risk-on' : model.score >= 58 ? 'Constructive' : model.score <= 35 ? 'Contraction / risk-off' : 'Transition / choppy';
  const asOf = [liquidityModel?.asOf, usdStrengthModel?.asOf, financialConditions.at(-1)?.date, credit.at(-1)?.date, volatility.at(-1)?.date].filter(Boolean).sort().at(-1) ?? null;
  return {
    version: 'macro-regime-v1',
    status: model.coverage >= 75 ? 'calculated' : 'provisional',
    asOf,
    score: model.score,
    regime,
    coverage: model.coverage,
    confidence: model.coverage >= 85 ? 'High' : model.coverage >= 65 ? 'Medium' : 'Low',
    panicConfirmed,
    missing: model.missing,
    drivers: model.drivers,
    settings: MACRO_REGIME_SETTINGS[regime],
  };
}
