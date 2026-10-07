import { ordinal, percentileRank, standardDeviation } from './statistics.js';

/**
 * Which equity factors are working, set against six decades of their own
 * history - from Kenneth French's data library, the reference source for
 * academic factor returns, no key.
 *
 * Six long-short factors, each a portfolio of US stocks: the market's excess
 * return, size (small minus big), value (high minus low book-to-market),
 * profitability (robust minus weak), investment (conservative minus
 * aggressive), and momentum (past winners minus past losers). A factor's
 * return is what the tilt earned, not what the market did.
 *
 * Every figure is placed in the factor's own history since 1963, because a
 * number alone means little: value losing 8% in a year is unremarkable in
 * one decade and a historic drawdown in another.
 *
 * Momentum gets one extra reading. Its worst losses are well documented to
 * cluster in a specific setup - a sharp market rebound after a prolonged
 * decline, when the "losers" it is short are the high-beta names that
 * rebound hardest. The conditions are published as conditions, with their
 * thresholds; they are a known hazard, not a forecast.
 *
 * The library publishes monthly with a lag of several weeks, so the data
 * routinely ends one to two months back. The vintage is printed on every
 * reading and the freshness rule allows for that cadence.
 */

const FACTORS = [
  { key: 'Mkt-RF', name: 'Market', description: 'US equities over the T-bill rate' },
  { key: 'SMB', name: 'Size', description: 'small minus big' },
  { key: 'HML', name: 'Value', description: 'cheap minus expensive, by book-to-market' },
  { key: 'RMW', name: 'Profitability', description: 'robust minus weak operating profitability' },
  { key: 'CMA', name: 'Investment', description: 'conservative minus aggressive asset growth' },
  { key: 'Mom', name: 'Momentum', description: 'past-year winners minus losers' },
];

const WINDOWS = [
  { key: 'month', sessions: 21, label: '1M' },
  { key: 'quarter', sessions: 63, label: '3M' },
  { key: 'year', sessions: 252, label: '12M' },
];
const VOL_WINDOW = 63;
const DAY_MS = 86_400_000;
// Monthly publication of data through the prior month-end, released weeks
// later: a two-month-old final observation is the normal top of the cycle.
const MAX_AGE_DAYS = 100;

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * The daily table out of a library CSV: a free-text preamble, a header line
 * whose first cell is blank, YYYYMMDD rows in percent, then a copyright line
 * (and in some files an annual section) - so parsing stops at the first
 * non-row after the rows begin rather than reading on into a second table.
 */
export function parseFrenchDaily(text, requiredColumn) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim());
  const headerIndex = lines.findIndex((line) => line.includes(',') && line.split(',').map((cell) => cell.trim()).includes(requiredColumn));
  if (headerIndex < 0) throw new Error(`No header containing ${requiredColumn}`);
  const header = lines[headerIndex].split(',').map((cell) => cell.trim());
  header[0] = 'date';
  const rows = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (!/^\d{8}\s*,/.test(line)) {
      if (rows.length) break;
      continue;
    }
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length < header.length) continue;
    const date = `${cells[0].slice(0, 4)}-${cells[0].slice(4, 6)}-${cells[0].slice(6, 8)}`;
    const row = { date };
    let valid = true;
    for (let index = 1; index < header.length; index += 1) {
      const value = Number(cells[index]);
      // The library marks missing values -99.99 or -999; neither is a return.
      if (!Number.isFinite(value) || value <= -99.99) { valid = false; break; }
      row[header[index]] = value / 100;
    }
    if (valid) rows.push(row);
  }
  if (!rows.length) throw new Error(`No daily rows under the ${requiredColumn} header`);
  return rows;
}

/** The five-factor and momentum tables joined on date; only dates in both survive. */
export function joinFactorTables(fiveFactor, momentum) {
  const momentumByDate = new Map(momentum.map((row) => [row.date, row.Mom]));
  return fiveFactor.filter((row) => Number.isFinite(momentumByDate.get(row.date))).map((row) => ({ ...row, Mom: momentumByDate.get(row.date) }));
}

function compound(returns) {
  return returns.reduce((growth, value) => growth * (1 + value), 1) - 1;
}

