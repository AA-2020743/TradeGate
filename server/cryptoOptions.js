import { ordinal, percentileRank } from './statistics.js';

/**
 * What the options market is charging for crypto risk, read the way a desk
 * reads it.
 *
 * Options do not say where price goes. They say what the market will pay to
 * be protected, and against what - which is a statement about positioning and
 * fear, not direction. Four readings carry nearly all of it:
 *
 * - Implied vol at fixed tenors (7, 30, 90 days): the price of uncertainty.
 * - The 25-delta risk reversal: calls minus puts at equal distance from the
 *   money. Negative means downside protection costs more than upside.
 * - The term structure: near tenors above far ones (backwardation) means the
 *   market is pricing something soon.
 * - Implied minus realized: whether options are rich or cheap against what
 *   the asset has actually been doing.
 *
 * Two conventions here are deliberate, and both are where naive summaries go
 * wrong.
 *
 * Listed expiries drift: "the front month" is 29 days out one week and 22 the
 * next, so a raw front-month IV changes when nothing in the market did. Every
 * tenor is therefore constant-maturity, interpolated linearly in total
 * variance (sigma^2 * T) between the two listed expiries that bracket it.
 * Total variance is what is additive in time; interpolating vol directly
 * understates the far tenor whenever the curve is steep.
 *
 * "25-delta" means 25-delta. Picking the listed strike nearest 0.25 compares,
 * on a typical chain, a 0.27-delta call with a 0.31-delta put - two options at
 * different distances from the money, whose IV difference is partly just the
 * smile. The IV is interpolated to exactly +/-0.25 between the bracketing
 * strikes, and an expiry whose chain does not bracket 0.25 publishes nothing
 * rather than extrapolating.
 *
 * Limits, published with it: Deribit only (most of crypto options open
 * interest, not all of it - CME is absent); mark IV is the exchange's own
 * model mark, not a traded quote; open interest is in coins, so put/call
 * ratios are contract counts, not notional.
 */

const TENORS = [7, 30, 90];
// Inside two days an expiry's IV is dominated by pin and gamma effects around
// settlement and says little about the risk being priced for the period ahead.
const MINIMUM_EXPIRY_DAYS = 2;
const DAY_MS = 86_400_000;
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Abramowitz-Stegun 7.1.26 via erf; accurate to ~1e-7, which is far below mark-IV noise. */
function normalCdf(x) {
  const t = 1 / (1 + (0.3275911 * Math.abs(x) / Math.SQRT2));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - (poly * Math.exp(-(x * x) / 2));
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** "BTC-27DEC26-100000-C" -> parts. Deribit options settle at 08:00 UTC. */
export function parseInstrument(name) {
  const parts = String(name ?? '').toUpperCase().split('-');
  if (parts.length !== 4) return null;
  const [currency, expiryText, strikeText, type] = parts;
  const match = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(expiryText);
  const strike = Number(strikeText);
  if (!match || !(match[2] in MONTHS) || !(strike > 0) || (type !== 'C' && type !== 'P')) return null;
  const expiry = Date.UTC(2000 + Number(match[3]), MONTHS[match[2]], Number(match[1]), 8);
  return { currency, expiry, strike, type };
}

/**
 * Forward delta under Black-76. Deribit's book summary carries each expiry's
 * own underlying (the future for that date), so the forward is observed rather
 * than built from a rate assumption - adding a rate on top of it, as a spot
 * Black-Scholes delta would, counts the carry twice.
 */
export function forwardDelta({ forward, strike, years, ivPercent, type }) {
  const sigma = ivPercent / 100;
  if (!(forward > 0) || !(strike > 0) || !(years > 0) || !(sigma > 0)) return null;
  const d1 = (Math.log(forward / strike) + (0.5 * sigma * sigma * years)) / (sigma * Math.sqrt(years));
  const call = normalCdf(d1);
  return type === 'C' ? call : call - 1;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Linear interpolation of y at x between the two points that bracket it; null if none do. */
function bracketInterpolate(points, x) {
  const sorted = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)).sort((left, right) => left.x - right.x);
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const low = sorted[index];
    const high = sorted[index + 1];
    if (low.x <= x && x <= high.x) {
      if (high.x === low.x) return (low.y + high.y) / 2;
      return low.y + ((high.y - low.y) * ((x - low.x) / (high.x - low.x)));
    }
  }
  return null;
}

