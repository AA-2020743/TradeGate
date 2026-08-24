const TRADING_DAYS = 252;
const DAY_MS = 86_400_000;

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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

/**
 * Scans the cross-correlation of two change series across a lag window. A
 * positive `bestLag` means seriesX moves first. `rankBy: 'magnitude'` picks the
 * strongest relationship in either direction, which is what a genuinely inverse
 * macro pair needs — ranking a dollar/bitcoin scan by signed correlation would
 * report a weak positive blip instead of the real inverse link.
 */
export function calculateLeadLag(seriesX, seriesY, maxLagBars = 4, minObservations = 30, { rankBy = 'signed' } = {}) {
  if (!Array.isArray(seriesX) || !Array.isArray(seriesY)) return null;
  const curve = [];
  for (let lag = -maxLagBars; lag <= maxLagBars; lag += 1) {
    const xs = [];
    const ys = [];
    const start = lag >= 0 ? 0 : -lag;
    for (let index = start; index + Math.max(lag, 0) < seriesX.length && index < seriesY.length; index += 1) {
      const xValue = seriesX[index];
      const yValue = seriesY[index + lag];
      if (Number.isFinite(xValue) && Number.isFinite(yValue)) {
        xs.push(xValue);
        ys.push(yValue);
      }
    }
    if (xs.length < minObservations) continue;
    const meanX = xs.reduce((total, value) => total + value, 0) / xs.length;
    const meanY = ys.reduce((total, value) => total + value, 0) / ys.length;
    let covariance = 0;
    let varianceX = 0;
    let varianceY = 0;
    for (let index = 0; index < xs.length; index += 1) {
      covariance += (xs[index] - meanX) * (ys[index] - meanY);
      varianceX += (xs[index] - meanX) ** 2;
      varianceY += (ys[index] - meanY) ** 2;
    }
    const corr = varianceX > 0 && varianceY > 0 ? covariance / Math.sqrt(varianceX * varianceY) : 0;
    curve.push({ lag, corr: Math.round(corr * 1000) / 1000, observations: xs.length });
  }
  if (!curve.length) return null;
  const strength = rankBy === 'magnitude' ? (point) => Math.abs(point.corr) : (point) => point.corr;
  const best = curve.reduce((left, right) => (strength(right) > strength(left) ? right : left));
  return {
    bestLag: best.lag,
    corrAtBest: best.corr,
    synchronousCorr: (curve.find((point) => point.lag === 0) ?? {}).corr ?? null,
    observations: best.observations,
    curve,
  };
}

export function buildLiquidityTransmission(liquidityPoints, assetPoints, assetName, { changeBars = 4, maxLagWeeks = 8, minObservations = 40 } = {}) {
  if (!Array.isArray(liquidityPoints) || liquidityPoints.length < changeBars + minObservations || !Array.isArray(assetPoints) || assetPoints.length < 30) {
    return { asset: assetName, status: 'unavailable', reason: 'Liquidity and asset histories must both cover the transmission window.' };
  }
  const assetByDate = new Map();
  for (const point of assetPoints) {
    const value = Number(point.value);
    if (Number.isFinite(value)) assetByDate.set(String(point.timestamp).slice(0, 10), value);
  }
  const assetDates = [...assetByDate.keys()].sort();
  // Bounded, because carrying the last asset close forward past the end of its
  // own history manufactures flat bars: the correlation then sees a stretch of
  // "the asset did not move" that is really "the feed stopped", which pulls the
  // measured link toward zero and inflates the observation count behind it.
  const ASSET_MAX_GAP_DAYS = 10;
  const assetClosest = (date) => {
    for (let index = assetDates.length - 1; index >= 0; index -= 1) {
      if (assetDates[index] > date) continue;
      const gapDays = (new Date(date) - new Date(assetDates[index])) / DAY_MS;
      return gapDays <= ASSET_MAX_GAP_DAYS ? assetByDate.get(assetDates[index]) : null;
    }
    return null;
  };
  const liquidityValues = [];
  const assetValues = [];
  for (const point of liquidityPoints) {
    const liquidityValue = Number(point.value);
    const assetValue = assetClosest(String(point.date).slice(0, 10));
    if (Number.isFinite(liquidityValue) && Number.isFinite(assetValue)) {
      liquidityValues.push(liquidityValue);
      assetValues.push(assetValue);
    }
  }
  if (liquidityValues.length < changeBars + minObservations) {
    return { asset: assetName, status: 'unavailable', reason: 'Not enough aligned weekly observations.' };
  }
  const pctChange = (series, index) => (series[index - changeBars] > 0 ? (series[index] / series[index - changeBars] - 1) * 100 : null);
  const liquidityChanges = [];
  const assetChanges = [];
  for (let index = changeBars; index < liquidityValues.length; index += 1) {
    const liquidityChange = pctChange(liquidityValues, index);
    const assetChange = pctChange(assetValues, index);
    if (Number.isFinite(liquidityChange) && Number.isFinite(assetChange)) {
      liquidityChanges.push(liquidityChange);
      assetChanges.push(assetChange);
    }
  }
  const leadLag = calculateLeadLag(liquidityChanges, assetChanges, maxLagWeeks, minObservations, { rankBy: 'magnitude' });
  if (!leadLag) return { asset: assetName, status: 'unavailable', reason: 'Cross-correlation needs more overlapping changes.' };
  const decisive = Math.abs(leadLag.corrAtBest) >= 0.2;
  const direction = leadLag.corrAtBest >= 0 ? 'supportive' : 'inverse';
  return {
    asset: assetName,
    status: 'calculated',
    changeWindowDays: changeBars * 7,
    bestLagWeeks: leadLag.bestLag,
    corrAtBest: leadLag.corrAtBest,
    synchronousCorr: leadLag.synchronousCorr,
    observations: leadLag.observations,
    direction,
    read: !decisive ? 'No decisive transmission' : leadLag.bestLag >= 2 ? `Liquidity leads ${assetName} by ~${leadLag.bestLag}w (${direction})` : leadLag.bestLag <= -2 ? `${assetName} leads liquidity by ~${-leadLag.bestLag}w (${direction})` : `Contemporaneous link (${direction})`,
  };
}

const HEADLINE_POSITIVE_WORDS = ['surge', 'surges', 'soar', 'soars', 'rally', 'rallies', 'jump', 'jumps', 'record high', 'beats', 'beat expectations', 'upbeat', 'strengthens', 'gains', 'climbs', 'rebounds', 'eases inflation', 'cooling inflation', 'rate cut', 'dovish', 'stimulus', 'expands', 'upgrade', 'upgraded', 'optimism', 'recovery'];
const HEADLINE_NEGATIVE_WORDS = ['plunge', 'plunges', 'slump', 'slumps', 'tumble', 'tumbles', 'selloff', 'sell-off', 'slides', 'falls', 'drops', 'recession', 'fears', 'warns', 'warning', 'crisis', 'default', 'layoffs', 'downgrade', 'downgraded', 'hawkish', 'rate hike', 'inflation spike', 'contraction', 'weakens', 'misses', 'miss on', 'cuts outlook', 'risk aversion'];

export function classifyHeadlineSentiment(title) {
  const text = String(title ?? '').toLowerCase();
  if (!text) return { tone: 'neutral', matches: [] };
  const positive = HEADLINE_POSITIVE_WORDS.filter((word) => text.includes(word));
  const negative = HEADLINE_NEGATIVE_WORDS.filter((word) => text.includes(word));
  if (positive.length > negative.length) return { tone: 'positive', matches: positive };
  if (negative.length > positive.length) return { tone: 'negative', matches: negative };
  return { tone: 'neutral', matches: [...positive, ...negative] };
}

export function calculateTrendQuality(values, period = 90) {
  if (!Array.isArray(values)) return null;
  const window = values.slice(-period);
  if (window.length < period || !window.every((value) => Number.isFinite(value) && value > 0)) return null;
  const logs = window.map((value) => Math.log(value));
  const meanIndex = (logs.length - 1) / 2;
  const meanLog = mean(logs);
  let covariance = 0;
  let indexVariance = 0;
  for (let index = 0; index < logs.length; index += 1) {
    covariance += (index - meanIndex) * (logs[index] - meanLog);
    indexVariance += (index - meanIndex) ** 2;
  }
  if (indexVariance <= 0) return null;
  const slope = covariance / indexVariance;
  const intercept = meanLog - (slope * meanIndex);
  let residualSquares = 0;
  let totalSquares = 0;
  for (let index = 0; index < logs.length; index += 1) {
    residualSquares += (logs[index] - (intercept + (slope * index))) ** 2;
    totalSquares += (logs[index] - meanLog) ** 2;
  }
  const r2 = totalSquares > 0 ? clamp(1 - (residualSquares / totalSquares), 0, 1) : 0;
  const annualizedSlopePct = Math.round(clamp((Math.exp(slope * TRADING_DAYS) - 1) * 100, -100, 10_000) * 10) / 10;
  return {
    observations: logs.length,
    annualizedSlopePct,
    r2: Math.round(r2 * 1000) / 1000,
    quality: Math.round(annualizedSlopePct * r2 * 10) / 10,
  };
}

