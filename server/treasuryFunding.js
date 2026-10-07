import { mean, percentileRank, standardDeviation } from './statistics.js';

/**
 * How easily the US Treasury is funding itself, and what its cash management
 * is doing to liquidity - from the Treasury's own Fiscal Data API, no key.
 *
 * Five readings:
 *
 * - Auction demand. Bid-to-cover, the indirect (largely foreign and
 *   institutional) share, and the primary-dealer takedown - dealers absorb
 *   what end investors did not want, so a high takedown is a weak auction.
 *   Each is ranked only against that tenor's own past auctions: a 2-year
 *   routinely covers higher than a 30-year, so ranking across tenors would
 *   call every long-bond auction weak.
 * - The cash balance (TGA), daily. When the Treasury builds cash it drains
 *   bank reserves dollar for dollar; when it spends down it adds them. The
 *   weekly FRED series smears this across the week, and tax dates move it by
 *   a hundred billion in days.
 * - Debt growth, interest cost, and how much of the marketable debt has to be
 *   refinanced within a year.
 *
 * Three rules come from failures observed in an earlier implementation of the
 * same idea, and each is tested:
 *
 * - An announced auction is not a result. The auctions dataset lists upcoming
 *   auctions with their offering size and no outcome, and treating the newest
 *   row as "latest" silently drops the tenor whenever one is pending. Only
 *   rows with a bid-to-cover count as completed.
 * - A percentile needs a history. Ranking against the newest 200 auctions of
 *   every kind leaves about five per coupon tenor once weekly bills take their
 *   share, and a 0th percentile against five values is not evidence. The
 *   request is restricted to notes and bonds, and a rank needs twelve prior
 *   auctions of the same tenor.
 * - A measure whose field is absent says so. A misspelled field name returns
 *   nothing on every row and looks exactly like "no signal"; here each demand
 *   measure publishes whether its field was present at all.
 */

