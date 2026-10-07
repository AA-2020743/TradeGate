/**
 * S&P 500 valuation from Shiller's monthly data, back to 1871.
 *
 * CAPE (price over ten years of inflation-adjusted earnings) is computed here
 * from the raw price, earnings and CPI columns rather than read from the
 * file: the derived columns have moved and been renamed between editions, and
 * a model that reads "column M" would quietly read the wrong thing the day
 * they move again. The raw columns have kept their one-letter headers for
 * decades and are found by name.
 *
 * Three readings, in order of how much they claim:
 *
 *   where   - today's CAPE against its own history, since 1871 and since
 *             1950 (accounting and payout changes make the early decades a
 *             different market; both are shown rather than one chosen).
 *   versus  - the excess CAPE yield: the earnings yield 1/CAPE less the real
 *             10-year rate. A high CAPE with very low real rates is a
 *             different proposition from the same CAPE at 4% real.
 *   then    - what the following ten years of real total return were when
 *             the excess yield stood where it stands now. Ten-year windows
 *             overlap month to month, so 150 years hold only about 15
 *             independent decades; the fit is tested out of sample (fit on
 *             windows that started before 1981, scored on those that started
 *             after 1990) and reported against the naive guess of the
 *             historical average.
 */

export const INDEX_VALUATION_VERSION = 'index-valuation-v1';
const WINDOW_MONTHS = 120;
const MAX_EARNINGS_LAG_MONTHS = 9;

