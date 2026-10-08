/**
 * Currency carry: what holding each major currency against the dollar pays,
 * what it risks, and whether high carry has been paid for.
 *
 * Carry is the gap between a currency's 3-month interbank rate and the U.S.
 * rate (OECD series on FRED): hold the higher-yielding currency and that gap
 * accrues whether or not the exchange rate moves. Carry-to-volatility divides
 * it by the pair's realized volatility, so a two-point carry on a calm pair is
 * not mistaken for the same trade as two points on a volatile one.
 *
 * The claim behind carry is that high-yielders, on average, are not marked
 * down by enough to cancel their interest. That is tested monthly: the seven
 * currencies are ranked by carry using only that month's rates, split into
 * high, middle and low, and each group's forward excess return against the
 * dollar - spot change plus the carry earned - is measured over one and
 * three months by the shared track-record evaluator. One observation per
 * group per month, since the currencies in a group share the same dollar. The
 * high-minus-low trade's worst months are listed, because carry is known for
 * paying slowly and losing quickly.
 */

import { evaluateTrackRecord } from './trackRecord.js';
import { median } from './statistics.js';

export const FX_CARRY_VERSION = 'fx-carry-v1';
// `usdPerUnit` is true when the Yahoo quote is dollars per unit of the
// currency (EURUSD); false when it is units per dollar (USDJPY) and is inverted.
export const CARRY_CURRENCIES = [
  { code: 'EUR', name: 'Euro', ticker: 'EURUSD=X', usdPerUnit: true, rateSeries: 'IR3TIB01EZM156N' },
  { code: 'GBP', name: 'Sterling', ticker: 'GBPUSD=X', usdPerUnit: true, rateSeries: 'IR3TIB01GBM156N' },
  { code: 'JPY', name: 'Yen', ticker: 'JPY=X', usdPerUnit: false, rateSeries: 'IR3TIB01JPM156N' },
  { code: 'CHF', name: 'Swiss franc', ticker: 'CHF=X', usdPerUnit: false, rateSeries: 'IR3TIB01CHM156N' },
  { code: 'AUD', name: 'Australian dollar', ticker: 'AUDUSD=X', usdPerUnit: true, rateSeries: 'IR3TIB01AUM156N' },
  { code: 'NZD', name: 'New Zealand dollar', ticker: 'NZDUSD=X', usdPerUnit: true, rateSeries: 'IR3TIB01NZM156N' },
  { code: 'CAD', name: 'Canadian dollar', ticker: 'CAD=X', usdPerUnit: false, rateSeries: 'IR3TIB01CAM156N' },
];
export const US_RATE_SERIES = 'IR3TIB01USM156N';
export const CARRY_GROUPS = [
  { key: 'high', label: 'Highest carry (top two)' },
  { key: 'middle', label: 'Middle three' },
  { key: 'low', label: 'Lowest carry (bottom two)' },
];
const VOL_WINDOW = 63;
// OECD monthly rates land six to ten weeks after the month; older than this
// and the rate no longer describes the carry.
const MAX_RATE_AGE_MONTHS = 4;
const MINIMUM_CURRENCIES = 5;
const MINIMUM_MONTHS = 60;
const HORIZONS = [{ days: 30, months: 1 }, { days: 90, months: 3 }];

function round(value, digits = 2) {
  return Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
}

function monthsBetween(from, to) {
  const [fromYear, fromMonth] = from.split('-').map(Number);
  const [toYear, toMonth] = to.split('-').map(Number);
  return (toYear - fromYear) * 12 + (toMonth - fromMonth);
}

/** Spot as dollars per unit of the currency, whichever way it is quoted. */
export function dollarsPerUnit(points, usdPerUnit) {
  return (points ?? []).filter((point) => point.value > 0).map((point) => ({ date: point.date, value: usdPerUnit ? point.value : 1 / point.value }));
}

function monthEndMap(points) {
  const out = new Map();
  for (const point of [...points].sort((left, right) => left.date.localeCompare(right.date))) out.set(point.date.slice(0, 7), point.value);
  return out;
}

function rateMap(points) {
  return new Map((points ?? []).filter((point) => Number.isFinite(point.value)).map((point) => [String(point.date).slice(0, 7), point.value]));
}

/** Annualized volatility, in percent, of the last `window` daily returns. */
function realizedVol(points, window) {
  const values = points.slice(-(window + 1)).map((point) => point.value);
  if (values.length < window + 1) return null;
  const returns = values.slice(1).map((value, index) => Math.log(value / values[index]));
  const average = returns.reduce((total, value) => total + value, 0) / returns.length;
  const variance = returns.reduce((total, value) => total + (value - average) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * 252) * 100;
}