const STANDARD_TERMS = ['2-Year', '3-Year', '5-Year', '7-Year', '10-Year', '20-Year', '30-Year'];
const HISTORY_AUCTIONS = 24;
const MINIMUM_HISTORY = 12;
const RECENT_DAYS = 60;
const DAY_MS = 86_400_000;

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Fiscal Data sends numbers as strings, sometimes with commas, sometimes "null". */
export function parseAmount(value) {
  if (value === null || value === undefined || value === '' || value === 'null') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function firstAmount(row, names) {
  for (const name of names) {
    const value = parseAmount(row?.[name]);
    if (value !== null) return value;
  }
  return null;
}

function present(rows, names) {
  return rows.some((row) => names.some((name) => Object.hasOwn(row ?? {}, name)));
}

function isInflationOrFloating(row) {
  const type = String(row?.security_type ?? '');
  return /TIPS|FRN|floating/i.test(type)
    || String(row?.inflation_index_security ?? '').toLowerCase() === 'yes'
    || String(row?.floating_rate ?? '').toLowerCase() === 'yes';
}

/**
 * A reopening of a 10-year is listed with its remaining term ("9-Year
 * 10-Month"). Where the dataset carries the original term it is used so the
 * reopening ranks with its tenor; otherwise only exact standard terms count.
 */
function tenorOf(row) {
  if (STANDARD_TERMS.includes(row?.original_security_term)) return row.original_security_term;
  if (STANDARD_TERMS.includes(row?.security_term)) return row.security_term;
  return null;
}

const MEASURES = {
  indirect: { numerator: ['indirect_bidder_accepted'], denominator: ['comp_accepted', 'total_accepted'] },
  dealer: { numerator: ['primary_dealer_accepted'], denominator: ['comp_accepted', 'total_accepted'] },
};

function shareOf(row, measure) {
  const numerator = firstAmount(row, measure.numerator);
  const denominator = firstAmount(row, measure.denominator);
  return numerator !== null && denominator > 0 ? (numerator / denominator) * 100 : null;
}

function rankAgainst(prior, value) {
  const history = prior.filter(Number.isFinite);
  if (!Number.isFinite(value) || history.length < MINIMUM_HISTORY) return { percentile: null, zScore: null, priorCount: history.length };
  const sd = standardDeviation(history);
  return {
    percentile: percentileRank(history, value),
    zScore: sd > 0 ? round((value - mean(history)) / sd, 2) : null,
    priorCount: history.length,
  };
}

export function summarizeAuctions(rows, { now = Date.now() } = {}) {
  const coupons = (rows ?? []).filter((row) => tenorOf(row) && !isInflationOrFloating(row));
  const coverage = {
    bidToCover: present(coupons, ['bid_to_cover_ratio']),
    indirect: present(coupons, MEASURES.indirect.numerator) && present(coupons, MEASURES.indirect.denominator),
    dealer: present(coupons, MEASURES.dealer.numerator) && present(coupons, MEASURES.dealer.denominator),
  };
  const completed = coupons
    .map((row) => ({
      tenor: tenorOf(row),
      date: String(row.auction_date ?? '').slice(0, 10),
      bidToCover: parseAmount(row.bid_to_cover_ratio),
      indirectShare: shareOf(row, MEASURES.indirect),
      dealerShare: shareOf(row, MEASURES.dealer),
      highYield: firstAmount(row, ['high_yield']),
      size: firstAmount(row, ['offering_amt']),
    }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.bidToCover) && row.bidToCover > 0);
  const pending = coupons.filter((row) => parseAmount(row.bid_to_cover_ratio) === null && Date.parse(row.auction_date) >= now - DAY_MS).length;

  const tenors = STANDARD_TERMS.map((tenor) => {
    const series = completed.filter((row) => row.tenor === tenor).sort((left, right) => right.date.localeCompare(left.date));
    if (!series.length) return { tenor, status: 'unavailable', reason: `No completed ${tenor} auction in the response.` };
    const [latest, ...older] = series;
    const prior = older.slice(0, HISTORY_AUCTIONS);
    const bidToCover = rankAgainst(prior.map((row) => row.bidToCover), latest.bidToCover);
    const indirect = rankAgainst(prior.map((row) => row.indirectShare), latest.indirectShare);
    const dealer = rankAgainst(prior.map((row) => row.dealerShare), latest.dealerShare);
    const ageDays = Math.floor((now - Date.parse(`${latest.date}T00:00:00Z`)) / DAY_MS);

    // Higher cover and indirect share are strength; a higher dealer takedown
    // is weakness, so it enters inverted. The tenor's demand score is the
    // mean of whichever ranks exist - published with how many there were.
    const ranks = [bidToCover.percentile, indirect.percentile, Number.isFinite(dealer.percentile) ? 100 - dealer.percentile : null].filter(Number.isFinite);
    const demand = ranks.length ? Math.round(ranks.reduce((total, value) => total + value, 0) / ranks.length) : null;
    return {
      tenor,
      status: Number.isFinite(demand) ? 'calculated' : 'provisional',
      date: latest.date,
      ageDays,
      bidToCover: round(latest.bidToCover, 2),
      bidToCoverPercentile: bidToCover.percentile,
      bidToCoverZ: bidToCover.zScore,
      indirectShare: round(latest.indirectShare, 1),
      indirectPercentile: indirect.percentile,
      dealerShare: round(latest.dealerShare, 1),
      dealerPercentile: dealer.percentile,
      highYield: round(latest.highYield, 3),
      sizeBillions: Number.isFinite(latest.size) ? round(latest.size / 1e9, 1) : null,
      priorAuctions: bidToCover.priorCount,
      measuresRanked: ranks.length,
      demand,
      reason: Number.isFinite(demand) ? undefined : `Only ${bidToCover.priorCount} prior ${tenor} auctions; a rank needs ${MINIMUM_HISTORY}.`,
    };
  });

  // Only recent auctions speak to current demand. A tenor whose last result
  // is two months old is shown but does not vote.
  const voting = tenors.filter((tenor) => Number.isFinite(tenor.demand) && tenor.ageDays <= RECENT_DAYS);
  const weak = voting.filter((tenor) => tenor.demand <= 25);
  const strong = voting.filter((tenor) => tenor.demand >= 75);
  const average = voting.length ? Math.round(voting.reduce((total, tenor) => total + tenor.demand, 0) / voting.length) : null;
  const state = voting.length < 4 ? null
    : weak.length >= 3 ? 'Soft demand'
      : strong.length >= 3 ? 'Firm demand'
        : 'Normal demand';

  const missing = Object.entries(coverage).filter(([, available]) => !available).map(([key]) => ({ bidToCover: 'bid-to-cover', indirect: 'indirect share', dealer: 'dealer takedown' })[key]);

  return {
    status: state ? (missing.length ? 'provisional' : 'calculated') : 'unavailable',
    reason: state ? undefined : `A demand read needs four tenors ranked against their own history within ${RECENT_DAYS} days; ${voting.length} qualify.`,
    state,
    averageDemand: average,
    weakTenors: weak.map((tenor) => tenor.tenor),
    strongTenors: strong.map((tenor) => tenor.tenor),
    tenors,
    pendingAuctions: pending,
    coverage,
    missingMeasures: missing,
    completedAuctions: completed.length,
  };
}

/**
 * Daily TGA closing balance in USD millions. The Daily Treasury Statement
 * reports the closing balance row with its figure in the opening-balance
 * column, so either column is read.
 */
export function cashBalanceSeries(rows) {
  const byDate = new Map();
  for (const row of rows ?? []) {
    const account = String(row?.account_type ?? '').toLowerCase();
    if (!account.includes('closing balance') || !(account.includes('treasury general account') || account.includes('tga'))) continue;
    const date = String(row.record_date ?? '').slice(0, 10);
    const value = parseAmount(row.close_today_bal) ?? parseAmount(row.open_today_bal);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(value) && value > 0) byDate.set(date, value);
  }
  return [...byDate.entries()].map(([date, value]) => ({ date, value })).sort((left, right) => left.date.localeCompare(right.date));
}

