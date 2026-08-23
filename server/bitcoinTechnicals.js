/**
 * Close-only technical models for the bitcoin predictive workspace.
 *
 * Everything here runs off a daily close series, which is what the existing
 * Yahoo history loader returns. Models that genuinely need the high, the low or
 * volume are not approximated with closes — they report `unavailable` and name
 * the feed they are waiting on, so a reader is never shown an ATR-shaped number
 * that was really computed from closes.
 */

const DAY_MS = 86_400_000;

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function standardDeviation(values) {
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(values.reduce((total, value) => total + ((value - average) ** 2), 0) / (values.length - 1));
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Share of the sample at or below `value`, 0-100. */
export function percentileRank(values, value) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length || !Number.isFinite(value)) return null;
  const atOrBelow = finite.filter((entry) => entry <= value).length;
  return (atOrBelow / finite.length) * 100;
}

export function smaSeries(values, period) {
  const result = Array(values.length).fill(null);
  if (period < 1 || values.length < period) return result;
  let running = 0;
  for (let index = 0; index < values.length; index += 1) {
    running += values[index];
    if (index >= period) running -= values[index - period];
    if (index >= period - 1) result[index] = running / period;
  }
  return result;
}

export function emaSeries(values, period) {
  const result = Array(values.length).fill(null);
  if (period < 1 || values.length < period) return result;
  const multiplier = 2 / (period + 1);
  result[period - 1] = mean(values.slice(0, period));
  for (let index = period; index < values.length; index += 1) {
    result[index] = ((values[index] - result[index - 1]) * multiplier) + result[index - 1];
  }
  return result;
}

/**
 * Wilder-smoothed RSI as a full series, so divergence scans and stochastic RSI
 * read the same numbers the headline RSI reports.
 */
export function rsiSeries(values, period = 14) {
  const result = Array(values.length).fill(null);
  if (values.length <= period) return result;
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain += Math.max(change, 0);
    averageLoss += Math.max(-change, 0);
  }
  averageGain /= period;
  averageLoss /= period;
  const toRsi = () => {
    if (averageLoss === 0 && averageGain === 0) return 50;
    if (averageLoss === 0) return 100;
    return 100 - (100 / (1 + (averageGain / averageLoss)));
  };
  result[period] = toRsi();
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = ((averageGain * (period - 1)) + Math.max(change, 0)) / period;
    averageLoss = ((averageLoss * (period - 1)) + Math.max(-change, 0)) / period;
    result[index] = toRsi();
  }
  return result;
}

/** Normalises loose point shapes into sorted `{ date, close }` rows. */
export function normalizeCloses(points = []) {
  return (Array.isArray(points) ? points : [])
    .map((point) => {
      const close = Number(point?.close ?? point?.value);
      const date = point?.date ?? point?.timestamp ?? null;
      if (!Number.isFinite(close) || close <= 0 || !date) return null;
      const time = new Date(date).getTime();
      if (!Number.isFinite(time)) return null;
      return { date: new Date(time).toISOString().slice(0, 10), close, time };
    })
    .filter(Boolean)
    .sort((left, right) => left.time - right.time);
}

/** Last close of each seven-day bucket, which is what a weekly average needs. */
export function toWeeklyCloses(rows) {
  const byWeek = new Map();
  rows.forEach((row) => {
    byWeek.set(Math.floor(row.time / (DAY_MS * 7)), row);
  });
  return [...byWeek.entries()].sort((left, right) => left[0] - right[0]).map(([, row]) => row);
}

function unavailable(version, reason, extra = {}) {
  return { version, status: 'unavailable', reason, ...extra };
}

/**
 * Stochastic RSI: where the current RSI sits inside its own recent range. It
 * turns before RSI does, which is the point of carrying both.
 */
