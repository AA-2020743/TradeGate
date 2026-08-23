/**
 * Models that genuinely need the daily high, low and volume.
 *
 * These are the ones `bitcoinTechnicals.js` refuses to approximate from
 * closes: true ranges, real channel breakouts, the DeMark countdown and its
 * qualifiers, and anything volume-weighted. They publish only when an OHLCV
 * feed is wired; a close-only feed leaves them unavailable rather than
 * silently substituting closes for the extremes.
 */

const DAY_MS = 86_400_000;

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentileRank(values, value) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length || !Number.isFinite(value)) return null;
  return (finite.filter((entry) => entry <= value).length / finite.length) * 100;
}

function unavailable(version, reason, extra = {}) {
  return { version, status: 'unavailable', reason, ...extra };
}

/**
 * Sorted `{ date, open, high, low, close, volume }` bars. A bar whose high is
 * below its low, or whose close sits outside its own range, is dropped rather
 * than repaired: a broken bar corrupts every range model downstream.
 */
export function normalizeBars(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const date = row?.date ?? row?.timestamp ?? null;
      if (!date) return null;
      const time = new Date(date).getTime();
      if (!Number.isFinite(time)) return null;
      const open = Number(row?.open);
      const high = Number(row?.high);
      const low = Number(row?.low);
      const close = Number(row?.close);
      // A bar that is re-normalized must not gain a volume it never had:
      // Number(null) is 0, which would turn "no volume feed" into a real zero.
      const rawVolume = row?.volume;
      const volume = rawVolume === null || rawVolume === undefined || rawVolume === '' ? NaN : Number(rawVolume);
      if (![open, high, low, close].every((value) => Number.isFinite(value) && value > 0)) return null;
      if (high < low || close > high || close < low || open > high || open < low) return null;
      return {
        date: new Date(time).toISOString().slice(0, 10),
        time,
        open,
        high,
        low,
        close,
        volume: Number.isFinite(volume) && volume >= 0 ? volume : null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.time - right.time);
}

function trueRanges(bars) {
  return bars.map((bar, index) => {
    if (index === 0) return bar.high - bar.low;
    const previousClose = bars[index - 1].close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
  });
}

/** Wilder ATR as a series, so expansion can be measured against its own past. */
export function atrSeries(bars, period = 14) {
  const ranges = trueRanges(bars);
  const result = Array(bars.length).fill(null);
  if (bars.length <= period) return result;
  let atr = mean(ranges.slice(1, period + 1));
  result[period] = atr;
  for (let index = period + 1; index < bars.length; index += 1) {
    atr = ((atr * (period - 1)) + ranges[index]) / period;
    result[index] = atr;
  }
  return result;
}

/**
 * Is the true range expanding, and how does that sit against its own history?
 * Expansion is reported as an ATR percentile plus a ratio against the ATR
 * `comparisonBars` ago, because a rising ATR from a compressed base and one
 * from an already-violent base mean different things.
 */
export function calculateAtrExpansion(rows, { period = 14, lookbackBars = 252, comparisonBars = 20 } = {}) {
  const version = 'bitcoin-atr-expansion-v1';
  const bars = normalizeBars(rows);
  if (bars.length < period + comparisonBars + 10) {
    return unavailable(version, `Needs ${period + comparisonBars + 10} daily bars with highs and lows; ${bars.length} available.`, { observations: bars.length });
  }
  const series = atrSeries(bars, period);
  const finite = series.filter(Number.isFinite);
  const atr = finite.at(-1);
  const close = bars.at(-1).close;
  const atrPercent = (atr / close) * 100;
  const percentSeries = series
    .map((value, index) => (Number.isFinite(value) ? (value / bars[index].close) * 100 : null))
    .filter(Number.isFinite);
  const history = percentSeries.slice(-lookbackBars);
  const percentile = percentileRank(history, atrPercent);
  const past = percentSeries.at(-1 - comparisonBars);
  const ratio = Number.isFinite(past) && past > 0 ? atrPercent / past : null;
  const state = ratio === null ? null : ratio >= 1.25 ? 'expanding' : ratio <= 0.8 ? 'contracting' : 'steady';
  return {
    version,
    status: history.length >= lookbackBars && ratio !== null ? 'calculated' : 'provisional',
    asOf: bars.at(-1).date,
    observations: bars.length,
    rankedAgainst: history.length,
    atr: round(atr, 2),
    atrPercent: round(atrPercent, 2),
    percentile: round(percentile, 1),
    ratio: round(ratio, 2),
    state,
    read: state === null
      ? `True range is ${round(atrPercent, 2)}% of price, the ${round(percentile, 1)}th percentile of the last ${history.length} bars.`
      : `True range is ${round(atrPercent, 2)}% of price and ${state} — ${round(ratio, 2)}x its level ${comparisonBars} bars ago, at the ${round(percentile, 1)}th percentile of the last ${history.length} bars.`,
    methodology: `Wilder ATR(${period}) on true ranges, expressed as a share of price so it is comparable across the cycle, ranked against its own last ${lookbackBars} readings and compared with its level ${comparisonBars} bars ago. Percentile and ratio are carried together because a rise from a compressed base and a rise from an already-violent base are different tapes.`,
  };
}