/**
 * @param {{ spots: Map<string, Array<{date: string, value: number}>>, rates: Map<string, Array<{date: string, value: number}>>, usRate: Array<{date: string, value: number}> }} input
 *   spots keyed by currency code, already in dollars per unit; rates keyed by currency code.
 */
export function calculateFxCarry({ spots, rates, usRate }) {
  const version = FX_CARRY_VERSION;
  const us = rateMap(usRate);
  if (!us.size) return { version, status: 'unavailable', reason: `The U.S. 3-month rate (FRED ${US_RATE_SERIES}) is required.` };
  const latestUs = [...us.keys()].sort().at(-1);
  const excluded = [];
  const currencies = CARRY_CURRENCIES.flatMap((currency) => {
    const spot = spots.get(currency.code) ?? [];
    const rate = rateMap(rates.get(currency.code));
    if (spot.length < VOL_WINDOW + 1) { excluded.push(`${currency.code}: no spot history`); return []; }
    if (!rate.size) { excluded.push(`${currency.code}: no rate (FRED ${currency.rateSeries})`); return []; }
    const latestRate = [...rate.keys()].sort().at(-1);
    if (monthsBetween(latestRate, latestUs) > MAX_RATE_AGE_MONTHS) { excluded.push(`${currency.code}: rate last published ${latestRate}`); return []; }
    return [{ ...currency, spot, rate, latestRate, monthEnds: monthEndMap(spot) }];
  });
  if (currencies.length < MINIMUM_CURRENCIES) {
    return { version, status: 'unavailable', reason: `Carry needs at least ${MINIMUM_CURRENCIES} currencies with spot and rates; ${currencies.length} have both (${excluded.join('; ')}).`, excluded };
  }

  // The latest rate for each leg, carried forward at most MAX_RATE_AGE_MONTHS.
  const rateAt = (map, month) => {
    for (let back = 0; back <= MAX_RATE_AGE_MONTHS; back += 1) {
      const [year, number] = month.split('-').map(Number);
      const index = year * 12 + number - 1 - back;
      const key = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
      if (map.has(key)) return map.get(key);
    }
    return null;
  };

  const months = [...currencies[0].monthEnds.keys()].filter((month) => currencies.every((currency) => currency.monthEnds.has(month))).sort();
  const observations = [];
  const spreads = [];
  months.forEach((month, index) => {
    const usRateNow = rateAt(us, month);
    if (!Number.isFinite(usRateNow)) return;
    const ranked = currencies.map((currency) => ({ currency, carry: rateAt(currency.rate, month) - usRateNow })).filter((entry) => Number.isFinite(entry.carry)).sort((left, right) => right.carry - left.carry);
    if (ranked.length < MINIMUM_CURRENCIES) return;
    const groups = { high: ranked.slice(0, 2), low: ranked.slice(-2), middle: ranked.slice(2, -2) };
    const forwardFor = (members, horizon) => {
      const end = months[index + horizon.months];
      if (!end) return null;
      const values = members.map(({ currency, carry }) => ((currency.monthEnds.get(end) / currency.monthEnds.get(month) - 1) * 100) + (carry * horizon.months) / 12);
      return values.reduce((total, value) => total + value, 0) / values.length;
    };
    for (const group of CARRY_GROUPS) {
      const returns = Object.fromEntries(HORIZONS.map((horizon) => [horizon.days, forwardFor(groups[group.key], horizon)]));
      observations.push({ date: month, label: group.key, returns });
    }
    const high = forwardFor(groups.high, HORIZONS[0]);
    const low = forwardFor(groups.low, HORIZONS[0]);
    if (Number.isFinite(high) && Number.isFinite(low)) spreads.push({ month: months[index + 1], value: high - low, long: groups.high.map((entry) => entry.currency.code), short: groups.low.map((entry) => entry.currency.code) });
  });
  if (spreads.length < MINIMUM_MONTHS) {
    return { version, status: 'unavailable', reason: `The currencies share ${spreads.length} months of spot and rates; ${MINIMUM_MONTHS} are needed.`, excluded };
  }
  const record = evaluateTrackRecord({ observations, order: CARRY_GROUPS, horizons: HORIZONS.map((horizon) => ({ days: horizon.days, sessions: horizon.months * 21 })), stepDays: 30 });

  const usNow = us.get(latestUs);
  const rows = currencies.map((currency) => {
    const rateNow = currency.rate.get(currency.latestRate);
    const carry = rateNow - usNow;
    const vol = realizedVol(currency.spot, VOL_WINDOW);
    const last = currency.spot.at(-1);
    const quarterAgo = currency.spot.at(-64);
    return {
      code: currency.code,
      name: currency.name,
      rate: round(rateNow),
      rateMonth: currency.latestRate,
      carry: round(carry),
      volatility: round(vol, 1),
      carryToVol: Number.isFinite(vol) && vol > 0 ? round(carry / vol) : null,
      spotChange3m: quarterAgo ? round((last.value / quarterAgo.value - 1) * 100, 1) : null,
      spotDate: last.date,
    };
  }).sort((left, right) => right.carry - left.carry);
  rows.forEach((row, index) => { row.group = index < 2 ? 'high' : index >= rows.length - 2 ? 'low' : 'middle'; });

  const spreadValues = spreads.map((entry) => entry.value);
  const annualized = (spreadValues.reduce((total, value) => total + value, 0) / spreadValues.length) * 12;
  const sd = Math.sqrt(spreadValues.reduce((total, value) => total + (value - annualized / 12) ** 2, 0) / (spreadValues.length - 1)) * Math.sqrt(12);
  const high = rows.filter((row) => row.group === 'high');
  const low = rows.filter((row) => row.group === 'low');
  const result = {
    version,
    status: 'calculated',
    usRate: round(usNow),
    usRateMonth: latestUs,
    currencies: rows,
    excluded,
    trade: {
      long: high.map((row) => row.code),
      short: low.map((row) => row.code),
      carry: round(high.reduce((total, row) => total + row.carry, 0) / high.length - low.reduce((total, row) => total + row.carry, 0) / low.length),
    },
    spreadHistory: {
      months: spreads.length,
      from: spreads[0].month,
      to: spreads.at(-1).month,
      annualReturn: round(annualized, 1),
      annualVolatility: round(sd, 1),
      sharpe: sd > 0 ? round(annualized / sd) : null,
      medianMonth: round(median(spreadValues)),
      worstMonths: [...spreads].sort((left, right) => left.value - right.value).slice(0, 3).map((entry) => ({ month: entry.month, value: round(entry.value, 1), long: entry.long, short: entry.short })),
    },
    record: record.status === 'calculated' ? { ...record, readHorizonDays: 90, limits: 'Descriptive, not predictive. Seven currencies over one decade; each group counts once per month because its members share the dollar leg, and a single central bank can move a two-currency group.' } : record,
  };
  return {
    ...result,
    read: describeCarry(result),
    methodology: `Carry is each currency’s OECD 3-month interbank rate less the U.S. rate (FRED IR3TIB01 series, monthly). Volatility is the annualized standard deviation of ${VOL_WINDOW} daily log changes of the pair against the dollar (Yahoo). Track record: at each month-end the currencies are ranked by that month’s carry, the top two and bottom two form the high and low groups, and each group’s equal-weighted return against the dollar - spot change plus carry earned - is measured over the next one and three months. The high-minus-low figures are the monthly difference between the two groups.`,
    limits: 'Interbank rates are not the forward points a trader would earn, and OECD publishes them weeks late, so the carry shown can be a month or two old. Seven currencies make thin groups, rebalanced monthly before costs. Carry trades lose in risk-off bursts that a decade may hold only a few of; the worst months are listed for that reason.',
  };
}