export function calculateStochasticRsi(points, { rsiPeriod = 14, stochasticPeriod = 14, kSmoothing = 3, dSmoothing = 3 } = {}) {
  const version = 'bitcoin-stochastic-rsi-v1';
  const rows = normalizeCloses(points);
  const required = rsiPeriod + stochasticPeriod + kSmoothing + dSmoothing;
  if (rows.length < required) {
    return unavailable(version, `Needs ${required} daily closes to smooth a stochastic RSI; ${rows.length} available.`, { observations: rows.length });
  }
  const rsi = rsiSeries(rows.map((row) => row.close), rsiPeriod);
  const raw = rsi.map((value, index) => {
    if (!Number.isFinite(value) || index < rsiPeriod + stochasticPeriod - 1) return null;
    const window = rsi.slice(index - stochasticPeriod + 1, index + 1).filter(Number.isFinite);
    if (window.length < stochasticPeriod) return null;
    const low = Math.min(...window);
    const high = Math.max(...window);
    return high === low ? 50 : ((value - low) / (high - low)) * 100;
  });
  const rawFinite = raw.filter(Number.isFinite);
  const kLine = smaSeries(rawFinite, kSmoothing).filter(Number.isFinite);
  const dLine = smaSeries(kLine, dSmoothing).filter(Number.isFinite);
  if (!kLine.length || dLine.length < 2) {
    return unavailable(version, 'Not enough smoothed observations to publish both the %K and %D lines.', { observations: rows.length });
  }
  const k = kLine.at(-1);
  const d = dLine.at(-1);
  const previousK = kLine.at(-2);
  const previousD = dLine.at(-2);
  // A rolling mean leaves float dust behind, so a pair that is arithmetically
  // equal can compare as 9e-15 apart and swallow a real cross. Anything inside
  // the epsilon counts as touching rather than as an ordering.
  const CROSS_EPSILON = 1e-9;
  const previousGap = Number.isFinite(previousK) && Number.isFinite(previousD) ? previousK - previousD : null;
  const gap = k - d;
  const crossed = previousGap === null
    ? null
    : previousGap <= CROSS_EPSILON && gap > CROSS_EPSILON ? 'bullish'
      : previousGap >= -CROSS_EPSILON && gap < -CROSS_EPSILON ? 'bearish'
        : null;
  const zone = k >= 80 ? 'overbought' : k <= 20 ? 'oversold' : 'neutral';
  return {
    version,
    status: 'calculated',
    asOf: rows.at(-1).date,
    observations: rows.length,
    k: round(k, 1),
    d: round(d, 1),
    zone,
    cross: crossed,
    read: `Stochastic RSI %K is ${round(k, 1)} (${zone})${crossed ? `, with a ${crossed} cross of the %D line on the latest bar` : ''}.`,
    methodology: `RSI(${rsiPeriod}) is ranked inside its own ${stochasticPeriod}-bar range, then smoothed ${kSmoothing} bars for %K and a further ${dSmoothing} for %D. Above 80 is overbought and below 20 oversold, measured against RSI's range rather than price's.`,
  };
}

function findPivots(values, window) {
  const lows = [];
  const highs = [];
  for (let index = window; index < values.length - window; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) continue;
    const neighbourhood = values.slice(index - window, index + window + 1).filter(Number.isFinite);
    if (neighbourhood.length !== (window * 2) + 1) continue;
    if (value === Math.min(...neighbourhood) && neighbourhood.filter((entry) => entry === value).length === 1) lows.push(index);
    if (value === Math.max(...neighbourhood) && neighbourhood.filter((entry) => entry === value).length === 1) highs.push(index);
  }
  return { lows, highs };
}

const DIVERGENCE_KINDS = {
  regularBullish: { name: 'Regular bullish divergence', implication: 'Price made a lower low while momentum did not — sellers are losing force into the low.' },
  hiddenBullish: { name: 'Hidden bullish divergence', implication: 'Price held a higher low while momentum made a lower low — a pullback inside an uptrend.' },
  regularBearish: { name: 'Regular bearish divergence', implication: 'Price made a higher high while momentum did not — buyers are losing force into the high.' },
  hiddenBearish: { name: 'Hidden bearish divergence', implication: 'Price made a lower high while momentum made a higher high — a bounce inside a downtrend.' },
};

/**
 * All four RSI divergence types, read off confirmed price pivots. A pivot needs
 * `pivotWindow` bars on each side, so the newest bars can never form one — the
 * model reports how stale the reading is rather than pretending otherwise.
 */
