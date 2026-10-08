/**
 * What a watchlist holds as a portfolio: how many independent bets it really
 * is, which positions move together, and where its risk comes from.
 *
 * A list of eight names can be one bet. The effective number of independent
 * bets is N^2 divided by the sum of all squared pairwise correlations - the
 * participation ratio of the correlation matrix's eigenvalues, without
 * needing the eigenvalues: eight uncorrelated names score eight, eight that
 * move as one score one. Risk shares are each position's contribution to the
 * variance of an equal-weighted list, so a quiet name and a volatile one held
 * in the same amount are not mistaken for the same exposure.
 *
 * Everything is measured on the benchmark's trading days over the last year,
 * on the dates every symbol shares; a crypto asset's weekend moves fold into
 * the next session, as an equity's overnight news does.
 */

export const PORTFOLIO_RISK_VERSION = 'portfolio-risk-v1';
const MINIMUM_SHARED_SESSIONS = 120;

function round(value, digits = 2) {
  return Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function covariance(left, right) {
  const leftMean = mean(left);
  const rightMean = mean(right);
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += (left[index] - leftMean) * (right[index] - rightMean);
  return total / (left.length - 1);
}

function maxDrawdown(levels) {
  let peak = -Infinity;
  let worst = 0;
  for (const level of levels) {
    peak = Math.max(peak, level);
    worst = Math.min(worst, level / peak - 1);
  }
  return worst;
}

/**
 * @param {{ histories: Map<string, Array<{date: string, value: number}>>, benchmark: Array<{date: string, value: number}>, window?: number, annualization?: number }} input
 */
export function calculatePortfolioRisk({ histories, benchmark, window = 252, annualization = 252 }) {
  const version = PORTFOLIO_RISK_VERSION;
  const symbols = [...histories.keys()];
  if (symbols.length < 2) return { version, status: 'unavailable', reason: 'A portfolio reading needs at least two symbols with a year of closes.', missing: [] };
  const byDate = (points) => new Map((points ?? []).filter((point) => point.value > 0).map((point) => [point.date, point.value]));
  const benchmarkByDate = byDate(benchmark);
  const maps = new Map(symbols.map((symbol) => [symbol, byDate(histories.get(symbol))]));
  const shared = [...benchmarkByDate.keys()].sort().filter((date) => symbols.every((symbol) => maps.get(symbol).has(date))).slice(-(window + 1));
  if (shared.length - 1 < MINIMUM_SHARED_SESSIONS) {
    return { version, status: 'unavailable', reason: `The symbols share ${Math.max(0, shared.length - 1)} sessions of history with the benchmark; ${MINIMUM_SHARED_SESSIONS} are needed.`, missing: [] };
  }
  const returnsOf = (map) => shared.slice(1).map((date, index) => map.get(date) / map.get(shared[index]) - 1);
  const benchmarkReturns = returnsOf(benchmarkByDate);
  const benchmarkVariance = covariance(benchmarkReturns, benchmarkReturns);
  const series = new Map(symbols.map((symbol) => [symbol, returnsOf(maps.get(symbol))]));

  const n = symbols.length;
  const cov = symbols.map((left) => symbols.map((right) => covariance(series.get(left), series.get(right))));
  const vol = symbols.map((_symbol, index) => Math.sqrt(cov[index][index]));
  const corr = cov.map((row, i) => row.map((value, j) => (vol[i] > 0 && vol[j] > 0 ? value / (vol[i] * vol[j]) : 0)));
  const sumSquared = corr.reduce((total, row) => total + row.reduce((inner, value) => inner + value * value, 0), 0);
  const effectiveBets = (n * n) / sumSquared;

  // Equal weights: each position's share of the list's variance.
  const weight = 1 / n;
  const portfolioVariance = cov.reduce((total, row) => total + row.reduce((inner, value) => inner + weight * weight * value, 0), 0);
  const contributions = symbols.map((_symbol, i) => weight * cov[i].reduce((total, value) => total + weight * value, 0) / portfolioVariance);
  const portfolioReturns = benchmarkReturns.map((_unused, day) => symbols.reduce((total, symbol) => total + weight * series.get(symbol)[day], 0));
  const portfolioLevels = portfolioReturns.reduce((levels, value) => [...levels, levels.at(-1) * (1 + value)], [1]);
  const weightedVol = vol.reduce((total, value) => total + weight * value, 0);

  const positions = symbols.map((symbol, i) => {
    const returns = series.get(symbol);
    const levels = returns.reduce((acc, value) => [...acc, acc.at(-1) * (1 + value)], [1]);
    return {
      symbol,
      volatilityPercent: round(vol[i] * Math.sqrt(annualization) * 100, 1),
      beta: round(covariance(returns, benchmarkReturns) / benchmarkVariance),
      correlationToBenchmark: round(covariance(returns, benchmarkReturns) / Math.sqrt(cov[i][i] * benchmarkVariance)),
      returnPercent: round((levels.at(-1) - 1) * 100, 1),
      maxDrawdownPercent: round(maxDrawdown(levels) * 100, 1),
      riskSharePercent: round(contributions[i] * 100, 1),
    };
  }).sort((left, right) => right.riskSharePercent - left.riskSharePercent);

  const pairs = [];
  for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) pairs.push({ left: symbols[i], right: symbols[j], correlation: round(corr[i][j]) });
  pairs.sort((left, right) => right.correlation - left.correlation);
  const portfolioBeta = covariance(portfolioReturns, benchmarkReturns) / benchmarkVariance;
  const summary = {
    positions: n,
    effectiveBets: round(effectiveBets, 1),
    volatilityPercent: round(Math.sqrt(portfolioVariance) * Math.sqrt(annualization) * 100, 1),
    diversificationRatio: round(weightedVol / Math.sqrt(portfolioVariance)),
    beta: round(portfolioBeta),
    returnPercent: round((portfolioLevels.at(-1) - 1) * 100, 1),
    maxDrawdownPercent: round(maxDrawdown(portfolioLevels) * 100, 1),
    averageCorrelation: round(pairs.reduce((total, pair) => total + pair.correlation, 0) / pairs.length),
  };
  return {
    version,
    status: 'calculated',
    from: shared[0],
    to: shared.at(-1),
    sessions: shared.length - 1,
    summary,
    positions,
    mostAlike: pairs.slice(0, 3),
    leastAlike: pairs.slice(-3).reverse(),
    read: describePortfolio(summary, positions, pairs),
    methodology: `Daily returns over the last ${shared.length - 1} sessions the symbols share with SPY, equal-weighted. Effective independent bets is N² over the sum of squared pairwise correlations (the participation ratio of the correlation matrix). A position’s risk share is its contribution to the equal-weighted list’s variance; shares sum to 100%. Beta and correlation are against SPY. Volatility is annualized over ${annualization} sessions.`,
    limits: 'Equal weights, not your actual position sizes. One year of daily data: correlations rise in sell-offs, so a list that looks diversified in a calm year can behave as one bet in a crash. Crypto weekends fold into Monday’s return.',
  };
}

