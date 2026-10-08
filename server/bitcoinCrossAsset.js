/**
 * What bitcoin is trading as: a leveraged tech stock, a gold substitute, or
 * neither.
 *
 * Rolling correlations of daily returns with the Nasdaq-100 (QQQ) and gold
 * (GLD) over 90 and 252 sessions, on QQQ's trading days. Bitcoin's Yahoo close
 * is stamped at the end of the UTC day, four hours after the U.S. close, so a
 * date's two closes are near enough to compare; a weekend's bitcoin move
 * folds into Monday, as an equity's weekend news does.
 *
 * The regime is a label on the 90-session correlations. What it is worth is
 * tested on the days that matter for it: on every session the Nasdaq fell 2%
 * or more, how bitcoin moved, grouped by the regime it was in the session
 * before - so the label is never informed by the day it is judged on.
 */

import { median, ordinal } from './statistics.js';

export const BITCOIN_CROSS_ASSET_VERSION = 'bitcoin-cross-asset-v1';
const SHORT_WINDOW = 90;
const LONG_WINDOW = 252;
const STRESS_DAY_PERCENT = -2;
const MINIMUM_SESSIONS = LONG_WINDOW * 2;
export const BITCOIN_REGIMES = [
  { key: 'risk', label: 'Trading as a risk asset' },
  { key: 'gold', label: 'Trading with gold' },
  { key: 'own', label: 'Trading on its own' },
  { key: 'mixed', label: 'Mixed' },
];

function round(value, digits = 2) {
  return Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
}

function moments(left, right) {
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
  return { cov, varLeft, varRight };
}

export function correlation(left, right) {
  const { cov, varLeft, varRight } = moments(left, right);
  return varLeft > 0 && varRight > 0 ? cov / Math.sqrt(varLeft * varRight) : null;
}

/** Slope of `dependent` on `driver`. */
export function beta(dependent, driver) {
  const { cov, varRight } = moments(dependent, driver);
  return varRight > 0 ? cov / varRight : null;
}

/** 95% range of a sample correlation, by Fisher's z. */
export function correlationRange(value, n) {
  if (!Number.isFinite(value) || n <= 3) return null;
  const z = Math.atanh(Math.max(-0.999999, Math.min(0.999999, value)));
  const half = 1.96 / Math.sqrt(n - 3);
  return [Math.tanh(z - half), Math.tanh(z + half)];
}

export function classifyRegime(nasdaq, gold) {
  if (!Number.isFinite(nasdaq) || !Number.isFinite(gold)) return null;
  if (nasdaq >= 0.4) return 'risk';
  if (gold >= 0.3 && nasdaq < 0.3) return 'gold';
  if (nasdaq < 0.2 && gold < 0.2) return 'own';
  return 'mixed';
}

/**
 * @param {{ bitcoin: Array<{date: string, value: number}>, nasdaq: Array<{date: string, value: number}>, gold: Array<{date: string, value: number}> }} input
 */
