/**
 * Is diversification working right now, and has the reading meant anything?
 *
 * Two measures of how much a multi-asset portfolio is really spread:
 *
 *   stock-bond   the 63- and 252-session correlation of S&P 500 (SPY) and
 *                7-10 year Treasury (IEF) daily returns. Negative, bonds rally
 *                when stocks fall and a 60/40 portfolio cushions itself;
 *                positive, the two fall together, as in 2022.
 *   breadth      the effective number of independent bets among six asset
 *                classes - U.S., developed and emerging equities, Treasuries,
 *                gold and commodities - over 63 sessions: N² over the sum of
 *                squared pairwise correlations, six if unrelated, one if they
 *                move as one.
 *
 * The claim behind the stock-bond reading is that a negative correlation
 * protects a 60/40 portfolio. That is tested on what followed: every week,
 * the regime as it stood that day, then the 60/40 portfolio's worst
 * drawdown over the next 30 and 90 days, through the shared track-record
 * evaluator (held-out newest 30%, effective sample size, ordering).
 */

import { evaluateTrackRecord } from './trackRecord.js';
import { ordinal, percentileRank } from './statistics.js';

export const DIVERSIFICATION_VERSION = 'diversification-regime-v1';
export const DIVERSIFICATION_ASSETS = [
  { symbol: 'SPY', name: 'U.S. equities' },
  { symbol: 'EFA', name: 'Developed equities' },
  { symbol: 'EEM', name: 'Emerging equities' },
  { symbol: 'IEF', name: '7-10y Treasuries' },
  { symbol: 'GLD', name: 'Gold' },
  { symbol: 'DBC', name: 'Commodities' },
];
export const STOCK_BOND_STATES = [
  { key: 'negative', label: 'Bonds hedging (below -0.2)' },
  { key: 'neutral', label: 'Unlinked (-0.2 to 0.2)' },
  { key: 'positive', label: 'Falling together (above 0.2)' },
];
const SHORT_WINDOW = 63;
const LONG_WINDOW = 252;
const STEP_SESSIONS = 5;
const HORIZONS = [{ days: 30, sessions: 21 }, { days: 90, sessions: 63 }];
const MINIMUM_SESSIONS = LONG_WINDOW * 3;

function round(value, digits = 2) {
  return Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
}

function correlation(left, right) {
  const n = left.length;
  let sumLeft = 0; let sumRight = 0;
  for (let index = 0; index < n; index += 1) { sumLeft += left[index]; sumRight += right[index]; }
  const meanLeft = sumLeft / n;
  const meanRight = sumRight / n;
  let cov = 0; let varLeft = 0; let varRight = 0;
  for (let index = 0; index < n; index += 1) {
    cov += (left[index] - meanLeft) * (right[index] - meanRight);
    varLeft += (left[index] - meanLeft) ** 2;
    varRight += (right[index] - meanRight) ** 2;
  }
  return varLeft > 0 && varRight > 0 ? cov / Math.sqrt(varLeft * varRight) : 0;
}

export function stockBondState(value) {
  if (!Number.isFinite(value)) return null;
  return value < -0.2 ? 'negative' : value > 0.2 ? 'positive' : 'neutral';
}

/** Worst peak-to-trough fall, in percent, of `levels` from index `from` through `to`, starting at the level on `from`. */
export function forwardDrawdown(levels, from, to) {
  let peak = levels[from];
  let worst = 0;
  for (let index = from + 1; index <= to; index += 1) {
    peak = Math.max(peak, levels[index]);
    worst = Math.min(worst, levels[index] / peak - 1);
  }
  return worst * 100;
}

/**
 * @param {{ histories: Map<string, Array<{date: string, value: number}>> }} input
 */