/**
 * Donchian channels on real highs and lows, with the breakout state measured
 * against the channel as it stood before the current bar — comparing today's
 * close to a channel that already contains today's high would make every new
 * high a breakout by construction.
 */
export function calculateDonchianChannels(rows, { periods = [20, 55] } = {}) {
  const version = 'bitcoin-donchian-v1';
  const bars = normalizeBars(rows);
  const longest = Math.max(...periods);
  if (bars.length < longest + 2) {
    return unavailable(version, `Needs ${longest + 2} daily bars with highs and lows; ${bars.length} available.`, { observations: bars.length, channels: [] });
  }
  const close = bars.at(-1).close;
  const channels = periods.map((period) => {
    const prior = bars.slice(-(period + 1), -1);
    const upper = Math.max(...prior.map((bar) => bar.high));
    const lower = Math.min(...prior.map((bar) => bar.low));
    const width = upper - lower;
    return {
      period,
      upper: round(upper, 2),
      lower: round(lower, 2),
      widthPercent: lower > 0 ? round((width / lower) * 100, 2) : null,
      positionPercent: width > 0 ? round(((close - lower) / width) * 100, 1) : 50,
      state: close > upper ? 'breakout up' : close < lower ? 'breakout down' : 'inside',
    };
  });
  const broken = channels.filter((channel) => channel.state !== 'inside');
  return {
    version,
    status: 'calculated',
    asOf: bars.at(-1).date,
    observations: bars.length,
    close: round(close, 2),
    channels,
    read: broken.length
      ? `Price closed ${broken[0].state === 'breakout up' ? 'above' : 'below'} the ${broken[0].period}-bar channel${broken.length > 1 ? ` and the ${broken[1].period}-bar channel` : ''}.`
      : `Price is inside every channel — ${channels.map((channel) => `${channel.positionPercent}% up the ${channel.period}-bar range`).join(', ')}.`,
    methodology: 'Each channel is the highest high and lowest low of the prior N bars, excluding the current one. Excluding it matters: a channel that already contains today\'s high would mark every new high as a breakout.',
  };
}

function completedSetups(bars, { comparisonBars = 4, setupLength = 9 } = {}) {
  const closes = bars.map((bar) => bar.close);
  const setups = [];
  let direction = null;
  let count = 0;
  for (let index = comparisonBars; index < closes.length; index += 1) {
    const isBuy = closes[index] < closes[index - comparisonBars];
    const isSell = closes[index] > closes[index - comparisonBars];
    const bar = isBuy ? 'buy' : isSell ? 'sell' : null;
    if (bar === null || bar !== direction) {
      direction = bar;
      count = bar ? 1 : 0;
    } else {
      count += 1;
    }
    if (count === setupLength) {
      setups.push({ direction, start: index - setupLength + 1, end: index });
    }
  }
  return setups;
}

/**
 * TD Countdown 1-13 with the bar-13 qualifier, setup perfection and the TDST
 * line — the three DeMark pieces that need highs and lows.
 */