export function detectRsiDivergences(points, { rsiPeriod = 14, pivotWindow = 5, lookbackBars = 120, minimumSeparation = 5 } = {}) {
  const version = 'bitcoin-rsi-divergence-v1';
  const rows = normalizeCloses(points);
  const required = rsiPeriod + (pivotWindow * 2) + minimumSeparation + 10;
  if (rows.length < required) {
    return unavailable(version, `Needs ${required} daily closes to confirm two pivots either side of a divergence; ${rows.length} available.`, { observations: rows.length, divergences: [] });
  }
  const closes = rows.map((row) => row.close);
  const rsi = rsiSeries(closes, rsiPeriod);
  const start = Math.max(rsiPeriod + 1, rows.length - lookbackBars);
  const windowCloses = closes.slice(start);
  const { lows, highs } = findPivots(windowCloses, pivotWindow);
  const divergences = [];

  const compare = (indices, kindWhenLower, kindWhenHigher, isLow) => {
    for (let position = indices.length - 1; position >= 1; position -= 1) {
      const current = indices[position];
      const previous = indices[position - 1];
      if (current - previous < minimumSeparation) continue;
      const currentPrice = windowCloses[current];
      const previousPrice = windowCloses[previous];
      const currentRsi = rsi[start + current];
      const previousRsi = rsi[start + previous];
      if (!Number.isFinite(currentRsi) || !Number.isFinite(previousRsi)) continue;
      const priceLower = currentPrice < previousPrice;
      const rsiLower = currentRsi < previousRsi;
      const kind = isLow
        ? (priceLower && !rsiLower ? kindWhenLower : !priceLower && rsiLower ? kindWhenHigher : null)
        : (!priceLower && rsiLower ? kindWhenLower : priceLower && !rsiLower ? kindWhenHigher : null);
      if (!kind) continue;
      divergences.push({
        kind,
        name: DIVERGENCE_KINDS[kind].name,
        implication: DIVERGENCE_KINDS[kind].implication,
        direction: kind.endsWith('Bullish') ? 'bullish' : 'bearish',
        from: { date: rows[start + previous].date, price: round(previousPrice, 2), rsi: round(previousRsi, 1) },
        to: { date: rows[start + current].date, price: round(currentPrice, 2), rsi: round(currentRsi, 1) },
        barsSinceConfirmed: rows.length - 1 - (start + current) - pivotWindow,
      });
      return;
    }
  };

  compare(lows, 'regularBullish', 'hiddenBullish', true);
  compare(highs, 'regularBearish', 'hiddenBearish', false);
  divergences.sort((left, right) => left.barsSinceConfirmed - right.barsSinceConfirmed);

  return {
    version,
    status: 'calculated',
    asOf: rows.at(-1).date,
    observations: rows.length,
    pivotWindow,
    divergences,
    read: divergences.length
      ? `${divergences[0].name} confirmed ${divergences[0].barsSinceConfirmed} bars ago between ${divergences[0].from.date} and ${divergences[0].to.date}.`
      : `No RSI divergence on confirmed pivots in the last ${Math.min(lookbackBars, rows.length)} bars.`,
    methodology: `Price pivots need ${pivotWindow} bars on each side to confirm, so the newest ${pivotWindow} bars cannot yet host one and every divergence is reported with the bar count since it confirmed. A pivot pair at least ${minimumSeparation} bars apart is compared against RSI(${rsiPeriod}) at the same bars: a lower price low against a higher RSI low is regular bullish, a higher price low against a lower RSI low is hidden bullish, and the mirror pair on pivot highs gives the bearish cases.`,
  };
}

const MOVING_AVERAGES = [
  { key: 'ema20', name: '20-day EMA', period: 20, kind: 'ema', cadence: 'daily' },
  { key: 'ema50', name: '50-day EMA', period: 50, kind: 'ema', cadence: 'daily' },
  { key: 'ema100', name: '100-day EMA', period: 100, kind: 'ema', cadence: 'daily' },
  { key: 'ema200', name: '200-day EMA', period: 200, kind: 'ema', cadence: 'daily' },
  { key: 'sma200', name: '200-day MA', period: 200, kind: 'sma', cadence: 'daily' },
];

