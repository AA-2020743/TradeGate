/**
 * Gold against the 10-year real yield: does the opportunity-cost link still
 * price it?
 *
 * For most of the TIPS era gold moved inversely to real yields - holding a
 * metal that pays nothing costs more when inflation-protected bonds pay more.
 * Two readings test whether that still holds:
 *
 *   level   log(gold) regressed on the real yield over the oldest 70% of
 *           months, then applied to the newest 30% it never saw. The gap
 *           between gold and the level the fit implies is the part of the
 *           price real yields do not explain; a gap that stays beyond twice
 *           the fit window's typical error is a relationship that has broken,
 *           not noise.
 *   changes the 36-month rolling correlation and beta of monthly gold
 *           returns on monthly real-yield changes, which ask whether gold
 *           still reacts to real yields month to month even if its level has
 *           drifted away.
 *
 * Month-end values on both sides, so a month's gold close and its real yield
 * describe the same day.
 */

export const GOLD_REAL_YIELD_VERSION = 'gold-real-yield-v1';
const HOLDOUT_SHARE = 0.3;
const ROLLING_MONTHS = 36;
const MINIMUM_MONTHS = 120;
const BREAK_SIGMAS = 2;

function round(value, digits = 2) {
  return Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Ordinary least squares of ys on xs. */
export function ols(xs, ys) {
  const xMean = mean(xs);
  const yMean = mean(ys);
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let index = 0; index < xs.length; index += 1) {
    sxy += (xs[index] - xMean) * (ys[index] - yMean);
    sxx += (xs[index] - xMean) ** 2;
    syy += (ys[index] - yMean) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = yMean - slope * xMean;
  const residuals = xs.map((x, index) => ys[index] - (intercept + slope * x));
  const residualSd = Math.sqrt(residuals.reduce((total, value) => total + value * value, 0) / Math.max(1, xs.length - 2));
  return { intercept, slope, r2: syy > 0 ? (sxy * sxy) / (sxx * syy) : 0, correlation: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0, residualSd };
}

/** The last value in each calendar month, keyed YYYY-MM. */
export function monthEnds(points) {
  const out = new Map();
  const sorted = (points ?? [])
    .map((point) => ({ date: String(point.date ?? point.timestamp ?? '').slice(0, 10), value: point.value }))
    .filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.value))
    .sort((left, right) => left.date.localeCompare(right.date));
  for (const point of sorted) out.set(point.date.slice(0, 7), { date: point.date, value: point.value });
  return out;
}

/**
 * @param {{ gold: Array<{date?: string, timestamp?: string, value: number}>, realYield: Array<{date: string, value: number}> }} input
 */