export function calculateTdCountdown(rows, { comparisonBars = 4, setupLength = 9, countdownLength = 13 } = {}) {
  const version = 'bitcoin-td-countdown-v1';
  const bars = normalizeBars(rows);
  if (bars.length < comparisonBars + setupLength + 5) {
    return unavailable(version, `Needs ${comparisonBars + setupLength + 5} daily bars with highs and lows; ${bars.length} available.`, { observations: bars.length });
  }
  const setups = completedSetups(bars, { comparisonBars, setupLength });
  const setup = setups.at(-1);
  if (!setup) {
    return {
      version,
      status: 'calculated',
      asOf: bars.at(-1).date,
      observations: bars.length,
      setup: null,
      countdown: null,
      read: 'No TD setup has completed inside the available history, so no countdown is running.',
      methodology: 'A countdown only begins after a nine-bar setup completes, so with no completed setup there is nothing to count.',
    };
  }

  const setupBars = bars.slice(setup.start, setup.end + 1);
  // Perfection: bar 8 or bar 9 must exceed the extremes of bars 6 and 7.
  const [six, seven, eight, nine] = [setupBars[5], setupBars[6], setupBars[7], setupBars[8]];
  const perfected = setup.direction === 'buy'
    ? (eight.low <= Math.min(six.low, seven.low) || nine.low <= Math.min(six.low, seven.low))
    : (eight.high >= Math.max(six.high, seven.high) || nine.high >= Math.max(six.high, seven.high));
  const tdst = setup.direction === 'buy'
    ? Math.max(...setupBars.map((bar) => bar.high))
    : Math.min(...setupBars.map((bar) => bar.low));

  // The countdown always tracks the most recent completed setup, so an opposing
  // setup does not leave a cancelled countdown running alongside this one - it
  // replaces it. What is worth reporting is that a count in the other direction
  // was killed off, which is a real signal about the tape turning.
  const previous = setups.at(-2) ?? null;
  const cancelledPrior = previous && previous.direction !== setup.direction
    ? { direction: previous.direction, completedOn: bars[previous.end].date, cancelledOn: bars[setup.end].date }
    : null;
  const countdownBars = [];
  for (let index = setup.end; index < bars.length && countdownBars.length < countdownLength; index += 1) {
    if (index < 2) continue;
    const qualifies = setup.direction === 'buy'
      ? bars[index].close <= bars[index - 2].low
      : bars[index].close >= bars[index - 2].high;
    if (qualifies) countdownBars.push(index);
  }
  const eighth = countdownBars[7];
  const thirteenth = countdownBars[12];
  const qualifierMet = thirteenth !== undefined && eighth !== undefined
    ? (setup.direction === 'buy' ? bars[thirteenth].close <= bars[eighth].low : bars[thirteenth].close >= bars[eighth].high)
    : null;
  const count = countdownBars.length;
  const closeNow = bars.at(-1).close;
  const tdstBroken = setup.direction === 'buy' ? closeNow > tdst : closeNow < tdst;

  return {
    version,
    status: 'calculated',
    asOf: bars.at(-1).date,
    observations: bars.length,
    setup: {
      direction: setup.direction,
      completedOn: bars[setup.end].date,
      barsSince: bars.length - 1 - setup.end,
      perfected,
    },
    tdst: {
      level: round(tdst, 2),
      side: setup.direction === 'buy' ? 'resistance' : 'support',
      broken: tdstBroken,
    },
    countdown: {
      direction: setup.direction,
      count,
      complete: count >= countdownLength && qualifierMet === true,
      deferred: count >= countdownLength && qualifierMet === false,
      qualifierMet,
      cancelledPrior,
      lastBar: count ? bars[countdownBars[count - 1]].date : null,
    },
    read: (cancelledPrior ? `A ${cancelledPrior.direction} countdown from ${cancelledPrior.completedOn} was cancelled when this setup completed. ` : '')
      + (count >= countdownLength
        ? qualifierMet
          ? `TD ${setup.direction} countdown completed at 13 on ${bars[thirteenth].date}.`
          : `TD ${setup.direction} countdown reached 13 but the bar-13 close did not clear the bar-8 extreme, so it is deferred rather than complete.`
        : `TD ${setup.direction} countdown is at ${count} of ${countdownLength}, from a ${perfected ? 'perfected' : 'plain'} setup that completed on ${bars[setup.end].date}.`),
    methodology: `The countdown starts at the completing bar of the most recent nine-bar setup and counts bars — not necessarily consecutive — whose close is at or below the low two bars earlier for a buy, or at or above the high two bars earlier for a sell. Bar 13 only completes if its close also clears the extreme of countdown bar 8; otherwise it is reported as deferred. A setup is perfected when bar 8 or 9 exceeds the extremes of bars 6 and 7. The TDST line is the extreme of the setup itself. The countdown tracks the most recent completed setup; when an opposing setup completes it replaces the running count, and the countdown it killed off is reported alongside.`,
  };
}