const WEEKLY_AVERAGES = [
  { key: 'ema21w', name: '21-week EMA', period: 21, kind: 'ema', cadence: 'weekly' },
  { key: 'sma200w', name: '200-week SMA', period: 200, kind: 'sma', cadence: 'weekly' },
];

/**
 * The full moving-average stack, the 50/200 cross, and how stretched price is
 * from its 200-day average measured as a Z-score of that distance's own
 * history rather than as a raw percentage.
 */
export function calculateMovingAverageStack(points, { zScoreMinimum = 250 } = {}) {
  const version = 'bitcoin-moving-average-stack-v1';
  const rows = normalizeCloses(points);
  if (rows.length < 30) {
    return unavailable(version, `Needs at least 30 daily closes; ${rows.length} available.`, { observations: rows.length, averages: [] });
  }
  const closes = rows.map((row) => row.close);
  const price = closes.at(-1);
  const weekly = toWeeklyCloses(rows);
  const weeklyCloses = weekly.map((row) => row.close);

  const averages = [...MOVING_AVERAGES, ...WEEKLY_AVERAGES].map((definition) => {
    const source = definition.cadence === 'weekly' ? weeklyCloses : closes;
    const series = definition.kind === 'ema' ? emaSeries(source, definition.period) : smaSeries(source, definition.period);
    const value = series.at(-1);
    const available = Number.isFinite(value);
    return {
      ...definition,
      value: available ? round(value, 2) : null,
      distancePercent: available ? round(((price / value) - 1) * 100, 2) : null,
      side: available ? (price >= value ? 'above' : 'below') : null,
      status: available ? 'calculated' : 'unavailable',
      reason: available ? null : `Needs ${definition.period} ${definition.cadence} closes; ${source.length} available.`,
    };
  });

  const dailyStack = ['ema20', 'ema50', 'ema100', 'ema200']
    .map((key) => averages.find((entry) => entry.key === key))
    .filter((entry) => entry.status === 'calculated');
  const stackAlignment = dailyStack.length < 4
    ? null
    : dailyStack.every((entry, index) => index === 0 || dailyStack[index - 1].value > entry.value) ? 'bullish'
      : dailyStack.every((entry, index) => index === 0 || dailyStack[index - 1].value < entry.value) ? 'bearish'
        : 'mixed';

  const fast = smaSeries(closes, 50);
  const slow = smaSeries(closes, 200);
  let cross = null;
  for (let index = closes.length - 1; index >= 1; index -= 1) {
    const current = Number.isFinite(fast[index]) && Number.isFinite(slow[index]) ? fast[index] - slow[index] : null;
    const previous = Number.isFinite(fast[index - 1]) && Number.isFinite(slow[index - 1]) ? fast[index - 1] - slow[index - 1] : null;
    if (current === null || previous === null) break;
    if ((previous <= 0 && current > 0) || (previous >= 0 && current < 0)) {
      cross = {
        type: current > 0 ? 'golden' : 'death',
        date: rows[index].date,
        barsSince: closes.length - 1 - index,
      };
      break;
    }
  }
  const crossState = Number.isFinite(fast.at(-1)) && Number.isFinite(slow.at(-1))
    ? (fast.at(-1) >= slow.at(-1) ? 'golden' : 'death')
    : null;

  const distances = closes
    .map((close, index) => (Number.isFinite(slow[index]) ? Math.log(close / slow[index]) : null))
    .filter(Number.isFinite);
  const distanceMean = mean(distances);
  const distanceDeviation = standardDeviation(distances);
  const zScore = distances.length >= 60 && distanceDeviation
    ? (distances.at(-1) - distanceMean) / distanceDeviation
    : null;

  const calculatedAverages = averages.filter((entry) => entry.status === 'calculated');
  if (!calculatedAverages.length) {
    return unavailable(version, 'No moving average in the stack has enough history to publish.', { observations: rows.length, averages });
  }
  const aboveCount = calculatedAverages.filter((entry) => entry.side === 'above').length;

  return {
    version,
    status: calculatedAverages.length === averages.length && zScore !== null ? 'calculated' : 'provisional',
    asOf: rows.at(-1).date,
    observations: rows.length,
    weeklyObservations: weekly.length,
    price: round(price, 2),
    averages,
    aboveCount,
    totalPublished: calculatedAverages.length,
    totalDefined: averages.length,
    missingAverages: averages.filter((entry) => entry.status !== 'calculated').map((entry) => entry.name),
    stackAlignment,
    cross,
    crossState,
    zScore: zScore === null ? null : round(zScore, 2),
    zScoreStatus: zScore === null ? 'unavailable' : distances.length >= zScoreMinimum ? 'calculated' : 'provisional',
    zScoreObservations: distances.length,
    read: `Price is above ${aboveCount} of the ${calculatedAverages.length} averages the history can publish${stackAlignment ? `, with a ${stackAlignment} daily stack` : ''}${crossState ? `, and the 50/200 pair sits in ${crossState}-cross territory${cross ? ` since ${cross.date}` : ''}` : ''}${zScore === null ? '' : `. Distance from the 200-day average is ${round(zScore, 2)} standard deviations from its own history`}.`,
    methodology: 'Daily EMAs and the 200-day MA run on daily closes; the 21-week EMA and 200-week SMA run on the last close of each week rather than a 147- or 1400-day approximation. The cross state compares the 50- and 200-day simple averages and reports the bar the sign last changed. Stretch is a Z-score of log(price / 200-day average) against that ratio’s own distribution, so it is comparable across cycles in a way a raw percentage is not, and it is marked provisional until 250 observations back it.',
  };
}