function valueDaysBefore(series, days) {
  const latest = series.at(-1);
  const target = Date.parse(`${latest.date}T00:00:00Z`) - (days * DAY_MS);
  for (let index = series.length - 1; index >= 0; index -= 1) {
    if (Date.parse(`${series[index].date}T00:00:00Z`) <= target) {
      // A comparison point more than a week before its target is not that
      // change - it is a longer one with a gap in it.
      return target - Date.parse(`${series[index].date}T00:00:00Z`) <= 7 * DAY_MS ? series[index] : null;
    }
  }
  return null;
}

export function summarizeCashBalance(series) {
  if (series.length < 30) return { status: 'unavailable', reason: `Needs 30 daily closing balances; ${series.length} available.` };
  const latest = series.at(-1);
  const week = valueDaysBefore(series, 7);
  const month = valueDaysBefore(series, 28);
  const twoYears = series.filter((point) => Date.parse(`${point.date}T00:00:00Z`) >= Date.parse(`${latest.date}T00:00:00Z`) - (730 * DAY_MS)).map((point) => point.value);
  const change28 = month ? latest.value - month.value : null;
  return {
    status: 'calculated',
    asOf: latest.date,
    billions: round(latest.value / 1000, 1),
    change7Billions: week ? round((latest.value - week.value) / 1000, 1) : null,
    change28Billions: Number.isFinite(change28) ? round(change28 / 1000, 1) : null,
    // A rising cash balance pulls reserves out of the banking system.
    liquidityEffect28Billions: Number.isFinite(change28) ? round(-change28 / 1000, 1) : null,
    percentile2y: twoYears.length >= 250 ? percentileRank(twoYears, latest.value) : null,
    observations: series.length,
  };
}

