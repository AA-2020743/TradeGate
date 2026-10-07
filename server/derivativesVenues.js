import { percentileRank } from './statistics.js';

/**
 * Perpetual funding and open interest from whichever venues answer.
 *
 * Every crypto derivatives venue restricts some region: Binance's futures API
 * answers US addresses with 451, and Bybit's CDN refuses some cloud ranges
 * with 403. The funding leg used to fetch its venues together and fail as a
 * unit, so one blocked venue removed BTC funding entirely even though the
 * code below the fetch was written to work from a single venue. Each venue is
 * now its own result, and the read says which ones it was built from.
 *
 * All three quote BTC perpetual funding per eight hours, so the rates are
 * directly comparable; the spread between them is published, because venues
 * disagreeing by more than a few basis points is itself a positioning signal.
 */

const PERIODS_PER_YEAR = 3 * 365;

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const annualized = (rate) => round(rate * PERIODS_PER_YEAR * 100);

/**
 * `venues` maps a venue name to its current 8h rate or an Error. `history` is
 * the longest per-venue funding history that answered, as { venue, rates }.
 */
export function combineFundingVenues({ venues = {}, history = null }) {
  const answered = Object.entries(venues).filter(([, value]) => Number.isFinite(value));
  const failed = Object.entries(venues).filter(([, value]) => !Number.isFinite(value)).map(([venue, value]) => ({ venue, reason: value instanceof Error ? value.message : 'no rate returned' }));
  if (!answered.length) {
    const error = new Error(`No funding venue responded: ${failed.map((entry) => `${entry.venue} (${entry.reason})`).join('; ')}`);
    error.failedVenues = failed;
    throw error;
  }
  const rates = answered.map(([, value]) => value);
  const aggregate = rates.reduce((total, value) => total + value, 0) / rates.length;
  const historical = (history?.rates ?? []).filter(Number.isFinite);
  return {
    // Field names the cycle and verdict models already read.
    binanceRate: Number.isFinite(venues.binance) ? venues.binance : null,
    bybitRate: Number.isFinite(venues.bybit) ? venues.bybit : null,
    okxRate: Number.isFinite(venues.okx) ? venues.okx : null,
    venues: answered.length,
    venueRates: Object.fromEntries(answered.map(([venue, value]) => [venue, { rate8h: value, annualizedPercent: annualized(value) }])),
    failedVenues: failed,
    aggregate8h: aggregate,
    annualizedPercent: annualized(aggregate),
    dispersionAnnualizedPercent: rates.length > 1 ? annualized(Math.max(...rates) - Math.min(...rates)) : null,
    // The percentile ranks the cross-venue average against one venue's own
    // history, which is the honest best available: no venue publishes the
    // average's history. The venue is named so the comparison is visible.
    percentile: historical.length > 60 ? percentileRank(historical, aggregate) : null,
    historyVenue: historical.length ? history.venue : null,
    observations: historical.length,
    windowDays: Math.round(historical.length / 3),
  };
}

/**
 * OKX publishes daily open interest in dollars only. The quadrant model reads
 * an implied price from notional over contracts, so the coin-equivalent is
 * rebuilt from the same day's close: open interest in BTC = USD / close.
 * Days missing either side are dropped rather than carried.
 */
export function okxPositioningRows({ openInterest = [], candles = [] }) {
  const closes = new Map(candles.map((row) => [String(row[0]), Number(row[4])]));
  return openInterest
    .map((row) => ({ time: Number(row[0]), usd: Number(row[1]), close: closes.get(String(row[0])) }))
    .filter((row) => Number.isFinite(row.time) && row.usd > 0 && row.close > 0)
    .sort((left, right) => left.time - right.time)
    .map((row) => ({ openInterest: row.usd / row.close, openInterestValue: row.usd, date: new Date(row.time).toISOString().slice(0, 10) }));
}