function signed(value, unit = '%') {
  return `${value > 0 ? '+' : ''}${value}${unit}`;
}

function describeCarry(result) {
  const top = result.currencies[0];
  const bottom = result.currencies.at(-1);
  const parts = [`Against a U.S. 3-month rate of ${result.usRate}%, the ${top.code} pays the most carry (${signed(top.carry, ' pts')}, ${top.carryToVol} per unit of volatility) and the ${bottom.code} the least (${signed(bottom.carry, ' pts')})`];
  parts.push(`long ${result.trade.long.join(' and ')} against ${result.trade.short.join(' and ')} earns ${result.trade.carry} points a year of carry before any move in the exchange rates`);
  const history = result.spreadHistory;
  let record = ` Since ${history.from.slice(0, 4)}, that high-minus-low trade, rebalanced monthly, returned ${signed(history.annualReturn)} a year at ${history.annualVolatility}% volatility; its worst month was ${history.worstMonths[0].value}% in ${history.worstMonths[0].month}.`;
  const horizon = result.record?.horizons?.find((entry) => entry.days === 90);
  const high = horizon?.states.find((state) => state.key === 'high');
  const low = horizon?.states.find((state) => state.key === 'low');
  if (Number.isFinite(high?.heldOut.stats.median) && Number.isFinite(low?.heldOut.stats.median)) {
    record += ` In the held-out months since ${result.record.holdoutFrom}, the high-carry group was followed over three months by a median ${signed(high.heldOut.stats.median)} against the dollar, the low group by ${signed(low.heldOut.stats.median)}.`;
  }
  return `${parts.join('; ')}.${record}`;
}
