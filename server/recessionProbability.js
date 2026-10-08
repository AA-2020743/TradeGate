/**
 * The chance the U.S. is in recession twelve months from now, read from the
 * Treasury curve the way the New York Fed reads it.
 *
 * The model is a probit on one variable: the monthly average spread between
 * the 10-year Treasury yield and the 3-month bill (the bill converted from its
 * discount quote to a bond-equivalent yield). P(recession in month t+12) =
 * Φ(α + β × spread_t), with the New York Fed's published α = -0.5333 and
 * β = -0.6330. A flat curve reads about 30%; each point of inversion adds
 * roughly twenty.
 *
 * A published coefficient is a claim, so the model is also refit here on
 * NBER-dated outcomes: once on 1959-2009, which should land near the published
 * pair if the inputs are built the same way, and once on every month whose
 * outcome NBER has had time to date, which shows whether the relationship has
 * weakened since. The track record is the episodes themselves - each time the
 * probability rose above 30%, did a recession begin within two years - and
 * the recessions that arrived without the signal.
 */

export const RECESSION_PROBABILITY_VERSION = 'recession-probability-v1';
export const NY_FED_COEFFICIENTS = { alpha: -0.5333, beta: -0.633 };
const FIRST_MONTH = '1959-01';
const FIT_WINDOW_END = '2009-12';
const HORIZON_MONTHS = 12;
const SIGNAL_PERCENT = 30;
// Months below the signal level that still count as the same episode: the
// curve often flickers across zero for a month or two on the way in.
const EPISODE_MERGE_GAP = 6;
const LEAD_WINDOW_MONTHS = 24;
// NBER has taken from four to twenty-one months to date a recession's start;
// FRED's USREC reads 0 for recent months until it does.
const NBER_DATING_LAG_MONTHS = 12;
const MINIMUM_MONTHS = 240;
const BANDS = [
  { key: 'low', label: 'Under 10%', from: 0, to: 10 },
  { key: 'modest', label: '10% to 30%', from: 10, to: 30 },
  { key: 'elevated', label: '30% to 50%', from: 30, to: 50 },
  { key: 'high', label: '50% and over', from: 50, to: 101 },
];

function round(value, digits = 2) {
  return Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
}

/** Standard normal CDF via the complementary error function (Numerical Recipes erfc, |error| < 1.2e-7). */
export function normalCdf(x) {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const erfc = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - erfc / 2 : erfc / 2;
}

function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** A 3-month bill's discount rate, in percent, as a bond-equivalent yield. */
export function bondEquivalentYield(discountPercent, days = 91) {
  const rate = discountPercent / 100;
  return (365 * rate) / (360 - days * rate) * 100;
}

export function probabilityFromSpread(spread, { alpha, beta } = NY_FED_COEFFICIENTS) {
  return normalCdf(alpha + beta * spread) * 100;
}

function monthOf(date) {
  return String(date ?? '').slice(0, 7);
}