export function calculateDiversificationRegime({ histories }) {
  const version = DIVERSIFICATION_VERSION;
  const symbols = DIVERSIFICATION_ASSETS.map((asset) => asset.symbol);
  const missing = symbols.filter((symbol) => !histories.get(symbol)?.length);
  if (missing.length) return { version, status: 'unavailable', reason: `No history for ${missing.join(', ')}.` };
  const maps = new Map(symbols.map((symbol) => [symbol, new Map(histories.get(symbol).filter((point) => point.value > 0).map((point) => [point.date, point.value]))]));
  const axis = [...maps.get('SPY').keys()].filter((date) => symbols.every((symbol) => maps.get(symbol).has(date))).sort();
  if (axis.length - 1 < MINIMUM_SESSIONS) {
    return { version, status: 'unavailable', reason: `The six assets share ${Math.max(0, axis.length - 1)} sessions; ${MINIMUM_SESSIONS} are needed.` };
  }
  const dates = axis.slice(1);
  const returns = new Map(symbols.map((symbol) => [symbol, dates.map((date, index) => maps.get(symbol).get(date) / maps.get(symbol).get(axis[index]) - 1)]));
  const spy = returns.get('SPY');
  const ief = returns.get('IEF');

  // A 60/40 portfolio rebalanced daily, as a level series on `dates`.
  const balanced = [1];
  for (let index = 0; index < dates.length; index += 1) balanced.push(balanced.at(-1) * (1 + 0.6 * spy[index] + 0.4 * ief[index]));
  balanced.shift();

  const window = (values, end, size) => values.slice(end + 1 - size, end + 1);
  const rows = dates.map((date, index) => {
    if (index + 1 < SHORT_WINDOW) return null;
    const stockBond = correlation(window(spy, index, SHORT_WINDOW), window(ief, index, SHORT_WINDOW));
    let sumSquared = 0;
    for (const left of symbols) for (const right of symbols) {
      const value = left === right ? 1 : correlation(window(returns.get(left), index, SHORT_WINDOW), window(returns.get(right), index, SHORT_WINDOW));
      sumSquared += value * value;
    }
    const stockBondLong = index + 1 >= LONG_WINDOW ? correlation(window(spy, index, LONG_WINDOW), window(ief, index, LONG_WINDOW)) : null;
    return { date, index, stockBond, stockBondLong, effectiveBets: (symbols.length ** 2) / sumSquared, state: stockBondState(stockBond) };
  });
  const usable = rows.filter(Boolean);

  const observations = [];
  for (let index = SHORT_WINDOW - 1; index < dates.length; index += STEP_SESSIONS) {
    const row = rows[index];
    const forward = {};
    for (const horizon of HORIZONS) forward[horizon.days] = index + horizon.sessions < dates.length ? forwardDrawdown(balanced, index, index + horizon.sessions) : null;
    observations.push({ date: row.date, label: row.state, returns: forward });
  }
  const record = evaluateTrackRecord({ observations, order: STOCK_BOND_STATES, horizons: HORIZONS, stepDays: Math.round(STEP_SESSIONS * 365 / 252) });

  const latest = usable.at(-1);
  let runStart = usable.length - 1;
  while (runStart > 0 && usable[runStart - 1].state === latest.state) runStart -= 1;
  let peak = 0;
  for (const level of balanced) peak = Math.max(peak, level);

  const result = {
    version,
    status: 'calculated',
    date: latest.date,
    from: usable[0].date,
    sessions: dates.length,
    stockBond: {
      short: round(latest.stockBond),
      long: round(latest.stockBondLong),
      percentile: percentileRank(usable.map((row) => row.stockBond), latest.stockBond),
      state: latest.state,
      stateLabel: STOCK_BOND_STATES.find((state) => state.key === latest.state).label,
      since: usable[runStart].date,
    },
    effectiveBets: {
      now: round(latest.effectiveBets, 1),
      of: symbols.length,
      percentile: percentileRank(usable.map((row) => row.effectiveBets), latest.effectiveBets),
      median: round([...usable.map((row) => row.effectiveBets)].sort((left, right) => left - right)[Math.floor(usable.length / 2)], 1),
    },
    balancedDrawdownPercent: round((balanced.at(-1) / peak - 1) * 100, 1),
    assets: DIVERSIFICATION_ASSETS,
    windows: { short: SHORT_WINDOW, long: LONG_WINDOW },
    record: record.status === 'calculated' ? { ...record, readHorizonDays: 90, limits: 'Descriptive, not predictive. One portfolio over one decade, which holds a single shift from bonds hedging to falling with stocks.' } : record,
    history: usable.filter((_row, index) => (usable.length - 1 - index) % 5 === 0).map((row) => ({ date: row.date, stockBond: round(row.stockBond), effectiveBets: round(row.effectiveBets, 2) })),
  };
  return {
    ...result,
    read: describeDiversification(result),
    methodology: `Daily returns on the sessions all six ETFs (${symbols.join(', ')}) share. Stock-bond is the correlation of SPY and IEF over ${SHORT_WINDOW} and ${LONG_WINDOW} sessions. Effective bets is N² over the sum of squared pairwise correlations of the six over ${SHORT_WINDOW} sessions. The 60/40 portfolio is 60% SPY and 40% IEF, rebalanced daily. Track record: each week classified by the ${SHORT_WINDOW}-session stock-bond correlation as it stood, followed by the 60/40 portfolio’s worst drawdown over the next 30 and 90 days.`,
    limits: 'ETF histories cover one or two decades - mostly an era of negative stock-bond correlation until 2022 - so the positive regime rests on few independent episodes. Drawdowns are before costs, and the 60/40 here holds intermediate Treasuries; longer bonds move more. Correlations change fastest in exactly the sell-offs the hedge is for.',
  };
}

function stateCell(record, key) {
  const horizon = record?.horizons?.find((entry) => entry.days === 90);
  return horizon?.states.find((state) => state.key === key) ?? null;
}

function describeDiversification(result) {
  const { stockBond, effectiveBets } = result;
  const verb = { negative: 'bonds have been hedging stocks', neutral: 'stocks and bonds have moved independently', positive: 'stocks and bonds have been falling and rising together' }[stockBond.state];
  const parts = [`Since ${stockBond.since}, ${verb}: the ${result.windows.short}-session correlation is ${stockBond.short} (${stockBond.long} over a year), the ${ordinal(stockBond.percentile)} percentile since ${result.from.slice(0, 4)}`];
  parts.push(`the six asset classes behave like ${effectiveBets.now} independent bets against a median of ${effectiveBets.median}`);
  let record = '';
  if (result.record.status === 'calculated') {
    const negative = stateCell(result.record, 'negative');
    const positive = stateCell(result.record, 'positive');
    if (Number.isFinite(negative?.development.stats.median) && Number.isFinite(positive?.development.stats.median)) {
      record = ` Before ${result.record.holdoutFrom}, the 60/40 portfolio’s median worst fall over the next 90 days was ${negative.development.stats.median}% when bonds were hedging and ${positive.development.stats.median}% when they moved with stocks`;
      if (Number.isFinite(negative.heldOut.stats.median) && Number.isFinite(positive.heldOut.stats.median)) record += `; since then, ${negative.heldOut.stats.median}% and ${positive.heldOut.stats.median}%`;
      else record += `; since then, too few independent weeks of ${Number.isFinite(negative.heldOut.stats.median) ? 'stocks and bonds falling together' : 'bonds hedging'} to compare`;
      record += '.';
    }
  }
  return `${parts.join('; ')}.${record}`;
}