export function summarizeDebt(rows) {
  const series = (rows ?? [])
    .map((row) => ({ date: String(row.record_date ?? '').slice(0, 10), held: parseAmount(row.debt_held_public_amt), total: parseAmount(row.tot_pub_debt_out_amt) }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.total > 0)
    .sort((left, right) => left.date.localeCompare(right.date));
  if (series.length < 60) return { status: 'unavailable', reason: `Needs 60 daily debt observations; ${series.length} available.` };
  const latest = series.at(-1);
  const at = (days) => {
    const target = Date.parse(`${latest.date}T00:00:00Z`) - (days * DAY_MS);
    for (let index = series.length - 1; index >= 0; index -= 1) {
      const time = Date.parse(`${series[index].date}T00:00:00Z`);
      if (time <= target) return target - time <= 10 * DAY_MS ? series[index] : null;
    }
    return null;
  };
  const growth = (prior) => (prior?.held > 0 && latest.held > 0 ? ((latest.held / prior.held) - 1) * 100 : null);
  const quarter = at(91);
  const year = at(365);
  return {
    status: 'calculated',
    asOf: latest.date,
    heldByPublicTrillions: round(latest.held / 1e12, 2),
    totalTrillions: round(latest.total / 1e12, 2),
    growth1yPercent: round(growth(year)),
    // The last quarter's pace, annualized, against the last year: is borrowing
    // accelerating or slowing.
    growth90dAnnualizedPercent: Number.isFinite(growth(quarter)) ? round((((1 + (growth(quarter) / 100)) ** (365 / 91)) - 1) * 100) : null,
    added1yTrillions: year?.held > 0 ? round((latest.held - year.held) / 1e12, 2) : null,
  };
}

export function summarizeInterestCost(rows) {
  const series = (rows ?? [])
    .filter((row) => String(row.security_desc ?? '') === 'Total Marketable')
    .map((row) => ({ date: String(row.record_date ?? '').slice(0, 10), rate: parseAmount(row.avg_interest_rate_amt) }))
    .filter((row) => Number.isFinite(row.rate))
    .sort((left, right) => left.date.localeCompare(right.date));
  if (series.length < 13) return { status: 'unavailable', reason: `Needs 13 monthly readings for a year-on-year change; ${series.length} available.` };
  const latest = series.at(-1);
  const yearAgo = series.at(-13);
  const bills = (rows ?? []).find((row) => String(row.security_desc) === 'Treasury Bills' && String(row.record_date).slice(0, 10) === latest.date);
  return {
    status: 'calculated',
    asOf: latest.date,
    averageRate: round(latest.rate, 3),
    change12mPoints: round(latest.rate - yearAgo.rate, 3),
    billsRate: round(parseAmount(bills?.avg_interest_rate_amt), 3),
  };
}

/** How much of the marketable debt matures within one and two years, from the latest monthly statement. */
export function summarizeMaturityWall(rows) {
  const parsed = (rows ?? []).map((row) => ({
    record: String(row.record_date ?? '').slice(0, 10),
    maturity: String(row.maturity_date ?? '').slice(0, 10),
    amount: firstAmount(row, ['outstanding_amt', 'outstanding_amount', 'total_mil_amt', 'debt_outstanding_amt']),
  })).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.record) && /^\d{4}-\d{2}-\d{2}$/.test(row.maturity) && row.amount > 0);
  if (!parsed.length) return { status: 'unavailable', reason: 'The monthly statement returned no securities with a maturity date and amount.' };
  const record = parsed.map((row) => row.record).sort().at(-1);
  const recordTime = Date.parse(`${record}T00:00:00Z`);
  const live = parsed.filter((row) => row.record === record && Date.parse(`${row.maturity}T00:00:00Z`) > recordTime);
  const total = live.reduce((sum, row) => sum + row.amount, 0);
  if (!(total > 0) || live.length < 50) return { status: 'unavailable', reason: `Only ${live.length} unmatured securities on the latest statement.` };
  const within = (days) => live.filter((row) => Date.parse(`${row.maturity}T00:00:00Z`) - recordTime <= days * DAY_MS).reduce((sum, row) => sum + row.amount, 0);
  const weightedYears = live.reduce((sum, row) => sum + (row.amount * ((Date.parse(`${row.maturity}T00:00:00Z`) - recordTime) / (365.25 * DAY_MS))), 0) / total;
  return {
    status: 'calculated',
    asOf: record,
    within12mPercent: round((within(365) / total) * 100, 1),
    within24mPercent: round((within(730) / total) * 100, 1),
    within12mTrillions: round(within(365) / 1e6, 2),
    weightedYearsToMaturity: round(weightedYears, 2),
    securities: live.length,
  };
}

/**
 * Net liquidity on every day the Treasury reports its cash, rather than once a
 * week. The Fed's balance sheet is still weekly, so it is carried forward - but
 * at most seven days, and reverse repo at most four, so a stopped series ends
 * the nowcast instead of freezing into it.
 */
export function dailyNetLiquidity({ fed = [], reverseRepo = [], cash = [] }) {
  const latestAtOrBefore = (points, date, maxDays) => {
    const time = Date.parse(`${date}T00:00:00Z`);
    for (let index = points.length - 1; index >= 0; index -= 1) {
      const pointTime = Date.parse(`${points[index].date}T00:00:00Z`);
      if (pointTime <= time) return time - pointTime <= maxDays * DAY_MS ? points[index].value : null;
    }
    return null;
  };
  const series = cash.flatMap((point) => {
    const fedValue = latestAtOrBefore(fed, point.date, 7);
    const rrpValue = latestAtOrBefore(reverseRepo, point.date, 4);
    if (!Number.isFinite(fedValue) || !Number.isFinite(rrpValue)) return [];
    return [{ date: point.date, value: fedValue - point.value - rrpValue }];
  });
  if (series.length < 30) return { status: 'unavailable', reason: `Needs 30 days on which the Fed balance sheet, reverse repo and cash balance all report; ${series.length} available.` };
  const latest = series.at(-1);
  const month = valueDaysBefore(series, 28);
  return {
    status: 'calculated',
    asOf: latest.date,
    trillions: round(latest.value / 1e6, 3),
    change28Billions: month ? round((latest.value - month.value) / 1000, 1) : null,
    history: series.slice(-120).map((point) => ({ date: point.date, value: round(point.value / 1e6, 4) })),
  };
}