export function calculateBitcoinCrossAsset({ bitcoin, nasdaq, gold }) {
  const version = BITCOIN_CROSS_ASSET_VERSION;
  const byDate = (points) => new Map((points ?? []).filter((point) => point.value > 0).map((point) => [point.date, point.value]));
  const btc = byDate(bitcoin);
  const qqq = byDate(nasdaq);
  const gld = byDate(gold);
  const axis = [...qqq.keys()].filter((date) => btc.has(date) && gld.has(date)).sort();
  if (axis.length - 1 < MINIMUM_SESSIONS) {
    return { version, status: 'unavailable', reason: `Bitcoin, QQQ and GLD share ${Math.max(0, axis.length - 1)} sessions; ${MINIMUM_SESSIONS} are needed.` };
  }
  const returnsOf = (map) => axis.slice(1).map((date, index) => (map.get(date) / map.get(axis[index]) - 1) * 100);
  const btcReturns = returnsOf(btc);
  const qqqReturns = returnsOf(qqq);
  const gldReturns = returnsOf(gld);
  const dates = axis.slice(1);

  const rolling = (window) => dates.map((_date, index) => {
    if (index + 1 < window) return null;
    const from = index + 1 - window;
    const slice = (values) => values.slice(from, index + 1);
    return { nasdaq: correlation(slice(btcReturns), slice(qqqReturns)), gold: correlation(slice(btcReturns), slice(gldReturns)) };
  });
  const short = rolling(SHORT_WINDOW);
  const long = rolling(LONG_WINDOW);
  const labels = short.map((entry) => (entry ? classifyRegime(entry.nasdaq, entry.gold) : null));

  const last = dates.length - 1;
  const current = short[last];
  const currentLong = long[last];
  const regime = labels[last];
  const pastShort = short.filter(Boolean).map((entry) => entry.nasdaq);
  const percentile = Math.round((pastShort.filter((value) => value <= current.nasdaq).length / pastShort.length) * 100);
  let runStart = last;
  while (runStart > 0 && labels[runStart - 1] === regime) runStart -= 1;

  const yearFrom = dates.length - LONG_WINDOW;
  const yearBtc = btcReturns.slice(yearFrom);
  const yearQqq = qqqReturns.slice(yearFrom);
  const side = (keep) => {
    const pairs = yearQqq.map((value, index) => [yearBtc[index], value]).filter(([, value]) => keep(value));
    return pairs.length >= 30 ? beta(pairs.map(([value]) => value), pairs.map(([, value]) => value)) : null;
  };

  // Every Nasdaq stress day, judged by the regime of the session before it.
  const stress = [];
  for (let index = 1; index < dates.length; index += 1) {
    if (qqqReturns[index] <= STRESS_DAY_PERCENT && labels[index - 1]) stress.push({ date: dates[index], regime: labels[index - 1], nasdaq: qqqReturns[index], bitcoin: btcReturns[index] });
  }
  const summarize = (members) => ({
    days: members.length,
    medianBitcoin: round(median(members.map((day) => day.bitcoin)), 1),
    medianNasdaq: round(median(members.map((day) => day.nasdaq)), 1),
    fellShare: members.length ? round(members.filter((day) => day.bitcoin < 0).length / members.length * 100, 0) : null,
  });
  const stressByRegime = BITCOIN_REGIMES.map((entry) => ({ key: entry.key, label: entry.label, ...summarize(stress.filter((day) => day.regime === entry.key)) }));

  const monthly = labels.filter((_label, index) => index >= SHORT_WINDOW - 1 && (last - index) % 21 === 0);
  const timeInRegime = BITCOIN_REGIMES.map((entry) => ({ key: entry.key, label: entry.label, sharePercent: round(monthly.filter((label) => label === entry.key).length / monthly.length * 100, 0) }));

  const result = {
    version,
    status: 'calculated',
    date: dates[last],
    from: dates[SHORT_WINDOW - 1],
    sessions: dates.length,
    regime,
    regimeLabel: BITCOIN_REGIMES.find((entry) => entry.key === regime)?.label ?? null,
    regimeSince: dates[runStart],
    correlations: {
      nasdaq: { short: round(current.nasdaq), shortRange: correlationRange(current.nasdaq, SHORT_WINDOW)?.map((value) => round(value)), long: round(currentLong.nasdaq), percentile },
      gold: { short: round(current.gold), shortRange: correlationRange(current.gold, SHORT_WINDOW)?.map((value) => round(value)), long: round(currentLong.gold) },
    },
    betaToNasdaq: { year: round(beta(yearBtc, yearQqq)), downDays: round(side((value) => value < 0)), upDays: round(side((value) => value > 0)) },
    stressDayPercent: STRESS_DAY_PERCENT,
    stress: { all: summarize(stress), byRegime: stressByRegime, otherRegimes: summarize(stress.filter((day) => day.regime !== regime)), latest: stress.slice(-5).reverse().map((day) => ({ ...day, nasdaq: round(day.nasdaq, 1), bitcoin: round(day.bitcoin, 1) })) },
    timeInRegime,
    windows: { short: SHORT_WINDOW, long: LONG_WINDOW },
    history: dates.map((date, index) => (short[index] ? { date, nasdaq: round(short[index].nasdaq), gold: round(short[index].gold), regime: labels[index] } : null)).filter(Boolean).filter((_point, index, all) => (all.length - 1 - index) % 5 === 0),
  };
  return {
    ...result,
    read: describeBitcoinCrossAsset(result),
    methodology: `Daily returns on the sessions bitcoin (BTC-USD), the Nasdaq-100 (QQQ) and gold (GLD) share. Correlations over ${SHORT_WINDOW} and ${LONG_WINDOW} sessions; the 95% range is Fisher’s z. The regime reads the ${SHORT_WINDOW}-session correlations: Nasdaq 0.4 or more is a risk asset; gold 0.3 or more with Nasdaq under 0.3 is trading with gold; both under 0.2 is on its own; anything else is mixed. Up- and down-day betas are slopes on the year’s QQQ up and down sessions. Stress days are sessions QQQ fell ${Math.abs(STRESS_DAY_PERCENT)}% or more, grouped by the regime of the session before.`,
    limits: 'Bitcoin’s close is stamped four hours after the U.S. close, which mutes daily correlation a little. Correlation regimes shift without warning, and a 90-session correlation carries a wide range - shown beside it. Stress days cluster in a few sell-offs, so the day counts overstate how many independent episodes there were.',
  };
}

function signed(value) {
  return `${value > 0 ? '+' : ''}${value}%`;
}

function describeBitcoinCrossAsset(result) {
  const { nasdaq, gold } = result.correlations;
  const regimeText = { risk: 'traded as a risk asset', gold: 'traded with gold', own: 'traded on its own', mixed: 'traded with no clear partner' }[result.regime];
  const parts = [`Over the last ${result.windows.short} sessions bitcoin ${regimeText}: correlation ${nasdaq.short} with the Nasdaq-100 (95% range ${nasdaq.shortRange[0]} to ${nasdaq.shortRange[1]}, the ${ordinal(nasdaq.percentile)} percentile since ${result.from.slice(0, 4)}) and ${gold.short} with gold`];
  const { year, downDays, upDays } = result.betaToNasdaq;
  if (Number.isFinite(year)) {
    let betaText = `its beta to QQQ over the year is ${year}`;
    if (Number.isFinite(downDays) && Number.isFinite(upDays)) betaText += ` (${downDays} on the Nasdaq’s down days, ${upDays} on its up days)`;
    parts.push(betaText);
  }
  let stressText = '';
  const here = result.stress.byRegime.find((entry) => entry.key === result.regime);
  const other = result.stress.otherRegimes;
  if (here?.days >= 5) {
    stressText = ` On the ${here.days} days the Nasdaq fell ${Math.abs(result.stressDayPercent)}% or more while bitcoin ${regimeText}, its median move was ${signed(here.medianBitcoin)} and it fell on ${here.fellShare}% of them`;
    if (other.days >= 5) stressText += `; on the ${other.days} such days in its other regimes, ${signed(other.medianBitcoin)} and ${other.fellShare}%`;
    stressText += '.';
  }
  return `${parts.join('; ')}.${stressText}`;
}