/**
 * Bollinger bandwidth compression. A squeeze is a low bandwidth percentile, not
 * a fixed bandwidth level, because bitcoin’s baseline volatility drifts.
 */
export function calculateBollingerSqueeze(points, { period = 20, multiplier = 2, lookbackBars = 252, squeezePercentile = 20 } = {}) {
  const version = 'bitcoin-bollinger-squeeze-v1';
  const rows = normalizeCloses(points);
  if (rows.length < period + 30) {
    return unavailable(version, `Needs ${period + 30} daily closes to rank bandwidth against its own history; ${rows.length} available.`, { observations: rows.length });
  }
  const closes = rows.map((row) => row.close);
  const middle = smaSeries(closes, period);
  const bandwidths = closes.map((_, index) => {
    if (!Number.isFinite(middle[index])) return null;
    const deviation = standardDeviation(closes.slice(index - period + 1, index + 1));
    if (!Number.isFinite(deviation) || !middle[index]) return null;
    return ((deviation * multiplier * 2) / middle[index]) * 100;
  });
  const finite = bandwidths.filter(Number.isFinite);
  const current = finite.at(-1);
  const history = finite.slice(-lookbackBars);
  const percentile = percentileRank(history, current);
  if (!Number.isFinite(current) || percentile === null) {
    return unavailable(version, 'Bandwidth could not be ranked against its own history.', { observations: rows.length });
  }
  const deviationNow = standardDeviation(closes.slice(-period));
  const middleNow = middle.at(-1);
  const state = percentile <= squeezePercentile ? 'squeeze' : percentile >= 80 ? 'expansion' : 'normal';
  return {
    version,
    status: history.length >= lookbackBars ? 'calculated' : 'provisional',
    asOf: rows.at(-1).date,
    observations: rows.length,
    rankedAgainst: history.length,
    bandwidthPercent: round(current, 2),
    percentile: round(percentile, 1),
    state,
    upper: round(middleNow + (deviationNow * multiplier), 2),
    middle: round(middleNow, 2),
    lower: round(middleNow - (deviationNow * multiplier), 2),
    read: state === 'squeeze'
      ? `Bandwidth is in the ${round(percentile, 1)}th percentile of the last ${history.length} bars — a compression, which sets up a range break without saying which way.`
      : state === 'expansion'
        ? `Bandwidth is in the ${round(percentile, 1)}th percentile — bands are already wide, so the move is under way rather than pending.`
        : `Bandwidth sits at the ${round(percentile, 1)}th percentile, neither compressed nor expanded.`,
    methodology: `Bandwidth is (upper - lower) / middle on a ${period}-bar, ${multiplier}-deviation band, ranked against its own last ${lookbackBars} readings. A squeeze is the bottom ${squeezePercentile}% of that distribution rather than an absolute width, because the baseline moves between cycles. A squeeze is direction-neutral by construction.`,
  };
}