export function calculateScreenerScores(rows) {
  if (!Array.isArray(rows)) return [];
  const momValues = rows.map((row) => row.mom20).filter(Number.isFinite);
  const trendValues = rows.map((row) => row.vsSma200).filter(Number.isFinite);
  const volValues = rows.map((row) => row.vol20).filter(Number.isFinite);
  const qualityValues = rows.map((row) => row.trendQuality).filter(Number.isFinite);
  const rankOf = (values, value) => (values.length ? Math.round((values.filter((item) => item <= value).length / values.length) * 100) : null);
  return rows.map((row) => {
    const momentumRank = Number.isFinite(row.mom20) ? rankOf(momValues, row.mom20) : null;
    const trendRank = Number.isFinite(row.vsSma200) ? rankOf(trendValues, row.vsSma200) : null;
    const calmRank = Number.isFinite(row.vol20) && volValues.length ? 100 - rankOf(volValues, row.vol20) : null;
    return {
      ...row,
      qualityRank: Number.isFinite(row.trendQuality) ? rankOf(qualityValues, row.trendQuality) : null,
      score: momentumRank !== null && trendRank !== null && calmRank !== null
        ? Math.round((momentumRank * 0.45) + (trendRank * 0.35) + (calmRank * 0.2))
        : null,
    };
  });
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
  // Log returns need positive values at both ends. A session that fails that
  // is dropped from both legs together, because dropping it from one would
  // silently pair each return with its neighbour's.
  const leftReturns = [];
  const rightReturns = [];
  for (let index = 1; index < dates.length; index += 1) {
    const usable = leftValues[index] > 0 && leftValues[index - 1] > 0
      && rightValues[index] > 0 && rightValues[index - 1] > 0;
    if (!usable) continue;
    leftReturns.push(Math.log(leftValues[index] / leftValues[index - 1]));
    rightReturns.push(Math.log(rightValues[index] / rightValues[index - 1]));
  }
  if (leftReturns.length < 21) return null;

  const correlations = {};
  for (const window of [20, 60, 252]) {
    correlations[window] = leftReturns.length >= window
      ? pearsonCorrelation(leftReturns.slice(-window), rightReturns.slice(-window))
      : null;
  }
  const activeCorrelation = correlations[60] ?? correlations[20];
  const momentumLookback = Math.min(20, leftValues.length - 1);
  const leftBase = leftValues.at(-(momentumLookback + 1));
  const rightBase = rightValues.at(-(momentumLookback + 1));
  const leftMomentum = leftBase > 0 ? ((leftValues.at(-1) / leftBase) - 1) * 100 : null;
  const rightMomentum = rightBase > 0 ? ((rightValues.at(-1) / rightBase) - 1) * 100 : null;
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
    // With no correlation measured there is no regime to name; "Unstable" is a
    // finding, not a stand-in for a missing one.
    regime: !Number.isFinite(activeCorrelation) ? 'Unavailable'
      : activeCorrelation <= -0.4 ? 'Inverse'
        : activeCorrelation >= 0.4 ? 'Positive' : 'Unstable',
    momentum: { left: leftMomentum, right: rightMomentum },
    divergence: activeCorrelation <= -0.4
      ? Math.sign(leftMomentum) === Math.sign(rightMomentum) ? 'Inverse relationship diverging' : 'Inverse relationship aligned'
      : activeCorrelation >= 0.4 ? 'Positive relationship' : 'Relationship unstable',
    leftBreakout,
    leadLag: calculateSeriesLeadLag(leftReturns, rightReturns, dates),
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
  // A zero base makes this 0/0. An all-zero series is not hypothetical: a
  // provider returning zeros used to publish score: NaN straight to the page.
  const momentumPercent = momentumBase > 0 ? ((latest / momentumBase) - 1) * 100 : null;
  const recentValues = values.slice(-21);
  const returns = recentValues.slice(1).map((value, index) => {
    const base = recentValues[index];
    return base > 0 && value > 0 ? Math.log(value / base) : null;
  }).filter(Number.isFinite);
  const annualizationDays = options.annualizationDays ?? TRADING_DAYS;
  // Log returns need positive prices at both ends, so a series that dips to or
  // below zero yields nothing to measure. Defaulting that to 0 published a
  // fabricated "0% volatility" and handed the calm score its maximum; unknown
  // has to stay unknown and score neutral.
  const returnDeviation = standardDeviation(returns);
  const volatility = returnDeviation === null ? null : returnDeviation * Math.sqrt(annualizationDays) * 100;
  const TREND_AVERAGES = 3;
  const movingAverages = [sma20, sma50, sma200].filter(Number.isFinite);
  // A short history has no 50- or 200-day average, and averaging only the
  // checks that exist let one of them swing the full trend weight: the same
  // latest bar scored 33 on 30 observations and 53 on 306, a different regime
  // label off nothing but the depth of history behind it. Shrink toward
  // neutral by how much of the ladder is actually answerable, and say so.
  const trendCoverage = movingAverages.length / TREND_AVERAGES;
  const observedTrend = mean(movingAverages.map((average) => latest >= average ? 100 : 0));
  const trendScore = observedTrend === null ? 50 : 50 + ((observedTrend - 50) * trendCoverage);
  const macdPercent = macd && latest > 0 ? (macd.histogram / latest) * 100 : null;
  // With neither leg measurable there is nothing to say about momentum, so it
  // scores neutral rather than inheriting whichever leg happened to survive.
  const momentumScore = momentumPercent === null && macdPercent === null
    ? 50
    : clamp(50 + ((momentumPercent ?? 0) * 2.5) + ((macdPercent ?? 0) * 40));
  const rsiScore = rsi === null ? 50 : clamp(((rsi - 30) / 40) * 100);
  const volatilityScore = volatility === null ? 50 : clamp(100 - volatility);
  const score = Math.round((trendScore * 0.4) + (momentumScore * 0.35) + (rsiScore * 0.2) + (volatilityScore * 0.05));
  const regime = score >= 65 ? 'Constructive' : score <= 35 ? 'Guarded' : 'Neutral';
  const trailingWindow = values.length > 200 ? values.slice(-252) : values;
  const yearHigh = trailingWindow.length ? Math.max(...trailingWindow) : null;
  const pctFrom52wHigh = Number.isFinite(yearHigh) && yearHigh > 0 ? Math.round(((latest / yearHigh) - 1) * 1000) / 10 : null;

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
      pctFrom52wHigh,
    },
    components: {
      trend: Math.round(trendScore),
      // How many of the 20/50/200 checks the history could answer. A reader
      // comparing two symbols needs to know one of them was scored on less.
      trendCoverage: Math.round(trendCoverage * 100),
      trendAveragesUsed: movingAverages.length,
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

/** Median gap between observations, which is what "this series' cadence" means. */
function medianSpacingDays(points) {
  if (points.length < 3) return null;
  const gaps = points.slice(1).map((point, index) => (new Date(point.date) - new Date(points[index].date)) / DAY_MS);
  const sorted = gaps.filter((gap) => gap > 0).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Locates the comparison point for a change over `days`, and refuses one that is
 * too far back to be that change.
 *
 * This used to take the most recent observation at or before the target date
 * with no bound on how far before. A series with a publication gap then reported
 * a 251-day change as a 91-day one, which saturated the impulse and pushed the
 * liquidity model into Expansion on what was really a data outage. The tolerance
 * scales with the series' own cadence, so a monthly series may still land a few
 * weeks off target while a genuine gap is rejected.
 */
function comparisonPoint(points, days) {
  if (points.length < 2) return null;
  const latest = points.at(-1);
  const targetTime = new Date(latest.date).getTime() - (days * DAY_MS);
  const previous = latestAtOrBefore(points, new Date(targetTime).toISOString().slice(0, 10));
  if (!previous) return null;
  const spanDays = (new Date(latest.date) - new Date(previous.date)) / DAY_MS;
  const cadence = medianSpacingDays(points) ?? 1;
  // A series cannot answer a question finer than its own resolution: a
  // quarterly series has no 28-day change, and reaching a full quarter back to
  // produce one is not that change under a different name.
  if (cadence > days) return null;
  const tolerance = Math.max(7, days * 0.15, cadence);
  if (spanDays > days + tolerance) return null;
  return { latest, previous, spanDays: Math.round(spanDays) };
}

/** The measured change together with the span it was actually measured over. */
export function measureChangeOverDays(points, days) {
  const found = comparisonPoint(points, days);
  if (!found) return null;
  const { latest, previous, spanDays } = found;
  return {
    spanDays,
    fromDate: previous.date,
    toDate: latest.date,
    absolute: latest.value - previous.value,
    // Percent change off a negative base flips sign: a spread improving from
    // -0.50 to -0.25 computes as -50%. The absolute move is still meaningful,
    // so withhold the ratio rather than the whole measurement.
    percent: previous.value > 0 ? ((latest.value / previous.value) - 1) * 100 : null,
  };
}

function changeOverDays(points, days) {
  return measureChangeOverDays(points, days)?.percent ?? null;
}


function boundedImpulse(change, scale, inverse = false) {
  if (!Number.isFinite(change)) return null;
  const impulse = Math.tanh(change / scale);
  return inverse ? -impulse : impulse;
}

/**
 * A driver's change over a requested window, carrying the window it actually
 * covered. A 91-day request lands on whatever observation is nearest 91 days
 * back, which for a weekly series is rarely exactly 91 - and the model used to
 * publish the change while discarding the span, so "91-day impulse" was a
 * claim the payload could not substantiate.
 */
function driverChange(points, days) {
  const measured = measureChangeOverDays(points, days);
  return {
    change: measured?.percent ?? null,
    requestedDays: days,
    spanDays: measured?.spanDays ?? null,
    measuredFrom: measured?.fromDate ?? null,
  };
}

function absoluteChangeOverDays(points, days) {
  const measured = measureChangeOverDays(points, days);
  return measured ? measured.absolute : null;
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

// Below this the two impulses are the same reading and the label was being
// decided by float noise: a 1e-9 difference flipped Accelerating to Decelerating.
const IMPULSE_MOMENTUM_BAND = 0.02;

function describeImpulseMomentum(shortImpulse, longImpulse) {
  if (shortImpulse === null || longImpulse === null) return 'Unavailable';
  const gap = shortImpulse - longImpulse;
  if (Math.abs(gap) < IMPULSE_MOMENTUM_BAND) return 'Steady';
  return gap > 0 ? 'Accelerating' : 'Decelerating';
}

/**
 * True when a model actually published a reading. Models that cannot publish
 * now return an object carrying the reason rather than a bare null, so a plain
 * truthiness check would treat "unavailable, and here is why" as a result.
 */
export function isPublished(model) {
  return Boolean(model) && model.status !== 'unavailable';
}

export function calculateUsLiquidityModel(seriesList) {
  const series = Object.fromEntries(seriesList.map((item) => [item.key, item]));
  const fed = pointsForSeries(series.fedBalanceSheet);
  const treasury = pointsForSeries(series.treasuryGeneralAccount);
  const reverseRepo = pointsForSeries(series.reverseRepo);
  const m2 = pointsForSeries(series.usM2);
  const dollar = pointsForSeries(series.dxy);

  const netLiquidity = buildNetLiquiditySeries(fed, treasury, reverseRepo);

  const driverDefinitions = [
    { key: 'netLiquidity', name: 'Fed net liquidity', ...driverChange(netLiquidity, 91), scale: 3, weight: 0.55 },
    { key: 'usM2', name: 'US M2 growth', ...driverChange(m2, 91), scale: 2, weight: 0.25 },
    { key: 'dollar', name: 'Dollar transmission', ...driverChange(dollar, 91), scale: 3, weight: 0.2, inverse: true },
  ];
  const drivers = driverDefinitions.map((driver) => ({
    ...driver,
    impulse: boundedImpulse(driver.change, driver.scale, driver.inverse),
  })).filter((driver) => driver.impulse !== null);
  if (drivers.length !== driverDefinitions.length) {
    const missing = driverDefinitions.filter((definition) => !drivers.some((driver) => driver.key === definition.key));
    return {
      version: 'us-liquidity-v1',
      status: 'unavailable',
      reason: `Every driver is mandatory for the net-liquidity impulse; missing ${missing.map((driver) => driver.name).join(', ')}.`,
      asOf: netLiquidity.at(-1)?.date ?? null,
      score: null,
      regime: null,
      momentum: 'Unavailable',
      netLiquidity: netLiquidity.at(-1)?.value ?? null,
      history: netLiquidity,
      missing: missing.map((driver) => driver.name),
      drivers: driverDefinitions.map(({ key, name, weight, requestedDays }) => ({ key, name, changePercent: null, impulse: null, weight, requestedDays, spanDays: null, measuredFrom: null })),
    };
  }

  const availableWeight = drivers.reduce((total, driver) => total + driver.weight, 0);
  const composite = drivers.reduce((total, driver) => total + (driver.impulse * driver.weight), 0) / availableWeight;
  const positiveDrivers = drivers.filter((driver) => driver.impulse > 0.05).length;
  const negativeDrivers = drivers.filter((driver) => driver.impulse < -0.05).length;
  const agreement = Math.max(positiveDrivers, negativeDrivers) / drivers.length;
  const score = Math.round(clamp(50 + (composite * 50)));
  const regime = composite >= 0.15 ? 'Expansion' : composite <= -0.15 ? 'Contraction' : 'Neutral';
  const shortNetImpulse = boundedImpulse(changeOverDays(netLiquidity, 28), 1.5);
  const longNetImpulse = boundedImpulse(changeOverDays(netLiquidity, 91), 3);
  const momentum = describeImpulseMomentum(shortNetImpulse, longNetImpulse);
  // Same bound as every other windowed change: a leg that cannot reach back
  // inside the window drops out of the decomposition instead of contributing a
  // longer change under the window's name.
  const deltaOverDays = (points, days) => absoluteChangeOverDays(points, days);
  const decomposition = [28, 91].map((windowDays) => {
    const fedDelta = deltaOverDays(fed, windowDays);
    const tgaDelta = deltaOverDays(treasury, windowDays);
    const rrpDelta = deltaOverDays(reverseRepo, windowDays);
    if (fedDelta === null || tgaDelta === null || rrpDelta === null) return null;
    const legs = [
      { key: 'fedBalanceSheet', name: 'Fed balance sheet', contribution: fedDelta },
      { key: 'treasuryGeneralAccount', name: 'TGA rebuild', contribution: -tgaDelta },
      { key: 'reverseRepo', name: 'Reverse-repo drawdown', contribution: -rrpDelta },
    ];
    const dominant = legs.reduce((best, leg) => (Math.abs(leg.contribution) > Math.abs(best.contribution) ? leg : best), legs[0]);
    return {
      windowDays,
      netChange: legs.reduce((total, leg) => total + leg.contribution, 0),
      legs,
      dominantLeg: dominant.key,
      unit: 'USD millions',
    };
  }).filter(Boolean);
  const confidenceScore = Math.round(((availableWeight * 0.55) + (agreement * 0.45)) * 100);

  return {
    version: 'us-liquidity-v1',
    status: 'calculated',
    asOf: netLiquidity.at(-1)?.date ?? null,
    score,
    regime,
    momentum,
    confidence: confidenceScore >= 75 ? 'High' : confidenceScore >= 50 ? 'Medium' : 'Low',
    confidenceScore,
    breadth: { positive: positiveDrivers, negative: negativeDrivers, total: drivers.length },
    netLiquidity: netLiquidity.at(-1)?.value ?? null,
    history: netLiquidity,
    decomposition,
    composite,
    drivers: drivers.map(({ key, name, change, impulse, weight, requestedDays, spanDays, measuredFrom }) => ({
      key, name, changePercent: change, impulse, weight, requestedDays, spanDays, measuredFrom,
    })),
  };
}

const GLOBAL_LIQUIDITY_MAX_GAP_DAYS = 35;
// The Fed publishes weekly, the TGA and RRP daily. Carrying the last known
// value forward is right across a few days and wrong across a few months: if
// one leg stops updating, net liquidity would keep printing as though it were
// still current. Every leg is bounded by the same gap the cross-currency legs
// already use.
const NET_LIQUIDITY_MAX_GAP_DAYS = 10;

function alignedAtOrBefore(points, date, maxGapDays) {
  const point = latestAtOrBefore(points, date);
  if (!point) return null;
  return ((new Date(date) - new Date(point.date)) / DAY_MS) <= maxGapDays ? point : null;
}

/**
 * Net liquidity on the Fed's own publication dates: balance sheet minus the
 * Treasury general account minus reverse repo, each leg required to be within
 * `maxGapDays` of the date being computed.
 */
function buildNetLiquiditySeries(fed, treasury, reverseRepo, maxGapDays = NET_LIQUIDITY_MAX_GAP_DAYS) {
  return fed.flatMap((point) => {
    const treasuryPoint = alignedAtOrBefore(treasury, point.date, maxGapDays);
    const reverseRepoPoint = alignedAtOrBefore(reverseRepo, point.date, maxGapDays);
    if (!treasuryPoint || !reverseRepoPoint) return [];
    const value = point.value - treasuryPoint.value - reverseRepoPoint.value;
    return Number.isFinite(value) ? [{ date: point.date, value }] : [];
  });
}

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

const DAYS_PER_MONTH = 30.44;

/**
 * How much longer the reverse-repo facility can keep absorbing quantitative
 * tightening. The decomposition already shows which leg moved net liquidity;
 * what it cannot say is that one of those legs has a hard floor. A shrinking
 * balance sheet offset by an RRP drawdown looks neutral right up until the
 * facility empties, at which point the same QT lands on reserves undiluted —
 * so the level and the drain rate together are the constraint worth publishing.
 */
export function calculateLiquidityRunway(seriesList, { windowDays = 91 } = {}) {
  const series = Object.fromEntries((seriesList ?? []).map((item) => [item.key, item]));
  const fed = pointsForSeries(series.fedBalanceSheet);
  const reverseRepo = pointsForSeries(series.reverseRepo);
  const treasury = pointsForSeries(series.treasuryGeneralAccount);
  const fedDelta = absoluteChangeOverDays(fed, windowDays);
  const reverseRepoDelta = absoluteChangeOverDays(reverseRepo, windowDays);
  const treasuryDelta = absoluteChangeOverDays(treasury, windowDays);
  const reverseRepoLevel = reverseRepo.at(-1)?.value ?? null;

  if (!Number.isFinite(fedDelta) || !Number.isFinite(reverseRepoDelta) || !Number.isFinite(reverseRepoLevel)) {
    return {
      version: 'liquidity-runway-v1',
      status: 'unavailable',
      reason: 'Fed balance-sheet and reverse-repo histories covering the window are both required.',
      state: null,
      runwayMonths: null,
    };
  }

  const months = windowDays / DAYS_PER_MONTH;
  const drainPerMonth = reverseRepoDelta < 0 ? Math.abs(reverseRepoDelta) / months : 0;
  const tighteningPerMonth = fedDelta < 0 ? Math.abs(fedDelta) / months : 0;
  const draining = drainPerMonth > 0;
  // Only meaningful while the facility is actually draining; a flat or rising
  // balance has no exhaustion date.
  const runwayMonths = draining && reverseRepoLevel > 0 ? Math.round((reverseRepoLevel / drainPerMonth) * 10) / 10 : null;
  const offsetRatio = tighteningPerMonth > 0 && draining ? Math.round((drainPerMonth / tighteningPerMonth) * 100) / 100 : null;

  let state;
  // A flat balance sheet is not an expanding one; calling it expanding put a
  // no-change window under a label that implies reserves are being added.
  const expanding = fedDelta > 0;
  if (expanding) state = draining ? 'Balance sheet expanding with reverse repo still draining' : 'Balance sheet expanding';
  else if (fedDelta === 0) state = draining ? 'Balance sheet flat with reverse repo draining' : 'Balance sheet flat';
  else if (!draining) state = 'Tightening lands on reserves';
  else if (offsetRatio !== null && offsetRatio >= 0.5) state = 'Reverse repo is absorbing the tightening';
  else state = 'Reverse repo only partly absorbing the tightening';

  const reads = {
    'Balance sheet expanding': 'The balance sheet is growing over this window, so nothing is being absorbed on its behalf.',
    'Balance sheet expanding with reverse repo still draining': 'The balance sheet is growing and the reverse-repo facility is still draining into it, which adds to reserves from both directions.',
    'Balance sheet flat': 'The balance sheet has not moved over this window, so nothing is being absorbed and nothing is being added.',
    'Balance sheet flat with reverse repo draining': 'The balance sheet has not moved, but the reverse-repo facility is still draining into reserves.',
    'Tightening lands on reserves': 'The balance sheet is shrinking and the reverse-repo facility is not draining to cushion it, so the tightening reaches reserves directly.',
    'Reverse repo is absorbing the tightening': 'The balance sheet is shrinking but the reverse-repo drawdown is covering most of it, which is why net liquidity looks calmer than the balance sheet alone.',
    'Reverse repo only partly absorbing the tightening': 'The balance sheet is shrinking faster than the reverse-repo facility is draining, so part of the tightening is already reaching reserves.',
  };

  return {
    version: 'liquidity-runway-v1',
    status: 'calculated',
    state,
    windowDays,
    reverseRepoLevel: Math.round(reverseRepoLevel),
    drainPerMonth: Math.round(drainPerMonth),
    tighteningPerMonth: Math.round(tighteningPerMonth),
    offsetRatio,
    runwayMonths,
    treasuryDirection: !Number.isFinite(treasuryDelta) ? null : treasuryDelta > 0 ? 'rebuilding' : treasuryDelta < 0 ? 'drawing down' : 'flat',
    read: `${reads[state]}${runwayMonths !== null ? ` At the current drawdown pace the facility has about ${runwayMonths} ${runwayMonths === 1 ? 'month' : 'months'} left before it can no longer cushion anything.` : ''}`,
    methodology: `Deltas are measured over ${windowDays} days and converted to a monthly pace. Runway divides the current reverse-repo balance by that monthly drawdown, and is published only while the facility is actually draining, since a flat or rising balance has no exhaustion date. The offset ratio is the reverse-repo drawdown over the balance-sheet contraction, so a ratio at or above 0.5 means most of the tightening is being absorbed rather than reaching reserves.`,
  };
}


/** 1st, 2nd, 3rd — a hardcoded "th" suffix prints "2th" and gives itself away. */
function ordinal(value) {
  if (!Number.isFinite(value)) return '—';
  const lastTwo = Math.abs(value) % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${value}th`;
  return `${value}${{ 1: 'st', 2: 'nd', 3: 'rd' }[Math.abs(value) % 10] ?? 'th'}`;
}

const CYCLE_WINDOW_DAYS = 1095;
const CYCLE_TREND_DAYS = 365;

/**
 * Where the liquidity pool sits in its own cycle, which a percentile of the
 * raw level cannot answer. A pool that grows over decades is at its highest
 * level almost every day of an expansion, so that percentile is a ratchet, not
 * a gauge.
 *
 * Two readings that do move: the level ranked against a bounded trailing
 * window, and the year-over-year growth rate ranked against its own history.
 * The second is the one that turns at a cycle top, because the pool keeps
 * growing while the rate of growth rolls over.
 */
export function calculateLiquidityCyclePosition(points, { windowDays = CYCLE_WINDOW_DAYS, trendDays = CYCLE_TREND_DAYS } = {}) {
  const series = (points ?? []).filter((point) => Number.isFinite(point.value) && point.date);
  if (series.length < 2) {
    return { status: 'unavailable', reason: 'A pooled liquidity history is required.', levelPercentile: null, growthPercentile: null };
  }
  const latest = series.at(-1);
  const cutoff = new Date(new Date(latest.date).getTime() - (windowDays * DAY_MS)).toISOString().slice(0, 10);
  const window = series.filter((point) => point.date >= cutoff);
  const levelPercentile = window.length >= 12
    ? Math.round((window.filter((point) => point.value <= latest.value).length / window.length) * 100)
    : null;

  // Year-over-year growth at every point that has a year of history behind it.
  const growth = series.flatMap((point) => {
    const prior = alignedAtOrBefore(series, new Date(new Date(point.date).getTime() - (trendDays * DAY_MS)).toISOString().slice(0, 10), 45);
    return prior && prior.value > 0 ? [{ date: point.date, value: ((point.value / prior.value) - 1) * 100 }] : [];
  });
  const currentGrowth = growth.at(-1)?.value ?? null;
  const growthPercentile = growth.length >= 24 && currentGrowth !== null
    ? Math.round((growth.filter((point) => point.value <= currentGrowth).length / growth.length) * 100)
    : null;
  const growthTrend = growth.length >= 4 && currentGrowth !== null
    ? currentGrowth - growth.at(-4).value
    : null;

  const phase = growthPercentile === null ? null
    : growthPercentile >= 70 ? (growthTrend !== null && growthTrend < 0 ? 'Expanding but decelerating' : 'Expanding')
      : growthPercentile <= 30 ? (growthTrend !== null && growthTrend > 0 ? 'Contracting but turning up' : 'Contracting')
        : 'Mid-cycle';

  return {
    status: levelPercentile === null && growthPercentile === null ? 'unavailable'
      : growthPercentile === null ? 'provisional' : 'calculated',
    reason: levelPercentile === null && growthPercentile === null ? 'Not enough pooled history to rank either the level or its growth rate.' : null,
    asOf: latest.date,
    observations: series.length,
    windowDays,
    rankedAgainst: window.length,
    levelPercentile,
    growthPercent: currentGrowth === null ? null : Math.round(currentGrowth * 100) / 100,
    growthPercentile,
    growthObservations: growth.length,
    growthTrend: growthTrend === null ? null : Math.round(growthTrend * 100) / 100,
    phase,
    read: growthPercentile === null
      ? `The pool sits at the ${ordinal(levelPercentile)} percentile of its last ${window.length} readings; a year-over-year growth rate needs more history before the cycle position can be placed.`
      : `${phase}: the pool is growing ${currentGrowth > 0 ? '+' : ''}${Math.round(currentGrowth * 100) / 100}% year over year, the ${ordinal(growthPercentile)} percentile of ${growth.length} readings, while the level sits at the ${ordinal(levelPercentile)} of its last ${Math.round(windowDays / 365)} years.`,
    methodology: `The level is ranked against a trailing ${windowDays}-day window rather than the whole history, because a pool that grows over decades is near its all-time high on most days of an expansion and that percentile carries no information. The growth reading is the year-over-year rate ranked against its own history, which is what actually turns at a cycle top: the pool keeps growing while the rate of growth rolls over.`,
  };
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

  const usLeg = buildNetLiquiditySeries(fed, treasury, reverseRepo).filter((point) => point.value > 0);
  const ecbLeg = alignedUsdLeg(ecb, eurUsd, (value, rate) => value * rate);
  const bojLeg = alignedUsdLeg(boj, yenPerUsd, (value, rate) => (value * 100) / rate);
  const pbocLeg = alignedUsdLeg(pboc, yuanPerUsd, (value, rate) => (value * 1000) / rate);
  const unavailableGlobal = (reason, missing = []) => ({
    version: 'global-liquidity-v1',
    status: 'unavailable',
    reason,
    asOf: null,
    score: null,
    regime: null,
    momentum: 'Unavailable',
    globalLiquidityUsdMillions: null,
    cycle: null,
    centralBanks: [],
    history: [],
    missing,
    drivers: [],
  });
  const missingLegs = [
    ...(usLeg.length ? [] : ['US net liquidity (Fed, TGA, RRP)']),
    ...(ecbLeg.length ? [] : ['ECB balance sheet converted at EURUSD']),
    ...(bojLeg.length ? [] : ['BoJ balance sheet converted at USDJPY']),
  ];
  if (missingLegs.length) return unavailableGlobal(`The US, ECB and BoJ legs are all required before a pool can be summed; missing ${missingLegs.join(', ')}.`, missingLegs);

  const poolLegs = [usLeg, ecbLeg, bojLeg, ...(pbocLeg.length ? [pbocLeg] : [])];
  const globalLiquidity = sumAlignedSeries(poolLegs);
  if (!globalLiquidity.length) {
    return unavailableGlobal(`No date has every central-bank leg within ${GLOBAL_LIQUIDITY_MAX_GAP_DAYS} days of it, so the pool cannot be summed without carrying a stale leg forward.`, ['A date shared by every central-bank leg']);
  }

  const exUs = sumAlignedSeries([ecbLeg, bojLeg]);
  const driverDefinitions = [
    { key: 'globalCentralBank', name: 'Global central-bank impulse', ...driverChange(globalLiquidity, 91), scale: 3, weight: 0.3 },
    { key: 'usM2', name: 'US M2 growth', ...driverChange(m2, 91), scale: 2, weight: 0.2 },
    { key: 'exUsCentralBank', name: 'ECB + BoJ impulse', ...driverChange(exUs, 91), scale: 3, weight: 0.15 },
    { key: 'dollar', name: 'Dollar transmission', ...driverChange(dollar, 91), scale: 3, weight: 0.2, inverse: true },
    ...(pbocLeg.length >= 13 ? [{ key: 'pbocCentralBank', name: 'PBoC impulse', ...driverChange(pbocLeg, 91), scale: 3, weight: 0.15 }] : []),
  ];
  const coreDriverKeys = ['globalCentralBank', 'usM2', 'exUsCentralBank', 'dollar'];
  const drivers = driverDefinitions.map((driver) => ({
    ...driver,
    impulse: boundedImpulse(driver.change, driver.scale, driver.inverse),
  })).filter((driver) => driver.impulse !== null);
  if (!coreDriverKeys.every((key) => drivers.some((driver) => driver.key === key))) {
    const missingDrivers = coreDriverKeys
      .filter((key) => !drivers.some((driver) => driver.key === key))
      .map((key) => driverDefinitions.find((definition) => definition.key === key)?.name ?? key);
    return unavailableGlobal(`The core drivers are mandatory; missing ${missingDrivers.join(', ')}.`, missingDrivers);
  }

  const availableWeight = drivers.reduce((total, driver) => total + driver.weight, 0);
  const composite = drivers.reduce((total, driver) => total + (driver.impulse * driver.weight), 0) / availableWeight;
  const positiveDrivers = drivers.filter((driver) => driver.impulse > 0.05).length;
  const negativeDrivers = drivers.filter((driver) => driver.impulse < -0.05).length;
  const agreement = Math.max(positiveDrivers, negativeDrivers) / drivers.length;
  const score = Math.round(clamp(50 + (composite * 50)));
  const regime = composite >= 0.15 ? 'Expansion' : composite <= -0.15 ? 'Contraction' : 'Neutral';
  const shortImpulse = boundedImpulse(changeOverDays(globalLiquidity, 28), 1.5);
  const longImpulse = boundedImpulse(changeOverDays(globalLiquidity, 91), 3);
  const momentum = describeImpulseMomentum(shortImpulse, longImpulse);
  const confidenceScore = Math.round(((availableWeight * 0.55) + (agreement * 0.45)) * 100);

  const latestTotal = globalLiquidity.at(-1)?.value ?? null;
  const cycle = calculateLiquidityCyclePosition(globalLiquidity);
  // The pool prints on the union of its legs' dates, but a leg that publishes
  // monthly is carried forward between its own prints — so the total updates
  // weekly while part of it is a month old. The effective resolution is the
  // slowest leg, and stating the total's own cadence without that would imply
  // every component moved.
  const legCadence = (points) => {
    if (points.length < 3) return null;
    const gaps = points.slice(1).map((point, index) => (new Date(point.date) - new Date(points[index].date)) / DAY_MS);
    const sorted = gaps.filter((gap) => gap > 0).sort((left, right) => left - right);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return Math.round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
  };
  const cadenceByLeg = [
    { key: 'us', name: 'United States (net liquidity)', days: legCadence(usLeg) },
    { key: 'ecb', name: 'European Central Bank', days: legCadence(ecbLeg) },
    { key: 'boj', name: 'Bank of Japan', days: legCadence(bojLeg) },
    ...(pbocLeg.length ? [{ key: 'pboc', name: "People's Bank of China", days: legCadence(pbocLeg) }] : []),
  ];
  const slowestLeg = cadenceByLeg.filter((leg) => Number.isFinite(leg.days)).sort((left, right) => right.days - left.days)[0] ?? null;
  const resolution = {
    printCadenceDays: legCadence(globalLiquidity),
    effectiveCadenceDays: slowestLeg?.days ?? null,
    slowestLeg: slowestLeg ? { key: slowestLeg.key, name: slowestLeg.name, cadenceDays: slowestLeg.days } : null,
    legs: cadenceByLeg,
    read: slowestLeg && Number.isFinite(legCadence(globalLiquidity))
      ? `The pool prints every ${legCadence(globalLiquidity)} days, but ${slowestLeg.name} publishes every ${slowestLeg.days}, so the total's effective resolution is ${slowestLeg.days} days: between those prints part of the sum is carried forward rather than re-measured.`
      : 'The effective resolution of the pool cannot be measured from the available legs.',
  };

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
    status: 'calculated',
    asOf: globalLiquidity.at(-1)?.date ?? null,
    score,
    regime,
    momentum,
    confidence: confidenceScore >= 75 ? 'High' : confidenceScore >= 50 ? 'Medium' : 'Low',
    confidenceScore,
    breadth: { positive: positiveDrivers, negative: negativeDrivers, total: drivers.length },
    globalLiquidityUsdMillions: latestTotal,
    // `cyclePercentile` is gone. It was retained as an alias for the
    // trailing-window level reading after that model was corrected, which left
    // a field whose name promised a cycle gauge and whose value was a level
    // rank. The cycle position lives under `cycle`, where the growth reading
    // that actually turns is published beside it.
    cycle,
    resolution,
    centralBanks: legSummary,
    composite,
    history: globalLiquidity,
    drivers: drivers.map(({ key, name, change, impulse, weight, requestedDays, spanDays, measuredFrom }) => ({
      key, name, changePercent: change, impulse, weight, requestedDays, spanDays, measuredFrom,
    })),
  };
}

const COINGECKO_PUBLIC_HOST = 'https://api.coingecko.com/api/v3';
const COINGECKO_PRO_HOST = 'https://pro-api.coingecko.com/api/v3';

/**
 * CoinGecko serves the same paths on three tiers. Keyless requests share a
 * heavily contended pool and are the first thing to start returning 429 or 403;
 * a free demo key moves the caller onto its own quota, and a pro key changes
 * the host as well as the header. Building the request in one place keeps the
 * three call sites from each getting the pairing subtly wrong.
 */
export function buildCoingeckoRequest(path, { apiKey = '', plan = 'demo', params = {} } = {}) {
  const key = String(apiKey ?? '').trim();
  const normalizedPlan = key && String(plan).toLowerCase() === 'pro' ? 'pro' : key ? 'demo' : 'keyless';
  const url = new URL(`${normalizedPlan === 'pro' ? COINGECKO_PRO_HOST : COINGECKO_PUBLIC_HOST}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
  }
  const headers = normalizedPlan === 'pro'
    ? { 'x-cg-pro-api-key': key }
    : normalizedPlan === 'demo' ? { 'x-cg-demo-api-key': key } : null;
  return { url: url.toString(), headers, plan: normalizedPlan };
}


/**
 * Whether capital is rotating toward bitcoin or away from it. Dominance alone
 * is a level, not a direction: it rises both when bitcoin leads a rally and
 * when alts are sold harder in a decline, and those are opposite tapes. Pairing
 * the bitcoin/total performance spread with the direction of the whole market
 * separates them without needing a dominance history the global endpoint does
 * not publish.
 */
export function calculateCryptoRotation({ bitcoinChange24hPct = null, totalMarketCapChange24hPct = null, btcDominancePct = null, ethDominancePct = null } = {}) {
  if (!Number.isFinite(bitcoinChange24hPct) || !Number.isFinite(totalMarketCapChange24hPct)) {
    return {
      version: 'crypto-rotation-v1',
      status: 'unavailable',
      reason: 'Both the bitcoin 24-hour change and the total market-capitalisation change are required.',
      regime: null,
      spread: null,
    };
  }
  const spread = Math.round((bitcoinChange24hPct - totalMarketCapChange24hPct) * 100) / 100;
  const marketRising = totalMarketCapChange24hPct >= 0;
  const bitcoinLeading = spread >= 0;
  // Inside this band the two moved together and naming a leader would be noise.
  const decisive = Math.abs(spread) >= 0.25;

  const regime = !decisive
    ? (marketRising ? 'Broad advance' : 'Broad decline')
    : marketRising
      ? (bitcoinLeading ? 'Bitcoin-led advance' : 'Altcoin-led advance')
      : (bitcoinLeading ? 'Flight to bitcoin' : 'Bitcoin-led decline');

  const reads = {
    'Bitcoin-led advance': 'The market is up and bitcoin is outpacing it, so the bid is concentrating rather than broadening.',
    'Altcoin-led advance': 'The market is up and bitcoin is lagging it, so the bid is broadening out of bitcoin into the rest of the complex.',
    'Flight to bitcoin': 'The market is down and bitcoin is falling less than the rest, which is the classic rotation into it as a haven within crypto.',
    'Bitcoin-led decline': 'The market is down and bitcoin is falling faster than the rest, so the weakness starts at the centre rather than the edges.',
    'Broad advance': 'The market is up and bitcoin is moving with it, so no rotation is visible at this horizon.',
    'Broad decline': 'The market is down and bitcoin is moving with it, so the selling is indiscriminate rather than rotational.',
  };

  return {
    version: 'crypto-rotation-v1',
    status: 'calculated',
    regime,
    spread,
    decisive,
    marketChange24hPct: Math.round(totalMarketCapChange24hPct * 100) / 100,
    bitcoinChange24hPct: Math.round(bitcoinChange24hPct * 100) / 100,
    btcDominancePct: Number.isFinite(btcDominancePct) ? Math.round(btcDominancePct * 10) / 10 : null,
    ethDominancePct: Number.isFinite(ethDominancePct) ? Math.round(ethDominancePct * 10) / 10 : null,
    read: reads[regime],
    methodology: 'The spread is bitcoin\'s 24-hour change minus the total crypto market capitalisation\'s, so a positive spread means bitcoin outperformed the complex. That spread is read against whether the whole market rose or fell, because a rising dominance means opposite things in the two cases. A spread inside 0.25 points is reported as a broad move rather than a rotation. Dominance levels are carried for context but are not what the regime is derived from.',
  };
}


/**
 * CFTC publishes its Commitments of Traders data through Socrata. Anonymous
 * callers share one throttled pool; a free application token gives the caller
 * its own budget. The token is an identifier rather than a secret credential,
 * but it still travels as a header rather than in the query string so it stays
 * out of proxy and server logs.
 */
export function buildSocrataRequest(host, dataset, { appToken = '', params = {} } = {}) {
  const url = new URL(`https://${String(host).replace(/^https?:\/\//, '').replace(/\/$/, '')}/resource/${dataset}.json`);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
  }
  const token = String(appToken ?? '').trim();
  return {
    url: url.toString(),
    headers: token ? { 'X-App-Token': token } : null,
    authenticated: Boolean(token),
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

const CROWDED_PERCENTILE = 80;
const STRESS_SCORE = 35;
const SOFT_SCORE = 45;
const STRONG_SCORE = 60;
const HIGH_ALIGNMENT = 0.6;
const BROAD_STRESS_SHARE = 40;

/**
 * Names the weakest link in the cross-asset universe from what the heatmap
 * already measures, ranked by severity. Positioning that is crowded and still
 * working is a different risk from positioning that is crowded and rolling
 * over, and a stressed market moving with the complex transmits further than
 * one falling on its own — so each concern carries the evidence behind it
 * rather than a single blended score.
 */
export function calculateHeatmapRisk(assets = []) {
  const calculated = (assets ?? []).filter((asset) => asset?.status === 'calculated');
  if (!calculated.length) {
    return { version: 'heatmap-risk-v1', status: 'unavailable', reason: 'No market in the universe has a calculated score.', concerns: [], headline: null };
  }
  const concerns = [];
  for (const asset of calculated) {
    const crowding = asset.crowdingPercentile;
    const score = asset.score;
    const alignment = Math.abs(asset.alignmentValue ?? 0);
    if (Number.isFinite(crowding) && crowding >= CROWDED_PERCENTILE && Number.isFinite(score)) {
      if (score <= SOFT_SCORE) {
        concerns.push({
          key: `${asset.symbol}-crowded-turning`, symbol: asset.symbol, name: asset.name,
          type: 'Crowded and turning', severity: 90 + Math.round((crowding - CROWDED_PERCENTILE) / 4),
          read: `${asset.name} sits in the ${crowding}th percentile of speculative positioning while its technical score has fallen to ${score}: the crowd is offside rather than early.`,
        });
      } else if (score >= STRONG_SCORE) {
        concerns.push({
          key: `${asset.symbol}-crowded-consensus`, symbol: asset.symbol, name: asset.name,
          type: 'Crowded consensus', severity: 55 + Math.round((crowding - CROWDED_PERCENTILE) / 4),
          read: `${asset.name} is working with a score of ${score}, but positioning is already in the ${crowding}th percentile, so the trade is consensus and has less room to absorb bad news.`,
        });
      }
    }
    if (Number.isFinite(score) && score <= STRESS_SCORE && alignment >= HIGH_ALIGNMENT) {
      concerns.push({
        key: `${asset.symbol}-transmitting`, symbol: asset.symbol, name: asset.name,
        type: 'Stress transmitting', severity: 75 + Math.round((HIGH_ALIGNMENT === 1 ? 0 : (alignment - HIGH_ALIGNMENT) * 25)),
        read: `${asset.name} is in stress at a score of ${score} while still moving with the complex at ${asset.alignmentValue} correlation to SPY, so weakness there is unlikely to stay contained.`,
      });
    }
  }

  const stressed = calculated.filter((asset) => Number.isFinite(asset.score) && asset.score <= STRESS_SCORE);
  const stressShare = Math.round((stressed.length / calculated.length) * 100);
  if (stressShare >= BROAD_STRESS_SHARE) {
    concerns.push({
      key: 'universe-broad-stress', symbol: null, name: 'Cross-asset universe',
      type: 'Broad stress', severity: 80 + Math.round(stressShare / 5),
      read: `${stressed.length} of ${calculated.length} calculated markets (${stressShare}%) score at or below ${STRESS_SCORE}, so the weakness is the tape rather than any single market.`,
    });
  }

  concerns.sort((left, right) => right.severity - left.severity || left.key.localeCompare(right.key));
  return {
    version: 'heatmap-risk-v1',
    status: 'calculated',
    universeSize: calculated.length,
    stressShare,
    concerns,
    headline: concerns.length ? concerns[0] : null,
    read: concerns.length
      ? concerns[0].read
      : `No single weak link stands out: nothing in the ${calculated.length} calculated markets is both crowded and turning, and stress is not transmitting across the complex.`,
    methodology: `Positioning at or above the ${CROWDED_PERCENTILE}th COT percentile is flagged as crowded and turning when the technical score has fallen to ${SOFT_SCORE} or below, and as consensus when the score is still ${STRONG_SCORE} or above. A market scoring ${STRESS_SCORE} or below while holding at least ${HIGH_ALIGNMENT} absolute correlation to SPY is flagged as transmitting stress. Broad stress is raised when at least ${BROAD_STRESS_SHARE}% of the calculated universe scores at or below ${STRESS_SCORE}. Markets without a COT contract contribute no positioning concern rather than an assumed one.`,
  };
}

/**
 * Open-interest quadrant from Binance's openInterestHist rows.
 *
 * The endpoint publishes contracts (`sumOpenInterest`) and the notional value
 * of those contracts (`sumOpenInterestValue`). Notional is contracts times
 * price, so it cannot stand in for price: whenever the contract move dominates,
 * its sign follows open interest rather than the tape, and the quadrant lands
 * on the opposite read — a rally on falling open interest reports as a
 * deleveraging washout instead of a spot-led advance. Price has to be recovered
 * by dividing notional by contracts.
 *
 * Rows are also paired before filtering: dropping the two fields independently
 * lets the series fall out of step, so `n` bars back would mean different dates
 * in each.
 */
export function calculateOpenInterestQuadrant(rows, { lookbackBars = 7 } = {}) {
  const paired = (rows ?? [])
    .map((row) => ({ contracts: Number(row?.openInterest), notional: Number(row?.openInterestValue) }))
    .filter((row) => Number.isFinite(row.contracts) && row.contracts > 0 && Number.isFinite(row.notional) && row.notional > 0);
  if (paired.length < lookbackBars + 1) {
    return { status: 'unavailable', reason: `Needs ${lookbackBars + 1} paired open-interest observations.`, quadrant: null, observations: paired.length };
  }
  const latest = paired.at(-1);
  const prior = paired.at(-(lookbackBars + 1));
  const impliedPrice = (row) => row.notional / row.contracts;
  const oiChange = ((latest.contracts / prior.contracts) - 1) * 100;
  const priceChange = ((impliedPrice(latest) / impliedPrice(prior)) - 1) * 100;

  const quadrant = priceChange >= 0
    ? (oiChange >= 0 ? 'Levered expansion' : 'Spot-led advance')
    : (oiChange >= 0 ? 'Levered pressure' : 'Deleveraging washout');
  const reads = {
    'Levered expansion': 'Price and open interest are both rising, so the advance is being carried with added leverage.',
    'Spot-led advance': 'Price is rising while open interest falls, so the bid is coming from spot rather than from new leverage.',
    'Levered pressure': 'Price is falling while open interest rises, which is positions being added into weakness.',
    'Deleveraging washout': 'Price and open interest are both falling, so leverage is being unwound rather than defended.',
  };

  return {
    status: 'calculated',
    quadrant,
    oiChange7d: Math.round(oiChange * 100) / 100,
    priceChange7d: Math.round(priceChange * 100) / 100,
    openInterest: latest.contracts,
    impliedPrice: Math.round(impliedPrice(latest) * 100) / 100,
    lookbackBars,
    observations: paired.length,
    read: reads[quadrant],
    methodology: `Open interest is Binance's contract total and price is recovered as notional divided by contracts, since the published notional is itself contracts times price and follows open interest whenever the contract move dominates. Both are compared over ${lookbackBars} bars.`,
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
  const leadLag = calculateSeriesLeadLag(leftChanges, rightChanges, dates);
  // The window keys count observations, not days, and the observations are the
  // dates the two series share. Against a weekly series that is 20 weeks, not
  // 20 sessions — a factor of seven hidden behind a label that says "20D". The
  // measured cadence and a truthful label for each window travel with the
  // numbers so no call site has to infer it.
  const cadenceDays = leadLag?.barDays ?? null;
  const describeWindow = (bars) => {
    if (!Number.isFinite(cadenceDays)) return `${bars} shared observations`;
    if (cadenceDays <= 2) return `${bars} sessions`;
    if (cadenceDays <= 10) return `${bars} observations, about ${Math.round((bars * cadenceDays) / 7)} weeks`;
    return `${bars} observations, about ${Math.round((bars * cadenceDays) / 30.44)} months`;
  };
  return {
    correlations,
    cadenceDays,
    daily: Number.isFinite(cadenceDays) ? cadenceDays <= 2 : null,
    windowLabels: { '20D': describeWindow(20), '60D': describeWindow(60), '1Y': describeWindow(252) },
    observations: leftChanges.length,
    asOf: dates.at(-1),
    leadLag,
  };
}

const LEAD_LAG_MAX_BARS = 10;
const LEAD_LAG_MIN_OBSERVATIONS = 40;
const LEAD_LAG_MIN_EDGE = 0.05;

/**
 * Decides whether either series reliably moves first. The lag is measured in
 * aligned observations, so it is also reported in calendar days: a weekly
 * series lagging by three bars is three weeks, not three sessions, and calling
 * both "3" would misread the slower one by an order of magnitude.
 */
export function calculateSeriesLeadLag(leftChanges, rightChanges, dates) {
  const scan = calculateLeadLag(leftChanges, rightChanges, LEAD_LAG_MAX_BARS, LEAD_LAG_MIN_OBSERVATIONS, { rankBy: 'magnitude' });
  if (!scan) return null;
  const gaps = [];
  for (let index = 1; index < dates.length; index += 1) {
    const gap = (Date.parse(dates[index]) - Date.parse(dates[index - 1])) / DAY_MS;
    if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
  }
  const barDays = median(gaps);
  const synchronous = Number.isFinite(scan.synchronousCorr) ? scan.synchronousCorr : 0;
  const edge = Math.round((Math.abs(scan.corrAtBest) - Math.abs(synchronous)) * 1000) / 1000;
  // A peak that barely beats the synchronous reading is noise, not a lead.
  const decisive = scan.bestLag !== 0 && edge >= LEAD_LAG_MIN_EDGE;
  return {
    leads: decisive ? (scan.bestLag > 0 ? 'left' : 'right') : 'none',
    bestLagBars: scan.bestLag,
    leadBars: decisive ? Math.abs(scan.bestLag) : 0,
    leadDays: decisive && Number.isFinite(barDays) ? Math.round(Math.abs(scan.bestLag) * barDays) : 0,
    barDays: Number.isFinite(barDays) ? Math.round(barDays * 10) / 10 : null,
    corrAtBest: scan.corrAtBest,
    synchronousCorr: scan.synchronousCorr,
    edge,
    observations: scan.observations,
  };
}

const DOLLAR_LINK_MINIMUM = 0.2;

/**
 * Turns dollar direction into a bitcoin read using the measured DXY/BTC link
 * rather than an assumed one. A falling dollar only helps bitcoin while the
 * link is inverse; under a positive link the same move is a headwind, and
 * while the link is too weak to carry anything, dollar direction transmits
 * nothing and saying so beats naming a tailwind the data does not support.
 */
export function calculateDollarTransmissionRead({ usdMomentum = null, usdScore = null, corr60 = null } = {}) {
  const votes = [];
  if (Number.isFinite(usdMomentum)) votes.push(usdMomentum < -0.3 ? 1 : usdMomentum > 0.3 ? -1 : 0);
  if (Number.isFinite(usdScore)) votes.push(usdScore < 48 ? 1 : usdScore > 55 ? -1 : 0);
  const dollarWeakness = votes.reduce((total, vote) => total + vote, 0);

  if (!Number.isFinite(corr60)) {
    return {
      status: votes.length ? 'provisional' : 'unavailable',
      label: null,
      score: null,
      dollarWeakness: votes.length ? dollarWeakness : null,
      linkSign: null,
      linkStrength: null,
      reason: 'The DXY/BTC link has to be measured before dollar direction can be transmitted.',
    };
  }
  const linkStrength = Math.round(Math.abs(corr60) * 100) / 100;
  if (linkStrength < DOLLAR_LINK_MINIMUM) {
    return {
      status: 'calculated',
      label: 'Link too weak to transmit',
      score: 0,
      dollarWeakness: votes.length ? dollarWeakness : null,
      linkSign: 0,
      linkStrength,
      reason: `The 60-day correlation is ${corr60 > 0 ? '+' : ''}${corr60.toFixed(2)}, inside the ±${DOLLAR_LINK_MINIMUM} band where dollar moves carry no reliable bitcoin signal.`,
    };
  }
  // An inverse link passes dollar weakness through as support; a positive link
  // reverses it.
  const linkSign = corr60 < 0 ? 1 : -1;
  const score = votes.length ? dollarWeakness * linkSign : null;
  return {
    status: votes.length ? 'calculated' : 'provisional',
    label: score === null ? null : score >= 1 ? 'Dollar tailwind' : score <= -1 ? 'Dollar headwind' : 'Neutral dollar',
    score,
    dollarWeakness,
    linkSign,
    linkStrength,
    reason: score === null
      ? 'Broad-dollar momentum or level is required before the link can be applied.'
      : `Dollar direction scores ${dollarWeakness > 0 ? '+' : ''}${dollarWeakness} for weakness against ${corr60 < 0 ? 'an inverse' : 'a positive'} link of ${corr60 > 0 ? '+' : ''}${corr60.toFixed(2)}.`,
  };
}

function windowPercentile(values, value) {
  if (!values.length || !Number.isFinite(value)) return null;
  return Math.round((values.filter((item) => item <= value).length / values.length) * 100);
}

function costLeg({ key, name, source, unit, values, minimumObservations = 60 }) {
  const clean = (values ?? []).filter(Number.isFinite);
  if (clean.length < minimumObservations) {
    return { key, name, source, status: 'unavailable', reason: `Needs ${minimumObservations} sessions of history.`, value: null, change20d: null, percentile: null };
  }
  const latest = clean.at(-1);
  const prior = clean.length > 21 ? clean.at(-21) : null;
  return {
    key,
    name,
    source,
    unit,
    status: 'calculated',
    value: Math.round(latest * 100) / 100,
    change20d: Number.isFinite(prior) && prior > 0 ? Math.round(((latest / prior) - 1) * 10000) / 100 : null,
    percentile: windowPercentile(clean.slice(-252), latest),
    observations: clean.length,
  };
}

/**
 * Producer economics from prices rather than from filings. Energy is the input
 * cost that moves fastest; the miner-to-metal ratio is the market's own running
 * verdict on whether the metal price is outpacing the cost of pulling it out of
 * the ground. All-in sustaining costs need company filings and stay unavailable
 * rather than being approximated into a number that looks reported.
 */
export function calculateMetalsCostStructure({ crude = [], naturalGas = [], minerToMetalRatio = [] } = {}) {
  const legs = [
    costLeg({ key: 'crude', name: 'WTI crude', source: 'Yahoo CL=F', unit: 'USD/bbl', values: crude }),
    costLeg({ key: 'naturalGas', name: 'Natural gas', source: 'Yahoo NG=F', unit: 'USD/MMBtu', values: naturalGas }),
    costLeg({ key: 'minerMargin', name: 'Miners vs metal', source: 'Yahoo GDX / GLD', unit: 'ratio', values: minerToMetalRatio }),
    { key: 'aisc', name: 'All-in sustaining cost', source: 'Company filings', status: 'unavailable', reason: 'Producer cost curves require a filings-based feed; no public keyless source publishes them.', value: null, change20d: null, percentile: null },
  ];
  const byKey = Object.fromEntries(legs.map((leg) => [leg.key, leg]));
  const energyPercentiles = [byKey.crude, byKey.naturalGas]
    .filter((leg) => leg.status === 'calculated' && Number.isFinite(leg.percentile))
    .map((leg) => leg.percentile);
  const energyPressure = energyPercentiles.length
    ? Math.round(energyPercentiles.reduce((total, value) => total + value, 0) / energyPercentiles.length)
    : null;
  const marginChange = byKey.minerMargin.status === 'calculated' ? byKey.minerMargin.change20d : null;

  let headline = null;
  if (Number.isFinite(marginChange) && Number.isFinite(energyPressure)) {
    const marginsUp = marginChange > 0;
    const energyEasy = energyPressure < 50;
    headline = marginsUp && energyEasy ? 'Margins expanding'
      : !marginsUp && !energyEasy ? 'Margins compressing'
        : 'Margins mixed';
  } else if (Number.isFinite(marginChange)) {
    headline = marginChange > 0 ? 'Miners outpacing the metal' : 'Miners lagging the metal';
  }

  const calculated = legs.filter((leg) => leg.status === 'calculated').length;
  return {
    version: 'metals-cost-structure-v1',
    status: calculated ? (calculated === legs.length - 1 ? 'calculated' : 'provisional') : 'unavailable',
    headline,
    energyPressure,
    legs,
    read: headline
      ? `${headline}: miners have moved ${marginChange > 0 ? '+' : ''}${marginChange}% against the metal over 20 sessions with energy input costs in the ${energyPressure === null ? 'unmeasured' : `${energyPressure}th`} percentile of the past year.`
      : 'Energy histories and a miner-to-metal ratio are required before producer economics can be read.',
    methodology: 'WTI crude and natural gas carry their level, 20-session change, and one-year percentile as the fast-moving input costs. The miner-to-metal ratio is GDX over GLD: a rising ratio means the metal price is outpacing what the market believes it costs to produce, which is the only margin read available without company filings. All-in sustaining cost stays explicitly unavailable.',
  };
}

const BITCOIN_CYCLE_PHASES = [
  { key: 'capitulation', name: 'Capitulation / accumulation', outcome: 'Deep discount, weak hands cleared' },
  { key: 'recovery', name: 'Early recovery', outcome: 'Base building back above the long average' },
  { key: 'expansion', name: 'Expansion', outcome: 'Trend intact, leverage not yet stretched' },
  { key: 'euphoria', name: 'Euphoria / distribution', outcome: 'Valuation and leverage both extended' },
];

// A reading peaks at `target` and falls away linearly, for legs where a phase is
// identified by a value being near a level rather than beyond one.
const near = (value, target, scale) => (Number.isFinite(value) ? clamp(100 - (Math.abs(value - target) * scale)) : null);
const beyond = (value, offset, scale) => (Number.isFinite(value) ? clamp((value - offset) * scale) : null);
const below = (value, offset, scale) => (Number.isFinite(value) ? clamp((offset - value) * scale) : null);

/**
 * Places bitcoin in its cycle from legs the workspace already publishes. The
 * workspace answered nine questions separately and never the one its own page
 * asks, leaving the reader to reconcile a "Mid cycle" valuation against a
 * "Near highs" drawdown by eye. Each phase scores its own evidence and must
 * clear the next by a margin, so a genuinely ambiguous tape says so.
 */
export function calculateBitcoinCyclePhase({ trend, valuation, drawdown, leverage, stablecoins, shortTermHolder, realizedVolatility } = {}) {
  const calculated = (leg) => (leg?.status === 'calculated' ? leg : null);
  const trendLeg = calculated(trend);
  const valuationLeg = calculated(valuation);
  const drawdownLeg = calculated(drawdown);
  const leverageLeg = calculated(leverage);
  const stablecoinLeg = calculated(stablecoins);
  const sthLeg = calculated(shortTermHolder);
  const volatilityLeg = calculated(realizedVolatility);

  const drawdownPct = drawdownLeg?.drawdownPct ?? null;
  const mvrvZ = valuationLeg?.mvrvZ ?? null;
  const vsLongAverage = trendLeg?.pctVsSma200w ?? null;
  const vsDailyAverage = trendLeg?.pctVsSma200d ?? null;
  const fundingPercentile = leverageLeg?.percentile ?? null;
  const volatilityPercentile = volatilityLeg?.percentile ?? null;
  const stablecoinChange = stablecoinLeg?.change30dPercent ?? null;
  const sthPremium = sthLeg?.premiumPercent ?? null;

  const legsByPhase = {
    capitulation: [
      { key: 'drawdown', name: 'Drawdown from the all-time high', score: below(drawdownPct, -20, 2), value: drawdownPct },
      { key: 'valuation', name: 'MVRV Z-score', score: below(mvrvZ, 0, 25), value: mvrvZ },
      { key: 'longAverage', name: 'Price versus the 200-week average', score: below(vsLongAverage, 0, 2), value: vsLongAverage },
      { key: 'shortTermHolder', name: 'Short-term-holder cost basis', score: below(sthPremium, 0, 2), value: sthPremium },
    ],
    recovery: [
      { key: 'drawdown', name: 'Drawdown from the all-time high', score: near(drawdownPct, -30, 3), value: drawdownPct },
      { key: 'valuation', name: 'MVRV Z-score', score: near(mvrvZ, 1, 40), value: mvrvZ },
      { key: 'longAverage', name: 'Price versus the 200-week average', score: near(vsLongAverage, 15, 2), value: vsLongAverage },
      { key: 'stablecoins', name: 'Stablecoin supply, 30 days', score: Number.isFinite(stablecoinChange) ? clamp(50 + (stablecoinChange * 10)) : null, value: stablecoinChange },
    ],
    expansion: [
      { key: 'drawdown', name: 'Drawdown from the all-time high', score: near(drawdownPct, -8, 4), value: drawdownPct },
      { key: 'valuation', name: 'MVRV Z-score', score: near(mvrvZ, 3.5, 30), value: mvrvZ },
      { key: 'dailyAverage', name: 'Price versus the 200-day average', score: Number.isFinite(vsDailyAverage) ? clamp(50 + (vsDailyAverage * 2)) : null, value: vsDailyAverage },
      { key: 'leverageCalm', name: 'Funding percentile, inverted', score: Number.isFinite(fundingPercentile) ? clamp(100 - fundingPercentile) : null, value: fundingPercentile },
    ],
    euphoria: [
      { key: 'valuation', name: 'MVRV Z-score', score: beyond(mvrvZ, 3, 30), value: mvrvZ },
      { key: 'drawdown', name: 'Drawdown from the all-time high', score: Number.isFinite(drawdownPct) ? clamp(100 + (drawdownPct * 8)) : null, value: drawdownPct },
      { key: 'leverage', name: 'Funding percentile', score: Number.isFinite(fundingPercentile) ? clamp(fundingPercentile) : null, value: fundingPercentile },
      { key: 'volatility', name: 'Realized-volatility percentile', score: Number.isFinite(volatilityPercentile) ? clamp(volatilityPercentile) : null, value: volatilityPercentile },
    ],
  };

  const phases = BITCOIN_CYCLE_PHASES.map((definition) => {
    const legs = legsByPhase[definition.key];
    const scored = legs.filter((leg) => Number.isFinite(leg.score));
    return {
      ...definition,
      score: scored.length >= 2 ? Math.round(mean(scored.map((leg) => leg.score))) : null,
      status: scored.length >= 2 ? 'calculated' : 'unavailable',
      coverage: Math.round((scored.length / legs.length) * 100),
      legs: legs.map((leg) => ({ ...leg, score: Number.isFinite(leg.score) ? Math.round(leg.score) : null })),
      missing: legs.filter((leg) => !Number.isFinite(leg.score)).map((leg) => leg.name),
    };
  });

  const publishable = phases.filter((phase) => phase.score !== null);
  if (!publishable.length) {
    return {
      version: 'bitcoin-cycle-phase-v1',
      status: 'unavailable',
      reason: 'Each phase needs at least two of its own calculated legs.',
      phases,
      leading: null,
      read: 'Trend, valuation, drawdown and derivatives legs are required before a cycle phase can be placed.',
    };
  }
  const ranked = [...publishable].sort((left, right) => right.score - left.score);
  const decisive = ranked.length === 1 || (ranked[0].score - ranked[1].score) >= 5;
  return {
    version: 'bitcoin-cycle-phase-v1',
    status: publishable.length === phases.length ? 'calculated' : 'provisional',
    phases,
    leading: decisive ? { key: ranked[0].key, name: ranked[0].name, outcome: ranked[0].outcome, score: ranked[0].score, margin: ranked.length > 1 ? ranked[0].score - ranked[1].score : null } : null,
    runnerUp: ranked.length > 1 ? { key: ranked[1].key, name: ranked[1].name, score: ranked[1].score } : null,
    read: decisive
      ? `${ranked[0].name} is the best-supported phase at ${ranked[0].score}/100${ranked.length > 1 ? `, ${ranked[0].score - ranked[1].score} clear of ${ranked[1].name}` : ''}.`
      : `${ranked[0].name} and ${ranked[1].name} are within ${ranked[0].score - ranked[1].score} points, so the cycle position is genuinely ambiguous.`,
    methodology: 'Each phase scores its own evidence 0-100 from legs the workspace already publishes and needs at least two calculated legs to appear. Capitulation reads deep drawdown, a negative MVRV Z-score, price under the 200-week average and recent buyers underwater. Early recovery reads a drawdown around 30%, a Z-score near 1, price just above the 200-week average and expanding stablecoin supply. Expansion reads a shallow drawdown, a mid-cycle Z-score, price above the 200-day average and funding that is not yet stretched. Euphoria reads a Z-score beyond 3, price at the highs, and both funding and realized volatility in their upper percentiles. A lead narrower than five points is reported as ambiguous rather than resolved.',
  };
}

/**
 * Two stored outputs are only comparable when they were computed from different
 * data. Ingestion runs on a schedule that is faster than the series it reads, so
 * consecutive runs routinely share a vintage — and any score difference between
 * two runs over the same observations is a rounding or code artefact, not news.
 * A version change makes them incomparable for the same reason.
 */
function comparableOutputs(outputs) {
  const latest = outputs[0] ?? null;
  const previous = outputs[1] ?? null;
  if (!latest?.output || !previous?.output) return { latest: null, previous: null, reason: null };
  const latestVintage = latest.output.asOf ?? latest.effective_at ?? null;
  const previousVintage = previous.output.asOf ?? previous.effective_at ?? null;
  if (latestVintage && previousVintage && String(latestVintage) === String(previousVintage)) {
    return { latest: null, previous: null, reason: 'same-vintage' };
  }
  if (latest.output.version && previous.output.version && latest.output.version !== previous.output.version) {
    return { latest: null, previous: null, reason: 'version-changed' };
  }
  return { latest: latest.output, previous: previous.output, vintage: previousVintage, reason: null };
}

export function buildLiquidityNarrative(usOutputs = [], globalOutputs = []) {
  const entries = [];
  const us = comparableOutputs(usOutputs);
  const global = comparableOutputs(globalOutputs);
  const usLatest = us.latest;
  const usPrevious = us.previous;
  const globalLatest = global.latest;
  const globalPrevious = global.previous;
  const hasRunPairs = Boolean((usLatest && usPrevious) || (globalLatest && globalPrevious));
  const sinceUs = us.vintage ? ` since the ${us.vintage} vintage` : ' since the previous run';
  const sinceGlobal = global.vintage ? ` since the ${global.vintage} vintage` : ' since the previous run';

  if (usLatest && usPrevious && Number.isFinite(usLatest.score) && Number.isFinite(usPrevious.score)) {
    const delta = usLatest.score - usPrevious.score;
    if (Math.abs(delta) >= 1) entries.push({ key: 'usScore', text: `US liquidity score moved ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} points to ${usLatest.score}/100${sinceUs}.` });
    if (usLatest.regime !== usPrevious.regime) entries.push({ key: 'usRegime', text: `US regime shifted from ${usPrevious.regime} to ${usLatest.regime}.` });
  }
  if (globalLatest && globalPrevious && Number.isFinite(globalLatest.score) && Number.isFinite(globalPrevious.score)) {
    const delta = globalLatest.score - globalPrevious.score;
    if (Math.abs(delta) >= 1) entries.push({ key: 'globalScore', text: `Global liquidity score moved ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} points to ${globalLatest.score}/100${sinceGlobal}.` });
    if (globalLatest.regime !== globalPrevious.regime) entries.push({ key: 'globalRegime', text: `Global regime shifted from ${globalPrevious.regime} to ${globalLatest.regime}.` });
    if (Number.isFinite(globalLatest.globalLiquidityUsdMillions) && Number.isFinite(globalPrevious.globalLiquidityUsdMillions) && globalPrevious.globalLiquidityUsdMillions > 0) {
      const changePercent = ((globalLatest.globalLiquidityUsdMillions / globalPrevious.globalLiquidityUsdMillions) - 1) * 100;
      if (Math.abs(changePercent) >= 0.05) entries.push({ key: 'globalPool', text: `Pooled central-bank liquidity ${changePercent > 0 ? 'rose' : 'fell'} ${Math.abs(changePercent).toFixed(2)}% to ${formatUsdBillions(globalLatest.globalLiquidityUsdMillions)}.` });
    }
  }

  if (entries.length) return { status: 'updated', entries };
  const blocked = us.reason ?? global.reason ?? null;
  if (blocked) {
    return {
      status: 'stable',
      entries: [],
      note: blocked === 'same-vintage'
        ? 'The last two runs read the same data vintage, so there is nothing to compare between them.'
        : 'The model version changed between the last two runs, so their scores are not comparable.',
    };
  }
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
  'liquidity-states': (workspace) => [
    ...(workspace.usRegime ? [{ key: 'usRegime', label: 'US net-liquidity regime', string: workspace.usRegime }] : []),
    ...(workspace.globalRegime ? [{ key: 'globalRegime', label: 'Global liquidity regime', string: workspace.globalRegime }] : []),
    ...(workspace.globalMomentum && workspace.globalMomentum !== 'Unavailable' ? [{ key: 'globalMomentum', label: 'Global liquidity momentum', string: workspace.globalMomentum }] : []),
    ...(workspace.stablecoinState ? [{ key: 'stablecoinState', label: 'Stablecoin supply regime', string: workspace.stablecoinState }] : []),
    ...(Number.isFinite(workspace.stablecoinChange30dPct) ? [{ key: 'stablecoinChange30d', label: 'Stablecoin 30-day growth %', value: workspace.stablecoinChange30dPct, threshold: 0.1 }] : []),
    ...(workspace.dominantLeg ? [{ key: 'dominantLeg', label: 'Dominant net-liquidity leg (13w)', string: workspace.dominantLeg }] : []),
    ...(Number.isFinite(workspace.netChange13wUsdBillions) ? [{ key: 'netChange13w', label: 'Net liquidity 13-week change ($B)', value: workspace.netChange13wUsdBillions, threshold: 50 }] : []),
  ],
  'dollar-transmission': (workspace) => [
    ...(workspace.tailwindLabel ? [{ key: 'tailwindLabel', label: 'Bitcoin dollar backdrop', string: workspace.tailwindLabel }] : []),
    ...(Number.isFinite(workspace.corr60) ? [{ key: 'corr60', label: 'DXY/BTC 60-day correlation', value: workspace.corr60, threshold: 0.15 }] : []),
  ],
};

export function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}

export function buildAtomFeed(feed, entries) {
  const items = entries.map((entry) => `  <entry>
    <title>${escapeXml(entry.title)}</title>
    <id>${escapeXml(entry.id)}</id>
    <updated>${entry.updated}</updated>
    <content type="text">${escapeXml(entry.content)}</content>
  </entry>`);
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(feed.title)}</title>
  <id>${escapeXml(feed.id)}</id>
  <updated>${feed.updated}</updated>
  <link href="${escapeXml(feed.link)}" rel="self"/>
${items.join('\n')}
</feed>`;
}

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

export function calculateUsdStrengthModel(seriesList, liquidityModel = null, { rateDivergence = null } = {}) {
  const series = Object.fromEntries(seriesList.map((item) => [item.key, item]));
  const dollar = pointsForSeries(series.dxy);
  const dollarTechnical = calculateTechnicalSnapshot(dollar.map((point) => ({ timestamp: `${point.date}T00:00:00.000Z`, value: point.value })));
  if (!dollarTechnical) {
    return {
      version: 'usd-strength-v1',
      status: 'unavailable',
      reason: `A broad-dollar history of at least 30 observations is required; ${dollar.length} available.`,
      asOf: dollar.at(-1)?.date ?? null,
      score: null,
      regime: null,
      coverage: 0,
      missing: ['FRED DTWEXBGS broad-dollar history'],
      drivers: [],
      history: dollar,
    };
  }

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
    Number.isFinite(financialConditionsLatest) ? clamp(50 + (financialConditionsLatest * 35) + (Number.isFinite(financialConditionsChange) ? financialConditionsChange * 25 : 0)) : null,
  ].filter(Number.isFinite);
  const drivers = [
    { key: 'dollarTrend', name: 'Broad-dollar trend', score: dollarTechnical.components.trend, weight: 0.3, value: dollarTechnical.latest, change: dollarTechnical.indicators.momentum20d, source: 'FRED DTWEXBGS' },
    { key: 'dollarMomentum', name: 'Broad-dollar momentum', score: dollarTechnical.components.momentum, weight: 0.15, value: dollarTechnical.indicators.rsi14, change: dollarTechnical.indicators.momentum20d, source: 'FRED DTWEXBGS' },
    { key: 'realYield', name: '10Y real-yield impulse', score: realYieldChange === null ? null : clamp(50 + (Math.tanh(realYieldChange / 0.5) * 50)), weight: 0.15, value: realYield.at(-1)?.value, change: realYieldChange, source: 'FRED DFII10' },
    { key: 'frontEnd', name: '2Y yield impulse', score: frontEndChange === null ? null : clamp(50 + (Math.tanh(frontEndChange / 0.75) * 50)), weight: 0.1, value: frontEndYield.at(-1)?.value, change: frontEndChange, source: 'FRED DGS2' },
    { key: 'stress', name: 'Dollar-smile stress support', score: stressScores.length ? mean(stressScores) : null, weight: 0.15, value: vixLatest, change: financialConditionsChange, source: 'FRED VIXCLS / NFCI' },
    { key: 'liquidity', name: 'Inverse dollar-liquidity impulse', score: Number.isFinite(liquidityModel?.score) ? 100 - liquidityModel.score : null, weight: 0.1, value: liquidityModel?.score, change: liquidityModel?.composite, source: liquidityModel?.version },
    // The rate differential is the most-used driver in FX and the model has
    // never carried one. It takes weight from the liquidity leg rather than
    // being added on top, so the weights still sum to one.
    { key: 'rateDifferential', name: 'US yield advantage over DM peers', score: rateDivergence?.status !== 'unavailable' && Number.isFinite(rateDivergence?.score) ? rateDivergence.score : null, weight: 0.05, value: rateDivergence?.averageSpreadPercent, change: rateDivergence?.averageChangeBasisPoints, source: rateDivergence?.version },
  ];
  const model = driverComposite(drivers, 0.45, 2);
  if (!model.publishable) {
    return {
      version: 'usd-strength-v1',
      status: 'unavailable',
      reason: `The dollar model needs at least two drivers covering 45% of its weight; it has ${model.coverage}%.`,
      asOf: dollar.at(-1)?.date ?? null,
      score: null,
      regime: null,
      coverage: model.coverage,
      missing: model.missing,
      drivers: model.drivers,
      indicators: dollarTechnical.indicators,
      observations: dollarTechnical.observations,
      history: dollar,
    };
  }
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

const DOLLAR_SCENARIO_DEFINITIONS = [
  { key: 'globalStress', name: 'Global stress', outcome: 'USD, CHF, JPY bid' },
  { key: 'usOutperformance', name: 'Strong U.S. growth', outcome: 'USD carry strengthens' },
  { key: 'weakGlobalGrowth', name: 'Weak global growth', outcome: 'USD defensive premium' },
];

/**
 * Scores the three arms of the dollar smile from live inputs instead of
 * asserting them. The arms are separated by what is actually different about
 * them, not by direction alone: a stress bid and a carry bid both lift the
 * dollar, so the carry arm additionally requires rising U.S. yields and the
 * defensive arm requires that neither yields nor panic is doing the work.
 *
 * `growthSpread60d` is the 60-session return of a global equity proxy minus
 * the U.S. one; negative means the U.S. is outperforming.
 */
export function calculateDollarScenarios(seriesList, { growthSpread60d = null, growthSource = 'Yahoo SPY vs EEM', growthName = 'U.S. equity leadership, 60 sessions' } = {}) {
  const series = Object.fromEntries((seriesList ?? []).map((item) => [item.key, item]));
  const volatility = pointsForSeries(series.vix).at(-1)?.value ?? null;
  const creditSpread = pointsForSeries(series.highYieldSpread).at(-1)?.value ?? null;
  const creditChange = absoluteChangeOverDays(pointsForSeries(series.highYieldSpread), 91);
  const conditions = pointsForSeries(series.financialConditions).at(-1)?.value ?? null;
  const realYieldChange = absoluteChangeOverDays(pointsForSeries(series.realYield10y), 91);
  const frontEndChange = absoluteChangeOverDays(pointsForSeries(series.us2yYield), 91);

  const stressVol = Number.isFinite(volatility) ? clamp(50 + ((volatility - 20) * 3)) : null;
  const stressCredit = Number.isFinite(creditSpread)
    ? clamp(50 + ((creditSpread - 4) * 8) + (Number.isFinite(creditChange) ? creditChange * 40 : 0))
    : null;
  const stressConditions = Number.isFinite(conditions) ? clamp(50 + (conditions * 35)) : null;
  const carryReal = Number.isFinite(realYieldChange) ? clamp(50 + (Math.tanh(realYieldChange / 0.5) * 50)) : null;
  const carryFront = Number.isFinite(frontEndChange) ? clamp(50 + (Math.tanh(frontEndChange / 0.75) * 50)) : null;
  const usLeadership = Number.isFinite(growthSpread60d) ? clamp(50 - (growthSpread60d * 3)) : null;
  const invert = (score) => (Number.isFinite(score) ? 100 - score : null);

  const legsByScenario = {
    globalStress: [
      { key: 'volatility', name: 'Equity volatility', score: stressVol, value: volatility, source: 'FRED VIXCLS' },
      { key: 'credit', name: 'High-yield spread level and 91d change', score: stressCredit, value: creditSpread, source: 'FRED BAMLH0A0HYM2' },
      { key: 'conditions', name: 'Financial conditions', score: stressConditions, value: conditions, source: 'FRED NFCI' },
    ],
    usOutperformance: [
      { key: 'realYield', name: '10Y real-yield impulse', score: carryReal, value: realYieldChange, source: 'FRED DFII10' },
      { key: 'frontEnd', name: '2Y yield impulse', score: carryFront, value: frontEndChange, source: 'FRED DGS2' },
      { key: 'creditCalm', name: 'Credit calm', score: invert(stressCredit), value: creditSpread, source: 'FRED BAMLH0A0HYM2' },
      { key: 'leadership', name: growthName, score: usLeadership, value: growthSpread60d, source: growthSource },
    ],
    weakGlobalGrowth: [
      { key: 'leadership', name: growthName, score: usLeadership, value: growthSpread60d, source: growthSource },
      { key: 'yieldsIdle', name: 'U.S. carry not the driver', score: invert(carryReal), value: realYieldChange, source: 'FRED DFII10' },
      { key: 'calmTape', name: 'No volatility panic', score: invert(stressVol), value: volatility, source: 'FRED VIXCLS' },
    ],
  };

  const scenarios = DOLLAR_SCENARIO_DEFINITIONS.map((definition) => {
    const legs = legsByScenario[definition.key];
    const scored = legs.filter((leg) => Number.isFinite(leg.score));
    const score = scored.length >= 2 ? Math.round(mean(scored.map((leg) => leg.score))) : null;
    return {
      ...definition,
      score,
      status: score === null ? 'unavailable' : 'calculated',
      coverage: Math.round((scored.length / legs.length) * 100),
      legs: legs.map((leg) => ({ ...leg, score: Number.isFinite(leg.score) ? Math.round(leg.score) : null })),
      missing: legs.filter((leg) => !Number.isFinite(leg.score)).map((leg) => leg.name),
    };
  });

  const calculated = scenarios.filter((scenario) => scenario.score !== null);
  if (!calculated.length) {
    return {
      version: 'dollar-scenarios-v1',
      status: 'unavailable',
      reason: 'Each path needs at least two of its own calculated legs.',
      scenarios,
      leading: null,
    };
  }
  const total = calculated.reduce((sum, scenario) => sum + scenario.score, 0);
  for (const scenario of scenarios) {
    scenario.share = scenario.score === null || total === 0 ? null : Math.round((scenario.score / total) * 100);
  }
  const ranked = [...calculated].sort((left, right) => right.score - left.score);
  // Two arms within a few points of each other is a tape without a dominant
  // driver, and saying so beats naming a winner by a rounding error.
  const decisive = ranked.length === 1 || (ranked[0].score - ranked[1].score) >= 5;
  return {
    version: 'dollar-scenarios-v1',
    status: calculated.length === scenarios.length ? 'calculated' : 'provisional',
    scenarios,
    leading: decisive ? { key: ranked[0].key, name: ranked[0].name, outcome: ranked[0].outcome, score: ranked[0].score, margin: ranked.length > 1 ? ranked[0].score - ranked[1].score : null } : null,
    read: decisive
      ? `${ranked[0].name} is the dominant dollar path at ${ranked[0].score}/100`
      : `${ranked[0].name} and ${ranked[1].name} are within ${ranked[0].score - ranked[1].score} points, so no path dominates`,
    methodology: 'Each arm of the dollar smile scores its own evidence 0-100 and publishes only with at least two calculated legs. Stress reads VIX, the high-yield spread level and its 91-day change, and NFCI. U.S. outperformance reads the 10Y real-yield and 2Y impulses, credit calm, and 60-session U.S. equity leadership over emerging markets. The defensive path requires that leadership without either a rising-yield carry story or a volatility panic, which is what separates it from the other two. Shares are each arm\'s score over the calculated total; a lead narrower than five points is reported as no dominant path.',
  };
}

/**
 * Score bands for the macro regime. Kept as one classifier so the published
 * regime and the distance-to-flip cannot drift apart.
 */
export function classifyMacroRegimeByScore(score) {
  if (!Number.isFinite(score)) return null;
  if (score >= 70) return 'Expansion / risk-on';
  if (score >= 58) return 'Constructive';
  if (score <= 35) return 'Contraction / risk-off';
  return 'Transition / choppy';
}

/**
 * How many points of score movement would change the regime label, in each
 * direction. A reading one point inside its band is a materially different
 * call from one sitting in the middle of it, and the label alone hides that.
 */
export function calculateMacroRegimeProximity(score) {
  const regime = classifyMacroRegimeByScore(score);
  if (!regime) return null;
  const scan = (step) => {
    for (let distance = 1; distance <= 100; distance += 1) {
      const probe = score + (distance * step);
      if (probe < 0 || probe > 100) return null;
      const next = classifyMacroRegimeByScore(probe);
      if (next !== regime) return { regime: next, distance };
    }
    return null;
  };
  const higher = scan(1);
  const lower = scan(-1);
  const candidates = [
    higher ? { ...higher, direction: 'higher' } : null,
    lower ? { ...lower, direction: 'lower' } : null,
  ].filter(Boolean);
  const nearest = candidates.length
    ? candidates.reduce((closest, item) => (item.distance < closest.distance ? item : closest))
    : null;
  return {
    regime,
    higher,
    lower,
    nearest,
    borderline: Boolean(nearest && nearest.distance <= 3),
    read: nearest
      ? `${score}/100 sits ${nearest.distance} ${nearest.distance === 1 ? 'point' : 'points'} from ${nearest.regime}${nearest.direction === 'higher' ? ' above' : ' below'}.`
      : `${score}/100 is not within reach of another regime band.`,
  };
}

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
    // The change term is dropped when it is missing rather than treated as
    // zero, and the weight it would have carried is reweighted onto the level.
    // Defaulting an absent change to "no change" made a driver read calmer the
    // less the model actually knew about it.
    { key: 'financialConditions', name: 'Financial conditions', score: Number.isFinite(financialLatest) ? clamp(50 - (financialLatest * 40) - (Number.isFinite(financialChange) ? financialChange * 30 : 0)) : null, weight: 0.2, value: financialLatest, change: financialChange, partial: Number.isFinite(financialLatest) && !Number.isFinite(financialChange), source: 'FRED NFCI' },
    { key: 'credit', name: 'High-yield credit', score: Number.isFinite(creditLatest) ? clamp(80 - ((creditLatest - 3) * 15) - (Number.isFinite(creditChange) ? creditChange * 20 : 0)) : null, weight: 0.18, value: creditLatest, change: creditChange, partial: Number.isFinite(creditLatest) && !Number.isFinite(creditChange), source: 'FRED BAMLH0A0HYM2' },
    { key: 'volatility', name: 'Equity volatility', score: Number.isFinite(vixLatest) ? clamp(100 - ((vixLatest - 12) * 3.5)) : null, weight: 0.12, value: vixLatest, change: absoluteChangeOverDays(volatility, 28), source: 'FRED VIXCLS' },
    { key: 'dollar', name: 'Inverse dollar pressure', score: Number.isFinite(usdStrengthModel?.score) ? 100 - usdStrengthModel.score : null, weight: 0.1, value: usdStrengthModel?.score, change: usdStrengthModel?.indicators?.momentum20d, source: usdStrengthModel?.version },
  ];
  const model = driverComposite(drivers, 0.4, 2);
  if (!model.publishable) {
    return { version: 'macro-regime-v1', status: 'unavailable', asOf: null, score: null, regime: null, settings: null, coverage: model.coverage, panicConfirmed: null, missing: model.missing, drivers: model.drivers };
  }
  const panicInputsAvailable = [vixLatest, creditLatest, financialLatest].every(Number.isFinite);
  const panicConfirmed = panicInputsAvailable ? vixLatest >= 35 && creditLatest >= 5 && financialLatest >= 0.5 : null;
  const regime = panicConfirmed ? 'Stress / deleveraging' : classifyMacroRegimeByScore(model.score);
  // Panic overrides the score bands entirely, so proximity to them would be
  // misleading while it holds.
  const proximity = panicConfirmed ? null : calculateMacroRegimeProximity(model.score);
  // The regime is only as current as its oldest binding input. Publishing the
  // freshest one stamped a model leaning on a six-week-old NFCI reading with
  // today's VIX date; both ends are now published and `asOf` is the older.
  const contributing = [
    { key: 'liquidity', name: 'US liquidity model', date: liquidityModel?.asOf ?? null },
    { key: 'dollar', name: 'Dollar strength model', date: usdStrengthModel?.asOf ?? null },
    { key: 'financialConditions', name: 'FRED NFCI', date: financialConditions.at(-1)?.date ?? null },
    { key: 'credit', name: 'FRED BAMLH0A0HYM2', date: credit.at(-1)?.date ?? null },
    { key: 'volatility', name: 'FRED VIXCLS', date: volatility.at(-1)?.date ?? null },
  ].filter((entry) => entry.date && model.drivers.some((driver) => driver.key === entry.key && driver.score !== null));
  const dated = contributing.map((entry) => entry.date).sort();
  const asOf = dated.at(0) ?? null;
  const oldestInput = contributing.find((entry) => entry.date === dated.at(0)) ?? null;
  const freshestInput = contributing.find((entry) => entry.date === dated.at(-1)) ?? null;
  return {
    version: 'macro-regime-v1',
    status: model.coverage >= 75 ? 'calculated' : 'provisional',
    asOf,
    vintage: {
      oldestInput,
      freshestInput,
      spreadDays: oldestInput && freshestInput ? Math.round((new Date(freshestInput.date) - new Date(oldestInput.date)) / DAY_MS) : null,
      note: 'asOf is the oldest input still binding on the score, not the freshest one available.',
    },
    partialDrivers: model.drivers.filter((driver) => drivers.find((definition) => definition.key === driver.key)?.partial).map((driver) => driver.name),
    score: model.score,
    regime,
    coverage: model.coverage,
    confidence: model.coverage >= 85 ? 'High' : model.coverage >= 65 ? 'Medium' : 'Low',
    panicConfirmed,
    proximity,
    missing: model.missing,
    drivers: model.drivers,
    settings: MACRO_REGIME_SETTINGS[regime],
  };
}