/** One expiry's smile: ATM, exact 25-delta wings, and the open interest on it. */
export function summarizeExpiry(rows, expiry, now) {
  const years = (expiry - now) / (365 * DAY_MS);
  const forward = median(rows.map((row) => row.underlying));
  if (!(years > 0) || !(forward > 0)) return null;

  const priced = rows
    .filter((row) => row.iv > 0)
    .map((row) => ({ ...row, delta: forwardDelta({ forward, strike: row.strike, years, ivPercent: row.iv, type: row.type }) }))
    .filter((row) => Number.isFinite(row.delta));

  // Out-of-the-money options are where the smile is actually traded; the
  // in-the-money side of each strike adds nothing but wider marks.
  const otm = priced.filter((row) => (row.type === 'C' ? row.strike >= forward : row.strike <= forward));
  const atm = bracketInterpolate(otm.map((row) => ({ x: Math.log(row.strike / forward), y: row.iv })), 0);

  const calls = priced.filter((row) => row.type === 'C' && row.delta > 0.02 && row.delta < 0.98);
  const puts = priced.filter((row) => row.type === 'P' && row.delta < -0.02 && row.delta > -0.98);
  const call25 = bracketInterpolate(calls.map((row) => ({ x: row.delta, y: row.iv })), 0.25);
  const put25 = bracketInterpolate(puts.map((row) => ({ x: row.delta, y: row.iv })), -0.25);

  const callOi = rows.filter((row) => row.type === 'C').reduce((total, row) => total + (row.openInterest || 0), 0);
  const putOi = rows.filter((row) => row.type === 'P').reduce((total, row) => total + (row.openInterest || 0), 0);

  return {
    expiry: new Date(expiry).toISOString(),
    days: round((expiry - now) / DAY_MS, 2),
    forward: round(forward, 2),
    atmIv: round(atm),
    call25Iv: round(call25),
    put25Iv: round(put25),
    riskReversal25: Number.isFinite(call25) && Number.isFinite(put25) ? round(call25 - put25) : null,
    butterfly25: Number.isFinite(call25) && Number.isFinite(put25) && Number.isFinite(atm) ? round(((call25 + put25) / 2) - atm) : null,
    callOpenInterest: round(callOi, 1),
    putOpenInterest: round(putOi, 1),
    strikes: new Set(rows.map((row) => row.strike)).size,
  };
}

/**
 * The strike at which open option holders, taken together, would collect the
 * least at expiry. It is a mechanical reading of open interest - it ignores
 * who is long, premiums paid and how dealers hedge - so it is published as a
 * reference level, never as a target.
 */
export function maxPain(rows) {
  const strikes = [...new Set(rows.filter((row) => row.openInterest > 0).map((row) => row.strike))].sort((a, b) => a - b);
  if (strikes.length < 3) return null;
  let best = null;
  for (const settlement of strikes) {
    let payout = 0;
    for (const row of rows) {
      const intrinsic = row.type === 'C' ? Math.max(0, settlement - row.strike) : Math.max(0, row.strike - settlement);
      payout += intrinsic * (row.openInterest || 0);
    }
    if (!best || payout < best.payout) best = { strike: settlement, payout };
  }
  return best.strike;
}

/**
 * Constant-maturity value at `days`: total variance for vol, linear in time
 * for the wing spreads. Requires an expiry on each side - a tenor outside the
 * listed range is reported missing, not extrapolated off the end of the curve.
 */
export function constantMaturity(expiries, days, field) {
  const usable = expiries.filter((entry) => Number.isFinite(entry[field]) && entry.days >= MINIMUM_EXPIRY_DAYS);
  for (let index = 0; index < usable.length - 1; index += 1) {
    const low = usable[index];
    const high = usable[index + 1];
    if (low.days <= days && days <= high.days) {
      const weight = high.days === low.days ? 0 : (days - low.days) / (high.days - low.days);
      if (field === 'atmIv') {
        const lowVariance = ((low.atmIv / 100) ** 2) * low.days;
        const highVariance = ((high.atmIv / 100) ** 2) * high.days;
        const variance = lowVariance + ((highVariance - lowVariance) * weight);
        // A negative forward variance means the marks are internally
        // inconsistent between the two expiries; refuse rather than print it.
        return variance > 0 ? round(Math.sqrt(variance / days) * 100) : null;
      }
      return round(low[field] + ((high[field] - low[field]) * weight));
    }
  }
  return null;
}