function header(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Finds the monthly table in a sheet's rows by its headers and reads it.
 * @param {Array<Array<unknown>>} rows
 * @returns {{ status: string, reason?: string, months?: Array<{ key: string, year: number, month: number, price: number|null, dividend: number|null, earnings: number|null, cpi: number|null, gs10: number|null }> }}
 */
export function parseShillerRows(rows) {
  for (let index = 0; index < Math.min(rows.length, 40); index += 1) {
    const cells = (rows[index] ?? []).map(header);
    const find = (test) => cells.findIndex(test);
    const columns = {
      date: find((cell) => cell === 'date'),
      price: find((cell) => cell === 'p'),
      dividend: find((cell) => cell === 'd'),
      earnings: find((cell) => cell === 'e'),
      cpi: find((cell) => cell === 'cpi'),
      gs10: find((cell) => cell.includes('gs10')),
    };
    if ([columns.date, columns.price, columns.earnings, columns.cpi].some((column) => column < 0)) continue;
    const months = [];
    for (const row of rows.slice(index + 1)) {
      const stamp = row?.[columns.date];
      if (typeof stamp !== 'number' || stamp < 1800 || stamp > 2200) continue;
      const year = Math.floor(stamp);
      const month = Math.round((stamp - year) * 100);
      if (month < 1 || month > 12) continue;
      const number = (column) => (column >= 0 && typeof row[column] === 'number' && Number.isFinite(row[column]) ? row[column] : null);
      const positive = (column) => { const value = number(column); return value !== null && value > 0 ? value : null; };
      months.push({
        key: `${year}-${String(month).padStart(2, '0')}`,
        year,
        month,
        price: positive(columns.price),
        dividend: positive(columns.dividend),
        earnings: number(columns.earnings),
        cpi: positive(columns.cpi),
        gs10: number(columns.gs10),
      });
    }
    months.sort((left, right) => left.key.localeCompare(right.key));
    const unique = months.filter((entry, position) => position === 0 || entry.key !== months[position - 1].key);
    if (unique.length < 24) return { status: 'unavailable', reason: `Found the table headers but only ${unique.length} dated months beneath them.` };
    return { status: 'ready', months: unique, columns };
  }
  return { status: 'unavailable', reason: 'No row carries the Date, P, E and CPI headers of Shiller’s monthly table.' };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentileOf(value, values) {
  if (!values.length || !Number.isFinite(value)) return null;
  const below = values.filter((entry) => entry < value).length;
  const equal = values.filter((entry) => entry === value).length;
  return Math.round(((below + equal / 2) / values.length) * 100);
}

function round(value, places = 2) {
  return Number.isFinite(value) ? Math.round(value * 10 ** places) / 10 ** places : null;
}

function fit(points) {
  const n = points.length;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / n;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const { x, y } of points) {
    sxx += (x - meanX) ** 2;
    sxy += (x - meanX) * (y - meanY);
    syy += (y - meanY) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = meanY - slope * meanX;
  const residuals = points.map(({ x, y }) => y - (intercept + slope * x));
  const rmse = Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / n);
  return { slope, intercept, rSquared: syy > 0 ? 1 - residuals.reduce((sum, value) => sum + value * value, 0) / syy : 0, rmse, meanY };
}

/**
 * @param {Array} months  From parseShillerRows.
 * @param {{ realYield10y?: number|null, realYieldDate?: string|null }} [options]  The current 10-year TIPS yield, when known.
 */
export function calculateIndexValuation(months, { realYield10y = null, realYieldDate = null } = {}) {
  const version = INDEX_VALUATION_VERSION;
  const usable = (months ?? []).filter((entry) => entry.price !== null && entry.cpi !== null);
  if (usable.length < WINDOW_MONTHS + 12) {
    return { version, status: 'unavailable', reason: `Needs more than ten years of monthly prices and CPI; ${usable.length} months available.` };
  }
  const latestCpi = usable.at(-1).cpi;
  const series = usable.map((entry) => ({ ...entry, realPrice: entry.price * (latestCpi / entry.cpi), realEarnings: entry.earnings === null ? null : entry.earnings * (latestCpi / entry.cpi) }));

  // CAPE at each month from the 120 most recent months of earnings published
  // by then. Earnings arrive two or three quarters late, so the latest prices
  // are set against a window ending at the last reported month.
  let lastEarningsIndex = -1;
  for (let index = 0; index < series.length; index += 1) {
    if (series[index].realEarnings !== null) lastEarningsIndex = index;
    const end = lastEarningsIndex;
    if (end < WINDOW_MONTHS - 1 || index - end > MAX_EARNINGS_LAG_MONTHS) continue;
    const window = series.slice(end - WINDOW_MONTHS + 1, end + 1);
    if (window.some((entry) => entry.realEarnings === null)) continue;
    const average = window.reduce((sum, entry) => sum + entry.realEarnings, 0) / WINDOW_MONTHS;
    if (average > 0) {
      series[index].cape = series[index].realPrice / average;
      series[index].earningsThrough = series[end].key;
    }
  }

  // Real total return: price plus a twelfth of the annual dividend each
  // month, deflated. A dividend not yet reported carries the last one for up
  // to six months rather than counting as zero.
  let lastDividend = null;
  let lastDividendIndex = -Infinity;
  series[0].realTotalReturn = 1;
  for (let index = 1; index < series.length; index += 1) {
    if (series[index].dividend !== null) {
      lastDividend = series[index].dividend;
      lastDividendIndex = index;
    }
    const dividend = index - lastDividendIndex <= 6 ? lastDividend ?? 0 : 0;
    const nominal = (series[index].price + dividend / 12) / series[index - 1].price;
    const inflation = series[index].cpi / series[index - 1].cpi;
    series[index].realTotalReturn = series[index - 1].realTotalReturn * (nominal / inflation);
  }

  // The real rate in the excess-yield history: the 10-year yield less the
  // trailing ten-year inflation rate, as Shiller defines it.
  for (let index = WINDOW_MONTHS; index < series.length; index += 1) {
    const entry = series[index];
    if (!Number.isFinite(entry.cape) || entry.gs10 === null) continue;
    const inflation = ((entry.cpi / series[index - WINDOW_MONTHS].cpi) ** (1 / 10) - 1) * 100;
    entry.realRate = entry.gs10 - inflation;
    entry.excessYield = 100 / entry.cape - entry.realRate;
  }
  for (let index = 0; index + WINDOW_MONTHS < series.length; index += 1) {
    series[index].forwardRealReturn = ((series[index + WINDOW_MONTHS].realTotalReturn / series[index].realTotalReturn) ** (1 / 10) - 1) * 100;
  }

  const withCape = series.filter((entry) => Number.isFinite(entry.cape));
  const current = withCape.at(-1);
  if (!current) return { version, status: 'unavailable', reason: 'No month has ten continuous years of earnings behind it.' };
  const capes = withCape.map((entry) => entry.cape);
  const modern = withCape.filter((entry) => entry.year >= 1950).map((entry) => entry.cape);
  const historyYears = round(withCape.length / 12, 0);

  // The history defines the real rate as the 10-year yield less trailing
  // inflation, so today's reading is ranked and projected on that same
  // definition. The TIPS yield is a different quantity - a market real rate,
  // not a backward-looking one - and is shown beside it, never ranked against
  // a history it is not part of. It stands in only when the file carries no
  // current 10-year yield, and the read says the definitions are then mixed.
  const shillerBasis = Number.isFinite(current.realRate);
  const currentRealRate = shillerBasis ? current.realRate : Number.isFinite(realYield10y) ? realYield10y : null;
  const realRateSource = shillerBasis ? '10-year Treasury yield less trailing ten-year inflation' : Number.isFinite(realYield10y) ? `10-year TIPS yield on ${realYieldDate ?? 'the latest date'}` : null;
  const currentExcessYield = Number.isFinite(currentRealRate) ? 100 / current.cape - currentRealRate : null;
  const tipsExcessYield = Number.isFinite(realYield10y) ? 100 / current.cape - realYield10y : null;
  const excessHistory = series.filter((entry) => Number.isFinite(entry.excessYield));

  // The excess yield against what followed.
  const paired = series.filter((entry) => Number.isFinite(entry.excessYield) && Number.isFinite(entry.forwardRealReturn)).map((entry) => ({ x: entry.excessYield, y: entry.forwardRealReturn, year: entry.year, key: entry.key }));
  let outlook = { status: 'unavailable', reason: `Needs 30 years of ten-year outcomes; ${round(paired.length / 12, 0)} available.` };
  if (paired.length >= 360 && Number.isFinite(currentExcessYield)) {
    const model = fit(paired);
    const independent = Math.floor(paired.length / WINDOW_MONTHS);
    const implied = model.intercept + model.slope * currentExcessYield;
    // Out of sample: fitted only on windows finished by 1990, scored on
    // windows that began after, against guessing the training average.
    const train = paired.filter((point) => point.year <= 1980);
    const testSet = paired.filter((point) => point.year >= 1991);
    let outOfSample = { status: 'unavailable', reason: 'Needs ten-year outcomes both before 1981 and after 1990.' };
    if (train.length >= 240 && testSet.length >= 60) {
      const trained = fit(train);
      const error = (predict) => Math.sqrt(testSet.reduce((sum, point) => sum + (point.y - predict(point.x)) ** 2, 0) / testSet.length);
      const modelError = error((x) => trained.intercept + trained.slope * x);
      const naiveError = error(() => trained.meanY);
      outOfSample = {
        status: 'calculated',
        trainedThrough: '1980',
        testedFrom: '1991',
        testedMonths: testSet.length,
        modelErrorPoints: round(modelError),
        naiveErrorPoints: round(naiveError),
        beatsNaive: modelError < naiveError,
      };
    }
    // The same evidence without a line: what followed each fifth of the
    // excess-yield history, and which fifth today sits in.
    const sorted = [...paired].sort((left, right) => left.x - right.x);
    const cuts = [1, 2, 3, 4].map((k) => sorted[Math.floor((k * sorted.length) / 5)].x);
    const currentQuintile = cuts.filter((cut) => currentExcessYield >= cut).length;
    const buckets = [0, 1, 2, 3, 4].map((quintile) => {
      const slice = sorted.slice(Math.floor((quintile * sorted.length) / 5), Math.floor(((quintile + 1) * sorted.length) / 5));
      return {
        quintile: quintile + 1,
        fromExcessYield: round(slice[0].x),
        toExcessYield: round(slice.at(-1).x),
        medianForwardReturn: round(median(slice.map((point) => point.y))),
        worstForwardReturn: round(Math.min(...slice.map((point) => point.y))),
        bestForwardReturn: round(Math.max(...slice.map((point) => point.y))),
        months: slice.length,
        current: quintile === currentQuintile,
      };
    });
    outlook = {
      status: independent >= 10 ? 'calculated' : 'provisional',
      impliedRealReturn: round(implied, 1),
      typicalMissPoints: round(model.rmse, 1),
      slope: round(model.slope),
      intercept: round(model.intercept),
      rSquared: round(model.rSquared),
      months: paired.length,
      independentDecades: independent,
      outOfSample,
      buckets,
      firstWindow: paired[0].key,
      lastWindow: paired.at(-1).key,
    };
  }

  const capePercentile = percentileOf(current.cape, capes);
  // A since-1950 rank only adds anything when the record reaches back before it.
  const spansPre1950 = withCape[0].year < 1950 && modern.length >= 120;
  const modernPercentile = spansPre1950 ? percentileOf(current.cape, modern) : null;
  const excessPercentile = Number.isFinite(currentExcessYield) ? percentileOf(currentExcessYield, excessHistory.map((entry) => entry.excessYield)) : null;
  return {
    version,
    status: historyYears >= 40 ? 'calculated' : 'provisional',
    asOf: current.key,
    earningsThrough: current.earningsThrough,
    price: round(current.price),
    cape: round(current.cape, 1),
    earningsYield: round(100 / current.cape),
    capePercentile,
    capePercentileSince1950: modernPercentile,
    medianCape: round(median(capes), 1),
    medianCapeSince1950: spansPre1950 ? round(median(modern), 1) : null,
    historyFrom: withCape[0].key,
    historyYears,
    realRate: round(currentRealRate),
    realRateSource,
    mixedDefinitions: !shillerBasis && Number.isFinite(currentExcessYield),
    excessYield: round(currentExcessYield),
    tipsRealYield: round(realYield10y),
    tipsRealYieldDate: Number.isFinite(realYield10y) ? realYieldDate : null,
    excessYieldWithTips: shillerBasis ? round(tipsExcessYield) : null,
    excessYieldPercentile: excessPercentile,
    outlook,
    history: withCape.filter((_entry, index) => index % 3 === 0 || index === withCape.length - 1).map((entry) => ({ date: entry.key, cape: round(entry.cape, 1), excessYield: round(entry.excessYield) })),
    read: describeValuation({ current, historyFrom: withCape[0].key, capePercentile, modernPercentile, currentExcessYield, excessPercentile, outlook, realRateSource, mixed: !shillerBasis, tipsExcessYield: shillerBasis ? tipsExcessYield : null, realYield10y }),
    methodology: 'CAPE is the real S&P Composite price over the average of the previous 120 months of real earnings, all deflated to the latest CPI and computed here from Shiller’s raw price, earnings and CPI columns. The latest prices are set against the most recent ten years of reported earnings, which lag by two to three quarters. The excess CAPE yield is 100/CAPE less the real 10-year rate: the TIPS yield today, and the 10-year Treasury yield less trailing ten-year inflation in the history. Forward returns are ten-year annualized real total returns with dividends reinvested monthly. The line is an ordinary least-squares fit of those returns on the excess yield across every overlapping month, so its fit statistics overstate the evidence: ten-year windows a month apart share 119 of their 120 months.',
    limits: 'About fifteen independent decades of evidence, most of them from a market with different accounting, payout and sector mix. The out-of-sample test is a single split. Valuation has said little about the next year or two in any period on record; it is a statement about the coming decade.',
  };
}

function describeValuation({ current, historyFrom, capePercentile, modernPercentile, currentExcessYield, excessPercentile, outlook, realRateSource, mixed, tipsExcessYield, realYield10y }) {
  const parts = [`CAPE is ${round(current.cape, 1)}, higher than ${capePercentile}% of months since ${historyFrom.slice(0, 4)}${Number.isFinite(modernPercentile) ? ` and ${modernPercentile}% since 1950` : ''}.`];
  if (Number.isFinite(currentExcessYield)) {
    parts.push(`Its ${round(100 / current.cape)}% earnings yield, less a ${round(100 / current.cape - currentExcessYield)}% real rate (the ${realRateSource}), leaves an excess yield of ${round(currentExcessYield)}%${Number.isFinite(excessPercentile) ? `, lower than ${100 - excessPercentile}% of history` : ''}${mixed ? ' - ranked against a history that uses Treasury yields less trailing inflation, so the comparison mixes definitions' : ''}.`);
    if (Number.isFinite(tipsExcessYield)) parts.push(`Against the ${round(realYield10y)}% TIPS yield instead, the excess yield is ${round(tipsExcessYield)}%.`);
  }
  if (outlook.status !== 'unavailable') {
    const test = outlook.outOfSample;
    parts.push(`At this excess yield, the following ten years have historically returned about ${outlook.impliedRealReturn}% a year after inflation, typically missing by ${outlook.typicalMissPoints} points either way - roughly ${outlook.independentDecades} independent decades of evidence.`);
    if (test?.status === 'calculated') {
      parts.push(test.beatsNaive
        ? `Fitted only on windows that began before 1981, it missed post-1990 outcomes by ${test.modelErrorPoints} points against ${test.naiveErrorPoints} for simply guessing the average.`
        : `Out of sample it did not beat guessing the historical average for windows that began after 1990 (${test.modelErrorPoints} against ${test.naiveErrorPoints} points), so read the level, not the forecast.`);
    }
  }
  return parts.join(' ');
}

export const SHILLER_PAGE = 'https://shillerdata.com/';
export const SHILLER_FALLBACK_URLS = ['http://www.econ.yale.edu/~shiller/data/ie_data.xls'];

/**
 * The data file's current address, read from the page that links to it. The
 * file is served from a content-hosting path that changes between uploads,
 * so a hardcoded link would break silently the next time it moves.
 */
export function findShillerDataLink(html, baseUrl = SHILLER_PAGE) {
  for (const match of String(html ?? '').matchAll(/href\s*=\s*["']([^"']*ie_data\.xls[^"']*)["']/gi)) {
    try {
      return new URL(match[1].replace(/&amp;/g, '&'), baseUrl).toString();
    } catch {
      // A malformed href is skipped; another may still be usable.
    }
  }
  return null;
}