/** Rolling compounded returns over `window`, computed in one pass on log growth. */
function rollingCompound(returns, window) {
  const out = [];
  let logSum = 0;
  for (let index = 0; index < returns.length; index += 1) {
    logSum += Math.log1p(returns[index]);
    if (index >= window) logSum -= Math.log1p(returns[index - window]);
    if (index >= window - 1) out.push(Math.expm1(logSum));
  }
  return out;
}

function rollingVol(returns, window) {
  const out = [];
  let sum = 0;
  let sumSquares = 0;
  for (let index = 0; index < returns.length; index += 1) {
    sum += returns[index];
    sumSquares += returns[index] ** 2;
    if (index >= window) {
      sum -= returns[index - window];
      sumSquares -= returns[index - window] ** 2;
    }
    if (index >= window - 1) {
      const mean = sum / window;
      const variance = Math.max(0, (sumSquares - (window * mean * mean)) / (window - 1));
      out.push(Math.sqrt(variance * 252));
    }
  }
  return out;
}

function drawdownSeries(returns) {
  let level = 1;
  let peak = 1;
  return returns.map((value) => {
    level *= 1 + value;
    peak = Math.max(peak, level);
    return (level / peak) - 1;
  });
}

function correlation(left, right) {
  const n = Math.min(left.length, right.length);
  if (n < 20) return null;
  const a = left.slice(-n);
  const b = right.slice(-n);
  const meanA = a.reduce((total, value) => total + value, 0) / n;
  const meanB = b.reduce((total, value) => total + value, 0) / n;
  let covariance = 0;
  let varA = 0;
  let varB = 0;
  for (let index = 0; index < n; index += 1) {
    covariance += (a[index] - meanA) * (b[index] - meanB);
    varA += (a[index] - meanA) ** 2;
    varB += (b[index] - meanB) ** 2;
  }
  return varA > 0 && varB > 0 ? covariance / Math.sqrt(varA * varB) : null;
}

export function summarizeFactor(rows, factor) {
  const returns = rows.map((row) => row[factor.key]).filter(Number.isFinite);
  if (returns.length < 252 * 5) {
    return { ...factor, status: 'unavailable', reason: `Needs five years of daily returns to place today in its own history; ${returns.length} available.` };
  }
  const windows = Object.fromEntries(WINDOWS.map((window) => [window.key, round(compound(returns.slice(-window.sessions)) * 100)]));
  const yearly = rollingCompound(returns, 252);
  const vols = rollingVol(returns, VOL_WINDOW);
  const drawdowns = drawdownSeries(returns);
  const drawdown = drawdowns.at(-1);
  return {
    ...factor,
    status: 'calculated',
    returns: windows,
    yearPercentile: percentileRank(yearly, yearly.at(-1)),
    drawdownPercent: round(drawdown * 100),
    // Ranked so a high percentile means a deep drawdown: how unusual is it
    // to be this far below the factor's own high.
    drawdownPercentile: percentileRank(drawdowns.map((value) => -value), -drawdown),
    volatilityPercent: round(vols.at(-1) * 100),
    volatilityPercentile: percentileRank(vols, vols.at(-1)),
    longRunAnnualPercent: round((((1 + compound(returns)) ** (252 / returns.length)) - 1) * 100),
    longRunVolatilityPercent: round(standardDeviation(returns) * Math.sqrt(252) * 100),
  };
}

/**
 * The setup in which momentum has historically suffered its worst losses: a
 * market that is still down over two years and has just rallied hard.
 * Published as the two conditions and whether both hold.
 */
export function momentumCrashConditions(rows) {
  const market = rows.map((row) => row['Mkt-RF'] + (row.RF ?? 0)).filter(Number.isFinite);
  if (market.length < 504) return { status: 'unavailable', reason: 'Needs two years of market returns.' };
  const twoYear = compound(market.slice(-504)) * 100;
  const month = compound(market.slice(-21)) * 100;
  const bearBackdrop = twoYear < 0;
  const sharpRebound = month >= 8;
  return {
    status: 'calculated',
    marketTwoYearPercent: round(twoYear),
    marketOneMonthPercent: round(month),
    bearBackdrop,
    sharpRebound,
    elevated: bearBackdrop && sharpRebound,
    rule: 'Both conditions: the market’s two-year total return is negative, and its one-month return is at least +8%.',
  };
}