/** Where the current trailing range sits against its own history. */
export function calculateRangePercentile(points, { window = 30, lookbackBars = 365 } = {}) {
  const version = 'bitcoin-range-percentile-v1';
  const rows = normalizeCloses(points);
  if (rows.length < window + 60) {
    return unavailable(version, `Needs ${window + 60} daily closes to rank a ${window}-bar range; ${rows.length} available.`, { observations: rows.length });
  }
  const closes = rows.map((row) => row.close);
  const ranges = closes.map((_, index) => {
    if (index < window - 1) return null;
    const slice = closes.slice(index - window + 1, index + 1);
    const low = Math.min(...slice);
    const high = Math.max(...slice);
    return low > 0 ? ((high / low) - 1) * 100 : null;
  }).filter(Number.isFinite);
  const current = ranges.at(-1);
  const history = ranges.slice(-lookbackBars);
  const percentile = percentileRank(history, current);
  const slice = closes.slice(-window);
  const low = Math.min(...slice);
  const high = Math.max(...slice);
  const position = high > low ? ((closes.at(-1) - low) / (high - low)) * 100 : 50;
  return {
    version,
    status: history.length >= lookbackBars ? 'calculated' : 'provisional',
    asOf: rows.at(-1).date,
    observations: rows.length,
    rankedAgainst: history.length,
    window,
    rangePercent: round(current, 2),
    percentile: round(percentile, 1),
    positionInRange: round(position, 1),
    high: round(high, 2),
    low: round(low, 2),
    read: `The ${window}-bar range spans ${round(current, 2)}%, the ${round(percentile, 1)}th percentile of the last ${history.length} readings, with price ${round(position, 1)}% of the way up it.`,
    methodology: `Range is high-over-low across ${window} closes, ranked against its own last ${lookbackBars} readings. Closes only: an intraday high or low outside the closing range is not captured, so this reads slightly tighter than a true high/low range.`,
  };
}

/**
 * DeMark TD Setup. The setup count is close-only by definition, so it is exact
 * here. The countdown and a perfected setup both compare closes to the highs
 * and lows two bars back and are reported as unavailable rather than faked.
 */
export function calculateTdSetup(points, { comparisonBars = 4, completeAt = 9 } = {}) {
  const version = 'bitcoin-td-setup-v1';
  const rows = normalizeCloses(points);
  if (rows.length < comparisonBars + completeAt + 1) {
    return unavailable(version, `Needs ${comparisonBars + completeAt + 1} daily closes to count a setup; ${rows.length} available.`, { observations: rows.length });
  }
  const closes = rows.map((row) => row.close);
  const lastIndex = closes.length - 1;
  const direction = closes[lastIndex] < closes[lastIndex - comparisonBars] ? 'buy'
    : closes[lastIndex] > closes[lastIndex - comparisonBars] ? 'sell'
      : null;
  let count = 0;
  if (direction) {
    for (let index = lastIndex; index >= comparisonBars; index -= 1) {
      const qualifies = direction === 'buy'
        ? closes[index] < closes[index - comparisonBars]
        : closes[index] > closes[index - comparisonBars];
      if (!qualifies) break;
      count += 1;
    }
  }
  const displayCount = Math.min(count, completeAt);
  const complete = count >= completeAt;
  return {
    version,
    status: 'calculated',
    asOf: rows.at(-1).date,
    observations: rows.length,
    direction,
    count: displayCount,
    rawCount: count,
    complete,
    countdown: { status: 'unavailable', reason: 'TD Countdown compares each close to the low or high two bars back, which needs daily highs and lows the close-only feed does not carry.' },
    perfected: { status: 'unavailable', reason: 'A perfected setup compares bars 8 and 9 to the lows or highs of bars 6 and 7, which needs daily highs and lows.' },
    tdst: { status: 'unavailable', reason: 'The TDST line is the extreme high or low of the setup, which needs daily highs and lows.' },
    read: direction === null
      ? 'The latest close matches the close four bars back, so no TD setup is running.'
      : `TD ${direction} setup at ${displayCount}${complete ? ' — the count has completed' : ` of ${completeAt}`}.`,
    methodology: `A TD buy setup counts consecutive closes below the close ${comparisonBars} bars earlier, a sell setup counts closes above it, and the count completes at ${completeAt}. Bars beyond ${completeAt} are reported separately as the raw count. Countdown, perfection and the TDST line all require daily highs and lows and are withheld until an OHLC feed is wired.`,
  };
}