export function calculateGoldRealYield({ gold, realYield }) {
  const version = GOLD_REAL_YIELD_VERSION;
  const goldMonths = monthEnds((gold ?? []).filter((point) => point.value > 0));
  const yieldMonths = monthEnds(realYield);
  const months = [...goldMonths.keys()].filter((month) => yieldMonths.has(month)).sort();
  if (months.length < MINIMUM_MONTHS) {
    return { version, status: 'unavailable', reason: `Gold and the 10-year real yield share ${months.length} months; ${MINIMUM_MONTHS} are needed.` };
  }
  const rows = months.map((month) => ({ month, gold: goldMonths.get(month).value, goldDate: goldMonths.get(month).date, realYield: yieldMonths.get(month).value, yieldDate: yieldMonths.get(month).date }));
  const split = Math.floor(rows.length * (1 - HOLDOUT_SHARE));
  const fitRows = rows.slice(0, split);
  const fit = ols(fitRows.map((row) => row.realYield), fitRows.map((row) => Math.log(row.gold)));
  const residualOf = (row) => Math.log(row.gold) - (fit.intercept + fit.slope * row.realYield);
  const band = BREAK_SIGMAS * fit.residualSd;

  // Monthly changes: gold return in percent, real-yield change in points.
  const changes = rows.slice(1).map((row, index) => ({ month: row.month, goldReturn: (row.gold / rows[index].gold - 1) * 100, yieldChange: row.realYield - rows[index].realYield }));
  const changeFit = (members) => (members.length >= 12 ? ols(members.map((change) => change.yieldChange), members.map((change) => change.goldReturn)) : null);
  const rolling = new Map();
  for (let end = ROLLING_MONTHS; end <= changes.length; end += 1) {
    const window = changeFit(changes.slice(end - ROLLING_MONTHS, end));
    rolling.set(changes[end - 1].month, { correlation: window.correlation, beta: window.slope });
  }
  const fitChanges = changeFit(changes.filter((change) => change.month <= fitRows.at(-1).month));
  const heldOutChanges = changeFit(changes.filter((change) => change.month > fitRows.at(-1).month));

  const history = rows.map((row) => {
    const implied = Math.exp(fit.intercept + fit.slope * row.realYield);
    const window = rolling.get(row.month);
    return {
      month: row.month,
      gold: round(row.gold, 1),
      implied: round(implied, 1),
      gapPercent: round((row.gold / implied - 1) * 100, 1),
      realYield: round(row.realYield, 2),
      rollingCorrelation: window ? round(window.correlation) : null,
      rollingBeta: window ? round(window.beta, 1) : null,
    };
  });
  const latestRow = rows.at(-1);
  const latest = history.at(-1);
  const meanAbsoluteGap = (members) => round(mean(members.map((row) => Math.abs(Math.exp(residualOf(row)) - 1) * 100)), 1);

  let outsideSince = null;
  for (let index = rows.length - 1; index >= 0 && Math.abs(residualOf(rows[index])) > band; index -= 1) outsideSince = rows[index].month;
  const latestRolling = rolling.get(latestRow.month) ?? null;

  const result = {
    version,
    status: 'calculated',
    asOf: latestRow.goldDate,
    asOfSource: 'Month-end gold and 10-year TIPS yield',
    state: outsideSince ? 'Outside the fit band' : 'Within the fit band',
    headline: { label: 'Gap to the real-yield fit', value: latest.gapPercent, unit: '%' },
    month: latestRow.month,
    goldDate: latestRow.goldDate,
    yieldDate: latestRow.yieldDate,
    gold: latest.gold,
    realYield: latest.realYield,
    implied: latest.implied,
    gapPercent: latest.gapPercent,
    fitFrom: fitRows[0].month,
    fitThrough: fitRows.at(-1).month,
    heldOutFrom: rows[split].month,
    months: rows.length,
    fit: {
      percentPerPoint: round((Math.exp(fit.slope) - 1) * 100, 1),
      r2: round(fit.r2),
      typicalErrorPercent: round((Math.exp(fit.residualSd) - 1) * 100, 1),
      breakBandPercent: round((Math.exp(band) - 1) * 100, 1),
      meanAbsoluteGapPercent: meanAbsoluteGap(fitRows),
    },
    heldOut: { meanAbsoluteGapPercent: meanAbsoluteGap(rows.slice(split)), months: rows.length - split },
    outsideBandSince: outsideSince,
    changes: {
      windowMonths: ROLLING_MONTHS,
      latest: latestRolling ? { correlation: round(latestRolling.correlation), betaPercentPerPoint: round(latestRolling.beta, 1) } : null,
      fitWindow: fitChanges ? { correlation: round(fitChanges.correlation), betaPercentPerPoint: round(fitChanges.slope, 1) } : null,
      heldOut: heldOutChanges ? { correlation: round(heldOutChanges.correlation), betaPercentPerPoint: round(heldOutChanges.slope, 1) } : null,
    },
    history,
  };
  return {
    ...result,
    read: describeGoldRealYield(result),
    methodology: `Month-end gold (COMEX front-month futures) and month-end 10-year TIPS yield (FRED DFII10). Level: log gold regressed on the real yield over ${result.fitFrom} to ${result.fitThrough} (the oldest ${Math.round((1 - HOLDOUT_SHARE) * 100)}% of months), applied unchanged to the ${result.heldOut.months} months since; the gap is gold against that implied level, and the band is ${BREAK_SIGMAS} standard deviations of the fit window’s error. Changes: ${ROLLING_MONTHS}-month rolling correlation and slope of monthly gold returns on monthly real-yield changes, in percent per percentage point.`,
    limits: 'A level regression of two trending series: the fit-window R² flatters the link, which is why the held-out gap and the change correlation are the readings to weigh. One driver only - the dollar, central-bank reserve buying and sanctions risk are not in it, and they are the usual explanations offered for a gap. TIPS yields begin in 2003, so the sample is one long era of falling then rising rates.',
  };
}

function describeGoldRealYield(result) {
  const direction = result.gapPercent >= 0 ? 'above' : 'below';
  const dollars = (value) => `$${Math.round(value).toLocaleString('en-US')}`;
  const parts = [`Gold at ${dollars(result.gold)} is ${Math.abs(result.gapPercent)}% ${direction} the ${dollars(result.implied)} its ${result.fitFrom.slice(0, 4)}-${result.fitThrough.slice(0, 4)} relationship with the 10-year real yield (now ${result.realYield}%) implies`];
  if (result.outsideBandSince) parts.push(`it has been outside that fit’s usual error band (±${result.fit.breakBandPercent}%) since ${result.outsideBandSince}, so the level link has broken rather than wobbled`);
  else parts.push(`within the fit’s usual error band of ±${result.fit.breakBandPercent}%`);
  let changes = '';
  const { latest, fitWindow } = result.changes;
  if (latest && fitWindow) {
    const how = latest.correlation <= -0.4 ? 'moved clearly against real yields' : latest.correlation <= -0.2 ? 'moved loosely against real yields' : latest.correlation < 0.2 ? 'barely tracked real yields' : 'moved with real yields, not against them';
    changes = ` Month to month over the last ${result.changes.windowMonths} months, gold ${how} (correlation ${latest.correlation}, ${latest.betaPercentPerPoint}% per point of real yield), against ${fitWindow.correlation} and ${fitWindow.betaPercentPerPoint}% per point in the fit window.`;
  }
  return `${parts.join('; ')}.${changes}`;
}