export function addMonths(month, count) {
  const [year, number] = month.split('-').map(Number);
  const index = year * 12 + (number - 1) + count;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

function monthsBetween(from, to) {
  const [fromYear, fromMonth] = from.split('-').map(Number);
  const [toYear, toMonth] = to.split('-').map(Number);
  return (toYear - fromYear) * 12 + (toMonth - fromMonth);
}

/**
 * Probit maximum likelihood for P(y = 1) = Φ(alpha + beta x), by Newton's
 * method on the two parameters (Greene's form of the gradient and Hessian).
 */
export function fitProbit(xs, ys, { iterations = 50 } = {}) {
  let alpha = 0;
  let beta = 0;
  for (let step = 0; step < iterations; step += 1) {
    let g0 = 0; let g1 = 0; let h00 = 0; let h01 = 0; let h11 = 0;
    for (let index = 0; index < xs.length; index += 1) {
      const x = xs[index];
      const q = ys[index] ? 1 : -1;
      const z = alpha + beta * x;
      const lambda = q * normalPdf(q * z) / Math.max(normalCdf(q * z), 1e-300);
      const weight = lambda * (lambda + z);
      g0 += lambda; g1 += lambda * x;
      h00 += weight; h01 += weight * x; h11 += weight * x * x;
    }
    const determinant = h00 * h11 - h01 * h01;
    if (!(Math.abs(determinant) > 1e-12)) return { alpha, beta, converged: false };
    const deltaAlpha = (h11 * g0 - h01 * g1) / determinant;
    const deltaBeta = (h00 * g1 - h01 * g0) / determinant;
    alpha += deltaAlpha;
    beta += deltaBeta;
    if (Math.abs(deltaAlpha) < 1e-9 && Math.abs(deltaBeta) < 1e-9) return { alpha, beta, converged: true };
  }
  return { alpha, beta, converged: false };
}

/** Monthly 10-year minus bond-equivalent 3-month bill, on the months both series cover. */
export function buildMonthlySpread({ tenYear, billDiscount }) {
  const bills = new Map((billDiscount ?? []).filter((point) => Number.isFinite(point.value)).map((point) => [monthOf(point.date), point.value]));
  return (tenYear ?? [])
    .filter((point) => Number.isFinite(point.value) && bills.has(monthOf(point.date)) && monthOf(point.date) >= FIRST_MONTH)
    .map((point) => {
      const month = monthOf(point.date);
      const bill = bondEquivalentYield(bills.get(month));
      return { month, tenYear: point.value, bill, spread: point.value - bill };
    })
    .sort((left, right) => left.month.localeCompare(right.month));
}

/**
 * @param {{ tenYear: Array<{date: string, value: number}>, billDiscount: Array<{date: string, value: number}>, recessions: Array<{date: string, value: number}> }} input
 */
export function calculateRecessionProbability({ tenYear, billDiscount, recessions }) {
  const version = RECESSION_PROBABILITY_VERSION;
  const months = buildMonthlySpread({ tenYear, billDiscount });
  if (months.length < MINIMUM_MONTHS) {
    return { version, status: 'unavailable', reason: `The 10-year and 3-month bill series share ${months.length} months since ${FIRST_MONTH}; ${MINIMUM_MONTHS} are needed.` };
  }
  const recessionByMonth = new Map((recessions ?? []).filter((point) => point.value === 0 || point.value === 1).map((point) => [monthOf(point.date), point.value]));
  const datedMonths = [...recessionByMonth.keys()].sort();
  if (!datedMonths.length) return { version, status: 'unavailable', reason: 'NBER recession dates (FRED USREC) are required to judge the model.' };
  const lastDated = datedMonths.at(-1);
  const confirmedThrough = addMonths(lastDated, -NBER_DATING_LAG_MONTHS);

  const rows = months.map((row) => {
    const target = addMonths(row.month, HORIZON_MONTHS);
    const outcome = target <= confirmedThrough && recessionByMonth.has(target) ? recessionByMonth.get(target) : null;
    return { ...row, target, probability: probabilityFromSpread(row.spread), outcome };
  });
  const latest = rows.at(-1);

  const recessionStarts = datedMonths.filter((month, index) => recessionByMonth.get(month) === 1 && month >= FIRST_MONTH && (index === 0 || recessionByMonth.get(datedMonths[index - 1]) === 0));
  const recessionPeriods = recessionStarts.map((start) => {
    let end = start;
    while (recessionByMonth.get(addMonths(end, 1)) === 1) end = addMonths(end, 1);
    return { from: start, to: end };
  });

  const episodes = findEpisodes(rows).map((episode) => {
    const windowEnd = addMonths(episode.start, LEAD_WINDOW_MONTHS);
    const underway = recessionByMonth.get(episode.start) === 1;
    const recession = recessionStarts.find((start) => start >= episode.start && start <= windowEnd) ?? null;
    const outcome = underway && !recession ? 'late' : recession ? 'followed' : windowEnd > confirmedThrough ? 'pending' : 'not followed';
    return {
      ...episode,
      peakProbability: round(episode.peakProbability, 1),
      recessionStart: recession,
      leadMonths: recession ? monthsBetween(episode.start, recession) : null,
      outcome,
      afterFitWindow: episode.start > FIT_WINDOW_END,
    };
  });
  // Signalled when any month of an episode falls in the two years before the
  // start: a long episode that already produced one recession can run on into
  // the next, as 1978-81 did.
  const missed = recessionStarts.filter((start) => !episodes.some((episode) => episode.start <= start && episode.end >= addMonths(start, -LEAD_WINDOW_MONTHS)));

  const scored = rows.filter((row) => row.outcome !== null);
  const baseRate = scored.length ? scored.filter((row) => row.outcome === 1).length / scored.length * 100 : null;
  const bands = BANDS.map((band) => {
    const members = scored.filter((row) => row.probability >= band.from && row.probability < band.to);
    const hits = members.filter((row) => row.outcome === 1).length;
    const recessionsHit = new Set(members.filter((row) => row.outcome === 1).map((row) => recessionPeriods.find((period) => row.target >= period.from && row.target <= period.to)?.from)).size;
    return {
      key: band.key,
      label: band.label,
      months: members.length,
      inRecessionAfter12Months: members.length ? round(hits / members.length * 100, 1) : null,
      averageProbability: members.length ? round(members.reduce((total, row) => total + row.probability, 0) / members.length, 1) : null,
      distinctRecessions: recessionsHit,
    };
  });

  const fitIn = scored.filter((row) => row.month <= FIT_WINDOW_END);
  const fitWindow = fitIn.length >= MINIMUM_MONTHS ? fitProbit(fitIn.map((row) => row.spread), fitIn.map((row) => row.outcome)) : null;
  const fitAll = scored.length >= MINIMUM_MONTHS ? fitProbit(scored.map((row) => row.spread), scored.map((row) => row.outcome)) : null;
  const describeFit = (fit, members) => (fit?.converged ? {
    alpha: round(fit.alpha, 4),
    beta: round(fit.beta, 4),
    from: members[0].month,
    through: members.at(-1).month,
    months: members.length,
    probabilityNow: round(probabilityFromSpread(latest.spread, fit), 1),
    flatCurveProbability: round(probabilityFromSpread(0, fit), 1),
  } : null);

  let invertedMonths = 0;
  for (let index = rows.length - 1; index >= 0 && rows[index].spread < 0; index -= 1) invertedMonths += 1;
  const recent = rows.slice(-24);
  const peakRecent = recent.reduce((best, row) => (row.probability > best.probability ? row : best), recent[0]);

  const result = {
    version,
    status: 'calculated',
    month: latest.month,
    targetMonth: latest.target,
    probability: round(latest.probability, 1),
    spread: round(latest.spread, 2),
    tenYear: round(latest.tenYear, 2),
    billBondEquivalent: round(latest.bill, 2),
    invertedMonths,
    peakLast24Months: { month: peakRecent.month, probability: round(peakRecent.probability, 1) },
    coefficients: NY_FED_COEFFICIENTS,
    refit: { fitWindow: describeFit(fitWindow, fitIn), allConfirmed: describeFit(fitAll, scored) },
    signalPercent: SIGNAL_PERCENT,
    episodes,
    missedRecessions: missed,
    bands,
    baseRatePercent: round(baseRate, 1),
    recessionsInSample: recessionPeriods.length,
    recessionPeriods,
    nberDatedThrough: lastDated,
    outcomesConfirmedThrough: confirmedThrough,
    history: rows.map((row) => ({ month: row.month, target: row.target, probability: round(row.probability, 1), spread: round(row.spread, 2) })),
  };
  return {
    ...result,
    read: describeRecessionProbability(result),
    methodology: `P(recession in month t+12) = Φ(${NY_FED_COEFFICIENTS.alpha} ${NY_FED_COEFFICIENTS.beta} × spread), the New York Fed’s probit, where the spread is the monthly average 10-year Treasury yield (FRED GS10) less the 3-month bill (FRED TB3MS) converted from its discount rate to a bond-equivalent yield. Outcomes are NBER recession months (FRED USREC). An episode is a run of months at or above ${SIGNAL_PERCENT}%, merged across gaps under ${EPISODE_MERGE_GAP} months; it counts as followed when a recession began within ${LEAD_WINDOW_MONTHS} months of its start. The New York Fed estimated its coefficients on 1959-2009; the first refit uses the same window on these inputs and should land near them, the second adds every month since whose outcome NBER has had time to date.`,
    limits: `One variable, and few events: ${recessionPeriods.length} recessions since ${FIRST_MONTH.slice(0, 4)}, so neighbouring months in a band are one observation, not many. NBER dates a recession months after it begins, so outcomes after ${confirmedThrough} are not scored and a recession now underway would not yet show. The curve has moved with Fed policy and term premia that differ across decades, which is what the full-sample refit tests. The reading is monthly; the current month lands when FRED publishes the monthly averages early next month.`,
  };
}

function findEpisodes(rows) {
  const episodes = [];
  let current = null;
  let below = 0;
  rows.forEach((row, index) => {
    if (row.probability >= SIGNAL_PERCENT) {
      if (!current) current = { start: row.month, end: row.month, peakMonth: row.month, peakProbability: row.probability };
      current.end = row.month;
      if (row.probability > current.peakProbability) Object.assign(current, { peakMonth: row.month, peakProbability: row.probability });
      below = 0;
    } else if (current) {
      below += 1;
      if (below >= EPISODE_MERGE_GAP) { episodes.push(current); current = null; below = 0; }
    }
    if (index === rows.length - 1 && current) episodes.push({ ...current, ongoing: current.end === row.month });
  });
  return episodes.map((episode) => ({ ongoing: false, ...episode }));
}

function monthName(month) {
  const [year, number] = month.split('-').map(Number);
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][number - 1]} ${year}`;
}

function describeRecessionProbability(result) {
  const parts = [`On ${monthName(result.month)}’s average curve - the 10-year at ${result.tenYear}% against the 3-month bill at ${result.billBondEquivalent}%, a spread of ${result.spread > 0 ? '+' : ''}${result.spread} points - the New York Fed’s model puts the chance of a U.S. recession in ${monthName(result.targetMonth)} at ${result.probability}%`];
  if (result.invertedMonths >= 2) parts.push(`the curve has been inverted ${result.invertedMonths} months running`);
  else if (result.peakLast24Months.probability >= SIGNAL_PERCENT && result.peakLast24Months.probability - result.probability >= 10) parts.push(`down from ${result.peakLast24Months.probability}% in ${monthName(result.peakLast24Months.month)}`);
  const judged = result.episodes.filter((episode) => episode.outcome === 'followed' || episode.outcome === 'not followed');
  const followed = judged.filter((episode) => episode.outcome === 'followed');
  const lastMiss = [...judged].reverse().find((episode) => episode.outcome === 'not followed');
  let record = `Since ${result.history[0].month.slice(0, 4)} it has risen above ${SIGNAL_PERCENT}% ${judged.length} times with the outcome known, and a recession began within two years of ${followed.length}`;
  if (lastMiss) record += `; the latest exception began in ${monthName(lastMiss.start)}, peaking at ${lastMiss.peakProbability}%`;
  if (result.missedRecessions.length) record += `. ${result.missedRecessions.length} ${result.missedRecessions.length === 1 ? 'recession' : 'recessions'} arrived without the signal (${result.missedRecessions.map((month) => month.slice(0, 4)).join(', ')})`;
  const full = result.refit.allConfirmed;
  const window = result.refit.fitWindow;
  let refit = '';
  if (full && window && Math.abs(full.probabilityNow - result.probability) >= 5) {
    refit = ` Refit on every month NBER has dated through ${full.through}, the same curve reads ${full.probabilityNow}%: the relationship has ${full.probabilityNow < result.probability ? 'weakened' : 'strengthened'} since the published coefficients were estimated.`;
  }
  return `${parts.join('; ')}. ${record}.${refit}`;
}