/** Rate of change of momentum itself: the OLS slope of RSI over a short window. */
export function calculateMomentumSlope(points, { rsiPeriod = 14, window = 14 } = {}) {
  const version = 'bitcoin-momentum-slope-v1';
  const rows = normalizeCloses(points);
  if (rows.length < rsiPeriod + window + 1) {
    return unavailable(version, `Needs ${rsiPeriod + window + 1} daily closes; ${rows.length} available.`, { observations: rows.length });
  }
  const rsi = rsiSeries(rows.map((row) => row.close), rsiPeriod).filter(Number.isFinite);
  const slice = rsi.slice(-window);
  if (slice.length < window) {
    return unavailable(version, `Needs ${window} RSI observations; ${slice.length} available.`, { observations: rows.length });
  }
  const xMean = (slice.length - 1) / 2;
  const yMean = mean(slice);
  let covariance = 0;
  let variance = 0;
  slice.forEach((value, index) => {
    covariance += (index - xMean) * (value - yMean);
    variance += (index - xMean) ** 2;
  });
  const slope = variance ? covariance / variance : 0;
  return {
    version,
    status: 'calculated',
    asOf: rows.at(-1).date,
    observations: rows.length,
    rsi: round(rsi.at(-1), 1),
    slopePerBar: round(slope, 3),
    slopePerWindow: round(slope * window, 2),
    direction: slope > 0.1 ? 'accelerating' : slope < -0.1 ? 'decelerating' : 'flat',
    read: `RSI is ${round(rsi.at(-1), 1)} and moving ${round(slope * window, 2)} points per ${window} bars, so momentum is ${slope > 0.1 ? 'accelerating' : slope < -0.1 ? 'decelerating' : 'flat'}.`,
    methodology: `An ordinary least-squares fit through the last ${window} RSI(${rsiPeriod}) readings. It answers whether momentum is improving or fading, which a single RSI level cannot: RSI 60 rising and RSI 60 falling are opposite tapes.`,
  };
}

/** Trailing return divided by realized volatility over the same window. */
export function calculateVolatilityAdjustedMomentum(points, { window = 90, annualizationDays = 365 } = {}) {
  const version = 'bitcoin-volatility-adjusted-momentum-v1';
  const rows = normalizeCloses(points);
  if (rows.length < window + 1) {
    return unavailable(version, `Needs ${window + 1} daily closes; ${rows.length} available.`, { observations: rows.length });
  }
  const closes = rows.map((row) => row.close).slice(-(window + 1));
  const returns = closes.slice(1).map((value, index) => Math.log(value / closes[index]));
  const deviation = standardDeviation(returns);
  if (!deviation) {
    return unavailable(version, 'Realized volatility over the window is zero, so a volatility-adjusted reading is undefined.', { observations: rows.length });
  }
  const totalReturn = (closes.at(-1) / closes[0]) - 1;
  const annualizedVolatility = deviation * Math.sqrt(annualizationDays);
  const windowVolatility = deviation * Math.sqrt(window);
  const ratio = Math.log(closes.at(-1) / closes[0]) / windowVolatility;
  return {
    version,
    status: 'calculated',
    asOf: rows.at(-1).date,
    observations: rows.length,
    window,
    returnPercent: round(totalReturn * 100, 2),
    annualizedVolatilityPercent: round(annualizedVolatility * 100, 1),
    ratio: round(ratio, 2),
    quality: ratio > 1 ? 'strong' : ratio > 0 ? 'positive but noisy' : ratio > -1 ? 'negative but noisy' : 'weak',
    read: `Over ${window} bars price moved ${round(totalReturn * 100, 2)}% against ${round(annualizedVolatility * 100, 1)}% annualized volatility, a ${round(ratio, 2)} move-per-unit-of-risk.`,
    methodology: `Log return over the window divided by the standard deviation of daily log returns scaled to that window. A 40% advance through violent chop and a 40% advance through a quiet grind score very differently, which is the whole point of carrying it alongside raw momentum.`,
  };
}