function compose({ auctions, cash, debt, interest, wall, net }) {
  const parts = [];
  if (auctions.state) {
    const detail = auctions.weakTenors.length
      ? ` - ${auctions.weakTenors.join(', ')} ${auctions.weakTenors.length === 1 ? 'was' : 'were'} in the bottom quarter of ${auctions.weakTenors.length === 1 ? 'its' : 'their'} own history`
      : auctions.strongTenors.length ? ` - ${auctions.strongTenors.join(', ')} drew top-quarter demand for ${auctions.strongTenors.length === 1 ? 'its' : 'their'} tenor` : '';
    parts.push(`Treasury auctions show ${auctions.state.toLowerCase()}${detail}`);
  }
  if (Number.isFinite(cash.liquidityEffect28Billions) && Math.abs(cash.liquidityEffect28Billions) >= 50) {
    parts.push(cash.liquidityEffect28Billions < 0
      ? `the Treasury built $${Math.abs(cash.liquidityEffect28Billions)}bn of cash over four weeks, draining that much from bank reserves`
      : `the Treasury ran its cash down by $${cash.liquidityEffect28Billions}bn over four weeks, adding that much to bank reserves`);
  }
  // Stated in full: the cash clause it used to lean on is only written when
  // the move is large, so "over the same span" could refer to nothing.
  if (Number.isFinite(net.change28Billions)) parts.push(`daily net liquidity ${net.change28Billions >= 0 ? 'rose' : 'fell'} $${Math.abs(net.change28Billions)}bn over four weeks`);
  if (Number.isFinite(debt.growth90dAnnualizedPercent) && Number.isFinite(debt.growth1yPercent)) {
    parts.push(`publicly held debt is growing at ${debt.growth90dAnnualizedPercent}% annualized over the last quarter against ${debt.growth1yPercent}% over the year`);
  }
  if (Number.isFinite(interest.change12mPoints)) parts.push(`the average rate on marketable debt is ${interest.averageRate}%, ${interest.change12mPoints >= 0 ? 'up' : 'down'} ${Math.abs(interest.change12mPoints).toFixed(2)} points in a year`);
  if (Number.isFinite(wall.within12mPercent)) parts.push(`${wall.within12mPercent}% of marketable debt matures within twelve months`);
  if (!parts.length) return null;
  const text = parts.join('; ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

export function calculateTreasuryFunding({ auctions = [], cash = [], debt = [], interest = [], maturities = [], fed = [], reverseRepo = [], now = Date.now() } = {}) {
  const cashSeries = cashBalanceSeries(cash);
  const result = {
    auctions: summarizeAuctions(auctions, { now }),
    cash: summarizeCashBalance(cashSeries),
    debt: summarizeDebt(debt),
    interest: summarizeInterestCost(interest),
    wall: summarizeMaturityWall(maturities),
    net: dailyNetLiquidity({ fed, reverseRepo, cash: cashSeries }),
  };
  const published = Object.values(result).filter((part) => part.status !== 'unavailable').length;
  return {
    version: 'treasury-funding-v1',
    status: published === 6 ? 'calculated' : published ? 'provisional' : 'unavailable',
    reason: published ? undefined : 'None of the Treasury Fiscal Data series returned usable data.',
    ...result,
    read: compose(result),
    methodology: `Auction demand ranks each tenor's latest completed auction against its own previous ${HISTORY_AUCTIONS} (a rank needs ${MINIMUM_HISTORY}): bid-to-cover and indirect share count as strength, dealer takedown as weakness. A demand read needs four tenors auctioned within ${RECENT_DAYS} days; three in the bottom quarter is soft, three in the top quarter firm. The cash balance is the Daily Treasury Statement's TGA closing balance, and daily net liquidity is the Fed balance sheet (carried at most seven days) less that balance and overnight reverse repo.`,
    limits: 'Auction tails against the when-issued yield are not measured: the dataset carries no pre-auction market yield, and the prior day’s close is contaminated by the session’s own move. TIPS and floating-rate notes are excluded. The average interest rate lags market yields because it moves only as debt rolls over.',
  };
}

export { STANDARD_TERMS, MINIMUM_HISTORY, HISTORY_AUCTIONS };