/**
 * On-balance volume and whether it confirms or diverges from price. Volume is
 * exchange-reported and venue-dependent, so the model names its own source
 * rather than implying a consolidated tape.
 */
export function calculateOnBalanceVolume(rows, { window = 60, source = 'the price feed' } = {}) {
  const version = 'bitcoin-obv-v1';
  const bars = normalizeBars(rows).filter((bar) => Number.isFinite(bar.volume));
  if (bars.length < window + 10) {
    return unavailable(version, `Needs ${window + 10} daily bars carrying volume; ${bars.length} available.`, { observations: bars.length });
  }
  let running = 0;
  const obv = bars.map((bar, index) => {
    if (index > 0) {
      const previous = bars[index - 1].close;
      running += bar.close > previous ? bar.volume : bar.close < previous ? -bar.volume : 0;
    }
    return running;
  });
  const slope = (values) => {
    const xMean = (values.length - 1) / 2;
    const yMean = mean(values);
    let covariance = 0;
    let variance = 0;
    values.forEach((value, index) => {
      covariance += (index - xMean) * (value - yMean);
      variance += (index - xMean) ** 2;
    });
    return variance ? covariance / variance : 0;
  };
  const obvWindow = obv.slice(-window);
  const priceWindow = bars.slice(-window).map((bar) => bar.close);
  const obvSlope = slope(obvWindow);
  const priceSlope = slope(priceWindow);
  const obvDirection = obvSlope > 0 ? 'rising' : obvSlope < 0 ? 'falling' : 'flat';
  const priceDirection = priceSlope > 0 ? 'rising' : priceSlope < 0 ? 'falling' : 'flat';
  const agreement = obvDirection === priceDirection ? 'confirming'
    : obvDirection === 'flat' || priceDirection === 'flat' ? 'indecisive'
      : 'diverging';
  return {
    version,
    status: 'calculated',
    asOf: bars.at(-1).date,
    observations: bars.length,
    window,
    obv: Math.round(obv.at(-1)),
    obvDirection,
    priceDirection,
    agreement,
    changePercent: obv.at(-window) ? round(((obv.at(-1) - obv.at(-window)) / Math.abs(obv.at(-window))) * 100, 1) : null,
    read: `Over ${window} bars on-balance volume is ${obvDirection} while price is ${priceDirection} — volume is ${agreement}.`,
    methodology: `On-balance volume adds the day's volume on an up close and subtracts it on a down close. Direction is the ordinary least-squares slope over ${window} bars for both series, so "diverging" means the two fitted trends genuinely point opposite ways rather than reflecting one noisy bar. Volume comes from ${source} and is venue-reported, not a consolidated tape.`,
  };
}

/** Every OHLCV-dependent model in one call. */
export function calculateBitcoinRangeModels(rows, options = {}) {
  const version = 'bitcoin-range-models-v1';
  const bars = normalizeBars(rows);
  const modules = {
    atr: calculateAtrExpansion(bars, options.atr),
    donchian: calculateDonchianChannels(bars, options.donchian),
    tdCountdown: calculateTdCountdown(bars, options.tdCountdown),
    onBalanceVolume: calculateOnBalanceVolume(bars, options.onBalanceVolume),
  };
  const unavailableModules = Object.entries(modules).filter(([, value]) => value.status === 'unavailable').map(([key]) => key);
  const provisionalModules = Object.entries(modules).filter(([, value]) => value.status === 'provisional').map(([key]) => key);
  return {
    version,
    status: unavailableModules.length === Object.keys(modules).length ? 'unavailable'
      : (unavailableModules.length || provisionalModules.length) ? 'provisional' : 'calculated',
    reason: unavailableModules.length === Object.keys(modules).length ? 'No daily bar carrying a high, low and close was available.' : null,
    asOf: bars.length ? bars.at(-1).date : null,
    observations: bars.length,
    withVolume: bars.filter((bar) => Number.isFinite(bar.volume)).length,
    unavailableModules,
    provisionalModules,
    modules,
  };
}