/**
 * The close-only momentum composite. Every published leg is equally weighted
 * and the composite is provisional until at least four legs report.
 */
export function calculateBitcoinTechnicals(points, options = {}) {
  const version = 'bitcoin-technicals-v1';
  const rows = normalizeCloses(points);
  const modules = {
    stochasticRsi: calculateStochasticRsi(rows, options.stochasticRsi),
    divergences: detectRsiDivergences(rows, options.divergences),
    movingAverages: calculateMovingAverageStack(rows, options.movingAverages),
    squeeze: calculateBollingerSqueeze(rows, options.squeeze),
    range: calculateRangePercentile(rows, options.range),
    tdSetup: calculateTdSetup(rows, options.tdSetup),
    momentumSlope: calculateMomentumSlope(rows, options.momentumSlope),
    volatilityAdjustedMomentum: calculateVolatilityAdjustedMomentum(rows, options.volatilityAdjustedMomentum),
  };

  const legs = [];
  const stack = modules.movingAverages;
  if (stack.status !== 'unavailable' && stack.totalPublished) {
    legs.push({ key: 'trend', name: 'Position in the moving-average stack', score: (stack.aboveCount / stack.totalPublished) * 100 });
  }
  if (Number.isFinite(stack.zScore)) {
    legs.push({ key: 'stretch', name: 'Distance from the 200-day average', score: clamp(50 + (stack.zScore * 20)) });
  }
  if (modules.momentumSlope.status === 'calculated') {
    legs.push({ key: 'momentum', name: 'RSI level', score: clamp(modules.momentumSlope.rsi) });
    legs.push({ key: 'momentumSlope', name: 'Momentum slope', score: clamp(50 + (modules.momentumSlope.slopePerWindow * 2)) });
  }
  if (modules.stochasticRsi.status === 'calculated') {
    legs.push({ key: 'stochasticRsi', name: 'Stochastic RSI', score: clamp(modules.stochasticRsi.k) });
  }
  if (modules.volatilityAdjustedMomentum.status === 'calculated') {
    legs.push({ key: 'riskAdjusted', name: 'Volatility-adjusted momentum', score: clamp(50 + (modules.volatilityAdjustedMomentum.ratio * 20)) });
  }
  if (modules.range.status !== 'unavailable' && Number.isFinite(modules.range.positionInRange)) {
    legs.push({ key: 'rangePosition', name: 'Position in the trailing range', score: clamp(modules.range.positionInRange) });
  }

  const TOTAL_LEGS = 7;
  const score = legs.length >= 3 ? Math.round(mean(legs.map((leg) => leg.score))) : null;
  const unavailableModules = Object.entries(modules).filter(([, value]) => value.status === 'unavailable').map(([key]) => key);
  // A module that publishes on a thin sample is not the same as a complete one:
  // the composite stays provisional until every module is fully backed, so a
  // short history reads as short instead of as a settled reading.
  const provisionalModules = Object.entries(modules).filter(([, value]) => value.status === 'provisional').map(([key]) => key);

  return {
    version,
    status: score === null ? 'unavailable' : (unavailableModules.length || provisionalModules.length) ? 'provisional' : 'calculated',
    reason: score === null ? 'Fewer than three momentum legs could be calculated from the available price history.' : null,
    asOf: rows.length ? rows.at(-1).date : null,
    observations: rows.length,
    score,
    stance: score === null ? null : score >= 70 ? 'Strong' : score >= 55 ? 'Constructive' : score >= 45 ? 'Neutral' : score >= 30 ? 'Guarded' : 'Weak',
    legs: legs.map((leg) => ({ ...leg, score: Math.round(leg.score) })),
    coverage: Math.round((legs.length / TOTAL_LEGS) * 100),
    unavailableModules,
    provisionalModules,
    modules,
    methodology: 'Each leg is scored 0-100 on the same axis — higher is a stronger tape — and the composite is their unweighted average. It needs three legs to publish at all and reports as provisional while any module is missing, so a thin history reads as thin rather than as calm.',
  };
}