/** Annualized close-to-close realized vol over the last `window` returns. */
export function realizedVolatility(closes, window = 30, periodsPerYear = 365) {
  const values = (closes ?? []).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length < window + 1) return null;
  const returns = [];
  for (let index = values.length - window; index < values.length; index += 1) returns.push(Math.log(values[index] / values[index - 1]));
  const mean = returns.reduce((total, value) => total + value, 0) / returns.length;
  const variance = returns.reduce((total, value) => total + ((value - mean) ** 2), 0) / (returns.length - 1);
  return round(Math.sqrt(variance * periodsPerYear) * 100);
}

function describe({ currency, tenors, termSlope, vrp, ivPercentile, putCall }) {
  const parts = [];
  const rr = tenors.find((tenor) => tenor.days === 30)?.riskReversal25;
  if (Number.isFinite(rr)) {
    if (rr <= -2) parts.push(`downside protection is expensive: 30-day 25-delta puts trade ${Math.abs(rr).toFixed(1)} vol points over the matching calls`);
    else if (rr >= 2) parts.push(`upside is being chased: 30-day 25-delta calls trade ${rr.toFixed(1)} vol points over the matching puts`);
    else parts.push(`the 30-day smile is close to balanced (risk reversal ${rr > 0 ? '+' : ''}${rr.toFixed(1)})`);
  }
  if (Number.isFinite(termSlope)) {
    if (termSlope >= 2) parts.push(`the curve is inverted - 30-day vol sits ${termSlope.toFixed(1)} points above 90-day, so the market is pricing something near-term`);
    else if (termSlope <= -2) parts.push('the curve slopes upward as normal, with no near-term event priced');
  }
  if (Number.isFinite(vrp)) {
    if (vrp >= 10) parts.push(`options are rich: implied runs ${vrp.toFixed(1)} points above what ${currency} has realized`);
    else if (vrp <= -5) parts.push(`options are cheap: implied sits ${Math.abs(vrp).toFixed(1)} points below realized, so protection costs less than recent movement`);
  }
  if (Number.isFinite(ivPercentile)) parts.push(`30-day implied vol is at the ${ordinal(ivPercentile)} percentile of its past year`);
  if (Number.isFinite(putCall) && putCall >= 1.2) parts.push(`puts outnumber calls ${putCall.toFixed(2)} to 1 by open interest`);
  if (!parts.length) return null;
  const text = parts.join('; ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * The full surface for one currency.
 *
 * `summaries` is Deribit's get_book_summary_by_currency result. `closes` are
 * daily closes for the realized-vol comparison. `dvolHistory` is optional:
 * Deribit's own 30-day implied-vol index, used only to place today in its past
 * year, because a single IV level means nothing without its range.
 */
export function calculateCryptoOptionsSurface({ currency, summaries, closes = [], dvolHistory = [], now = Date.now() }) {
  const rows = (summaries ?? []).flatMap((row) => {
    const parsed = parseInstrument(row?.instrument_name);
    if (!parsed || parsed.currency !== currency) return [];
    return [{ ...parsed, iv: Number(row.mark_iv), underlying: Number(row.underlying_price), openInterest: Number(row.open_interest) || 0 }];
  }).filter((row) => row.expiry > now);

  if (rows.length < 20) {
    return { currency, status: 'unavailable', reason: `Needs a populated option chain; ${rows.length} live ${currency} options were returned.` };
  }

  const byExpiry = new Map();
  for (const row of rows) {
    if (!byExpiry.has(row.expiry)) byExpiry.set(row.expiry, []);
    byExpiry.get(row.expiry).push(row);
  }
  const expiries = [...byExpiry.entries()]
    .sort(([left], [right]) => left - right)
    .map(([expiry, chain]) => summarizeExpiry(chain, expiry, now))
    .filter(Boolean);

  const tenors = TENORS.map((days) => ({
    days,
    atmIv: constantMaturity(expiries, days, 'atmIv'),
    riskReversal25: constantMaturity(expiries, days, 'riskReversal25'),
    butterfly25: constantMaturity(expiries, days, 'butterfly25'),
  }));
  const iv30 = tenors.find((tenor) => tenor.days === 30)?.atmIv ?? null;
  const iv90 = tenors.find((tenor) => tenor.days === 90)?.atmIv ?? null;
  const termSlope = Number.isFinite(iv30) && Number.isFinite(iv90) ? round(iv30 - iv90) : null;
  // Any near tenor above the far one is inversion by definition; the size of
  // it is what the slope number is for. A half-point band is treated as flat
  // because mark IVs carry about that much noise between expiries.
  const termShape = !Number.isFinite(termSlope) ? null : termSlope > 0.5 ? 'inverted' : termSlope < -0.5 ? 'upward' : 'flat';
  const realized30 = realizedVolatility(closes, 30);
  const vrp = Number.isFinite(iv30) && Number.isFinite(realized30) ? round(iv30 - realized30) : null;

  const dvolValues = (dvolHistory ?? []).map((point) => Number(point?.value)).filter((value) => value > 0);
  const latestDvol = dvolValues.at(-1) ?? null;
  const ivPercentile = dvolValues.length >= 180 ? percentileRank(dvolValues, latestDvol) : null;

  const callOi = rows.filter((row) => row.type === 'C').reduce((total, row) => total + row.openInterest, 0);
  const putOi = rows.filter((row) => row.type === 'P').reduce((total, row) => total + row.openInterest, 0);
  const putCall = callOi > 0 ? round(putOi / callOi, 3) : null;

  // The expiry that matters for pinning is the one carrying the most open
  // interest within six weeks, not merely the next one - a Friday weekly with
  // a tenth of the quarterly's interest pins nothing.
  const pinCandidates = expiries.filter((entry) => entry.days <= 45 && entry.days >= MINIMUM_EXPIRY_DAYS);
  const pinExpiry = pinCandidates.sort((left, right) => (right.callOpenInterest + right.putOpenInterest) - (left.callOpenInterest + left.putOpenInterest))[0] ?? null;
  const pinStrike = pinExpiry ? maxPain(byExpiry.get(Date.parse(pinExpiry.expiry)) ?? []) : null;

  const published = tenors.filter((tenor) => Number.isFinite(tenor.atmIv)).length;
  const spot = median(rows.filter((row) => (row.expiry - now) / DAY_MS < 10).map((row) => row.underlying)) ?? median(rows.map((row) => row.underlying));

  return {
    currency,
    status: published === TENORS.length ? 'calculated' : published ? 'provisional' : 'unavailable',
    reason: published ? undefined : 'No tenor is bracketed by two listed expiries with a usable at-the-money mark.',
    asOf: new Date(now).toISOString(),
    spot: round(spot, 2),
    tenors,
    termSlope,
    termShape,
    realized30,
    varianceRiskPremium: vrp,
    dvol: { latest: round(latestDvol), percentile: ivPercentile, observations: dvolValues.length },
    putCallOpenInterest: putCall,
    openInterest: { calls: round(callOi, 1), puts: round(putOi, 1), unit: currency },
    pin: pinExpiry && Number.isFinite(pinStrike)
      ? { expiry: pinExpiry.expiry, days: pinExpiry.days, strike: pinStrike, distancePercent: spot > 0 ? round(((pinStrike / spot) - 1) * 100) : null }
      : null,
    expiries: expiries.filter((entry) => entry.days >= MINIMUM_EXPIRY_DAYS),
    read: describe({ currency, tenors, termSlope, vrp, ivPercentile, putCall }),
    methodology: 'Deribit mark IVs. Each tenor is constant-maturity, interpolated in total variance between the two listed expiries that bracket it; expiries inside two days are excluded as settlement noise. 25-delta wings are interpolated to exactly +/-0.25 forward delta (Black-76 on each expiry’s own underlying), and an expiry that does not bracket 0.25 publishes no wing rather than extrapolating. Realized vol is 30-day close-to-close, annualized over 365 days.',
    limits: 'Deribit carries most crypto options open interest but not all - CME is absent. Mark IV is the exchange’s model mark, not a traded price. Open interest is in coins, so the put/call ratio counts contracts rather than notional. The max-pain strike is a mechanical reading of open interest that ignores who is long and how dealers hedge, and is a reference level, not a target.',
  };
}

export { TENORS as OPTION_TENORS, MINIMUM_EXPIRY_DAYS };