function describePortfolio(summary, positions, pairs) {
  const parts = [`These ${summary.positions} symbols behave like ${summary.effectiveBets} independent ${summary.effectiveBets === 1 ? 'bet' : 'bets'}`];
  const top = pairs[0];
  if (top && top.correlation >= 0.6) parts.push(`${top.left} and ${top.right} move most alike (correlation ${top.correlation})`);
  const heavy = positions.filter((position) => position.riskSharePercent >= (100 / summary.positions) * 1.5);
  if (heavy.length) parts.push(`${heavy.map((position) => `${position.symbol} carries ${position.riskSharePercent}% of the risk`).join(', ')} at an equal weight of ${Math.round(100 / summary.positions)}%`);
  parts.push(`held equally, the list ran ${summary.volatilityPercent}% volatility with a beta of ${summary.beta} to the S&P 500 and a worst drawdown of ${summary.maxDrawdownPercent}% over the year`);
  const text = parts.join('; ');
  return `${text}.`;
}

/** Watchlist symbols to the tickers Yahoo knows them by. */
export function yahooTickerFor(symbol) {
  const upper = String(symbol ?? '').toUpperCase();
  const mapped = { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XAU: 'GC=F', XAG: 'SI=F', XPT: 'PL=F', XPD: 'PA=F', DXY: 'DX-Y.NYB' };
  return mapped[upper] ?? upper.replace(/\./g, '-');
}