const ordinalText = (value) => (Number.isFinite(value) ? ordinal(value) : 'unranked');

function describe(factors, crash) {
  const ranked = factors.filter((factor) => factor.status === 'calculated' && factor.key !== 'Mkt-RF' && Number.isFinite(factor.returns.year));
  if (ranked.length < 3) return null;
  const sorted = [...ranked].sort((left, right) => right.returns.year - left.returns.year);
  const best = sorted[0];
  const worst = sorted.at(-1);
  const parts = [`Over the past year ${best.name.toLowerCase()} led the style factors at ${best.returns.year > 0 ? '+' : ''}${best.returns.year}% (${ordinalText(best.yearPercentile)} percentile of its 12-month history) and ${worst.name.toLowerCase()} trailed at ${worst.returns.year > 0 ? '+' : ''}${worst.returns.year}% (${ordinalText(worst.yearPercentile)})`];
  const deep = ranked.filter((factor) => factor.drawdownPercentile >= 90);
  if (deep.length) parts.push(`${deep.map((factor) => factor.name.toLowerCase()).join(' and ')} ${deep.length === 1 ? 'is' : 'are'} in ${deep.length === 1 ? 'a drawdown' : 'drawdowns'} deeper than 90% of ${deep.length === 1 ? 'its' : 'their'} history`);
  if (crash?.elevated) parts.push('the setup in which momentum has historically suffered its worst losses is present: a sharp market rebound after a two-year decline');
  const text = parts.join('; ');
  return `${text}.`;
}

export function calculateFactorReturns(rows, { now = Date.now(), missing = {} } = {}) {
  const sorted = [...(rows ?? [])].sort((left, right) => left.date.localeCompare(right.date));
  if (sorted.length < 252 * 5) {
    return { version: 'factor-returns-v1', status: 'unavailable', reason: `Needs five years of joined daily factor returns; ${sorted.length} available.`, factors: [] };
  }
  // A factor whose source file failed says so, rather than reporting the
  // empty column as a short history.
  const factors = FACTORS.map((factor) => (missing[factor.key] ? { ...factor, status: 'unavailable', reason: missing[factor.key] } : summarizeFactor(sorted, factor)));
  const recent = sorted.slice(-VOL_WINDOW);
  const pick = (key) => recent.map((row) => row[key]);
  const asOf = sorted.at(-1).date;
  const ageDays = Math.floor((now - Date.parse(`${asOf}T00:00:00Z`)) / DAY_MS);
  const crash = momentumCrashConditions(sorted);
  const published = factors.filter((factor) => factor.status === 'calculated');
  const stale = ageDays > MAX_AGE_DAYS;
  return {
    version: 'factor-returns-v1',
    status: stale || published.length < factors.length ? 'provisional' : 'calculated',
    asOf,
    ageDays,
    stale,
    from: sorted[0].date,
    observations: sorted.length,
    factors,
    correlations: {
      // Value and momentum are usually negatively correlated, which is why
      // they are held together; when that breaks down, the diversification
      // the pair is relied on for is not there.
      valueMomentum: round(correlation(pick('HML'), pick('Mom')), 2),
      marketMomentum: round(correlation(pick('Mkt-RF'), pick('Mom')), 2),
      window: `${VOL_WINDOW} sessions`,
    },
    momentumCrash: crash,
    read: describe(factors, crash),
    freshness: stale
      ? `The library's latest observation is ${ageDays} days old, past the ${MAX_AGE_DAYS}-day allowance for its monthly release cycle.`
      : `Data through ${asOf} (${ageDays} days old); the library publishes monthly with a lag of several weeks.`,
    methodology: 'Daily long-short factor returns from the Kenneth R. French Data Library (Fama-French five factors plus momentum, US equities, since 1963). Returns are compounded over 21, 63 and 252 sessions. The 12-month return, the drawdown from the factor’s own high, and 63-session volatility are each ranked against the factor’s full history.',
    limits: 'These are academic long-short portfolios, rebalanced on the library’s rules and before costs; no fund earns them exactly. US equities only. The data lags by weeks, so this describes the regime that has been, not the one this week.',
  };
}

export { FACTORS, MAX_AGE_DAYS as FACTOR_MAX_AGE_DAYS };
