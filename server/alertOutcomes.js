/**
 * What followed each stored alert, scored against the claim it makes.
 *
 * An alert feed with no record is a feed nobody can calibrate: a warning that
 * fires before every quiet month reads exactly as urgently as one that fires
 * before every drawdown. Alerts here do not carry a direction, so each kind is
 * mapped to the claim it implicitly makes, and scored only on that claim:
 *
 *   risk-off     - a macro warning (an un-inverting curve, scarce reserves, a
 *                  draining reverse repo). Right when SPY then did worse than
 *                  its own typical return over the same horizon.
 *   outperform   - a screener breakout. Right when the stock then beat SPY by
 *                  more than it typically does.
 *   eventful     - everything else: a workspace state shift, models dividing,
 *                  a regime near its boundary, a condition clearing. These say
 *                  "look now", not "this way", so the only fair test is
 *                  whether a larger-than-usual move followed.
 *
 * "Typical" is the asset's own unconditional forward return (or absolute move)
 * at the same horizon over the loaded history, so a rising market does not
 * make every bullish alert look right. The entry is the first close after the
 * day the alert was detected - an alert raised mid-session cannot be acted on
 * at that session's close without hindsight. Alerts of one kind that fire
 * within a horizon of each other share most of their outcome window, so the
 * effective sample counts only non-overlapping ones; fewer than 4 publishes no
 * statistics and fewer than 10 is marked thin, as in every track record here.
 */

import { median } from './statistics.js';

export const ALERT_OUTCOMES_VERSION = 'alert-outcomes-v1';
export const ALERT_HORIZONS = [30, 90];
export const BENCHMARK = 'SPY';
const DAY_MS = 86_400_000;
const MINIMUM_EFFECTIVE = 4;
const THIN_EFFECTIVE = 10;

const MACRO_WARNINGS = {
  'curve-uninverted': 'Curve un-inverted',
  'curve-inverted': 'Curve inverted',
  'reserves-tightening': 'Reserves tightening',
  'rrp-exhaustion': 'Reverse repo running out',
  'quarter-end': 'Quarter-end drain',
  'term-premium-repricing': 'Term premium repricing',
};
const MACRO_NOTICES = {
  'regime-borderline': 'Regime near a boundary',
  'regime-overdue': 'Regime overdue',
  'models-divided': 'Macro models divided',
};
const WORKSPACE_ASSETS = {
  'bitcoin-cycle': { asset: 'BTC-USD', label: 'Bitcoin cycle shifts' },
  'dollar-transmission': { asset: 'BTC-USD', label: 'Dollar transmission shifts' },
  'metals-workspace': { asset: 'GC=F', label: 'Metals shifts' },
  'fx-workspace': { asset: 'DX-Y.NYB', label: 'FX shifts' },
  'equity-risk': { asset: BENCHMARK, label: 'Equity risk shifts' },
  'market-heatmap': { asset: BENCHMARK, label: 'Heatmap shifts' },
  'sentiment-snapshot': { asset: BENCHMARK, label: 'Sentiment shifts' },
  'liquidity-states': { asset: BENCHMARK, label: 'Liquidity state shifts' },
};

export const CLAIM_PHRASES = {
  'risk-off': 'SPY then lagged its typical return',
  outperform: 'the stock then beat SPY by more than usual',
  eventful: 'a larger-than-usual move followed',
};

/**
 * @returns {{ group: string, label: string, asset: string, claim: 'risk-off'|'outperform'|'eventful' } | null}
 */
export function claimFor(alert) {
  const modelId = String(alert?.modelId ?? '');
  const key = String(alert?.key ?? '');
  if (modelId.startsWith('macro-alerts')) {
    if (key.endsWith(':resolved')) return { group: 'macro-cleared', label: 'Macro conditions cleared', asset: BENCHMARK, claim: 'eventful' };
    if (MACRO_WARNINGS[key]) return { group: `macro:${key}`, label: MACRO_WARNINGS[key], asset: BENCHMARK, claim: 'risk-off' };
    if (MACRO_NOTICES[key]) return { group: `macro:${key}`, label: MACRO_NOTICES[key], asset: BENCHMARK, claim: 'eventful' };
    return null;
  }
  if (modelId === 'screener-v1') {
    return /^[A-Z0-9.^=-]{1,12}$/.test(key) ? { group: 'screener-breakout', label: 'Screener breakouts', asset: key, claim: 'outperform' } : null;
  }
  const workspace = WORKSPACE_ASSETS[modelId];
  return workspace ? { group: `workspace:${modelId}`, label: workspace.label, asset: workspace.asset, claim: 'eventful' } : null;
}

function dayOf(value) {
  const at = typeof value === 'string' && value.length === 10 ? Date.parse(`${value}T00:00:00Z`) : new Date(value).getTime();
  return Number.isFinite(at) ? Math.floor(at / DAY_MS) : null;
}

/** Points as `{ day, value }`, ascending, one per day, positive values only. */
export function prepareHistory(points) {
  const byDay = new Map();
  for (const point of points ?? []) {
    const day = dayOf(point?.date ?? point?.timestamp);
    const value = Number(point?.value);
    if (day !== null && Number.isFinite(value) && value > 0) byDay.set(day, value);
  }
  return [...byDay.entries()].sort((left, right) => left[0] - right[0]).map(([day, value]) => ({ day, value }));
}

// First index whose day is >= target, or -1.
function firstOnOrAfter(series, target) {
  let low = 0;
  let high = series.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (series[middle].day < target) low = middle + 1;
    else high = middle;
  }
  return low < series.length ? low : -1;
}

// Last index whose day is <= target, or -1.
function lastOnOrBefore(series, target) {
  const index = firstOnOrAfter(series, target + 1);
  return (index === -1 ? series.length : index) - 1;
}

function forwardReturn(series, startIndex, horizon) {
  const end = firstOnOrAfter(series, series[startIndex].day + horizon);
  if (end === -1) return null;
  return { endIndex: end, value: series[end].value / series[startIndex].value - 1 };
}

function benchmarkReturn(benchmark, startDay, endDay) {
  if (!benchmark?.length) return null;
  const start = lastOnOrBefore(benchmark, startDay);
  const end = lastOnOrBefore(benchmark, endDay);
  // A benchmark that has not printed near either date cannot stand in.
  if (start === -1 || end === -1 || startDay - benchmark[start].day > 5 || endDay - benchmark[end].day > 5) return null;
  return benchmark[end].value / benchmark[start].value - 1;
}

/**
 * The asset's unconditional forward outcomes at one horizon: the median
 * return (or excess over the benchmark) and the median absolute move.
 */
export function baseRate(series, horizon, { benchmark = null } = {}) {
  const returns = [];
  for (let index = 0; index < series.length; index += 1) {
    const forward = forwardReturn(series, index, horizon);
    if (!forward) break;
    if (benchmark) {
      const reference = benchmarkReturn(benchmark, series[index].day, series[forward.endIndex].day);
      if (reference === null) continue;
      returns.push(forward.value - reference);
    } else {
      returns.push(forward.value);
    }
  }
  if (returns.length < 60) return null;
  return { median: median(returns), absMedian: median(returns.map(Math.abs)), observations: returns.length };
}

function round(value, places = 2) {
  return Number.isFinite(value) ? Math.round(value * 10 ** places) / 10 ** places : null;
}

function effectiveCount(entryDays, horizon) {
  let count = 0;
  let next = -Infinity;
  for (const day of [...entryDays].sort((left, right) => left - right)) {
    if (day >= next) {
      count += 1;
      next = day + horizon;
    }
  }
  return count;
}

/**
 * @param {{ alerts: Array<{ modelId: string, key: string, text: string, detectedAt: string }>, histories: Map<string, Array>, horizons?: number[], recentLimit?: number }} input
 */
export function scoreAlertOutcomes({ alerts = [], histories = new Map(), horizons = ALERT_HORIZONS, recentLimit = 25 } = {}) {
  const prepared = new Map([...histories.entries()].map(([symbol, points]) => [symbol, prepareHistory(points)]));
  const benchmark = prepared.get(BENCHMARK) ?? [];
  const bases = new Map();
  const baseFor = (asset, claim, horizon) => {
    const cacheKey = `${asset}|${claim}|${horizon}`;
    if (!bases.has(cacheKey)) {
      const series = prepared.get(asset);
      bases.set(cacheKey, series?.length ? baseRate(series, horizon, { benchmark: claim === 'outperform' ? benchmark : null }) : null);
    }
    return bases.get(cacheKey);
  };

  const unscored = new Map();
  const scored = [];
  for (const alert of alerts) {
    const claim = claimFor(alert);
    if (!claim) {
      unscored.set(alert.modelId, (unscored.get(alert.modelId) ?? 0) + 1);
      continue;
    }
    const series = prepared.get(claim.asset);
    const detectedDay = dayOf(alert.detectedAt);
    const entryIndex = series?.length && detectedDay !== null ? firstOnOrAfter(series, detectedDay + 1) : -1;
    const outcomes = horizons.map((horizon) => {
      if (!series?.length) return { horizon, state: 'no-history' };
      if (entryIndex === -1) return { horizon, state: 'pending' };
      const forward = forwardReturn(series, entryIndex, horizon);
      if (!forward) return { horizon, state: 'pending' };
      const base = baseFor(claim.asset, claim.claim, horizon);
      if (!base) return { horizon, state: 'no-base' };
      let value = forward.value;
      if (claim.claim === 'outperform') {
        const reference = benchmarkReturn(benchmark, series[entryIndex].day, series[forward.endIndex].day);
        if (reference === null) return { horizon, state: 'no-base' };
        value -= reference;
      }
      const relative = value - base.median;
      const move = base.absMedian > 0 ? Math.abs(value) / base.absMedian : null;
      const right = claim.claim === 'risk-off' ? relative < 0 : claim.claim === 'outperform' ? relative > 0 : move !== null && move > 1;
      return { horizon, state: 'matured', returnPercent: round(value * 100), relativePercent: round(relative * 100), move: round(move), right };
    });
    scored.push({ alert, claim, entryDay: entryIndex === -1 ? null : series[entryIndex].day, outcomes });
  }

  const groups = new Map();
  for (const entry of scored) {
    const group = groups.get(entry.claim.group) ?? { id: entry.claim.group, label: entry.claim.label, claim: entry.claim.claim, assets: new Set(), entries: [] };
    group.assets.add(entry.claim.asset);
    group.entries.push(entry);
    groups.set(entry.claim.group, group);
  }

  const summaries = [...groups.values()].map((group) => {
    const byHorizon = horizons.map((horizon, index) => {
      const matured = group.entries.filter((entry) => entry.outcomes[index].state === 'matured');
      const pending = group.entries.filter((entry) => entry.outcomes[index].state === 'pending').length;
      const missing = group.entries.length - matured.length - pending;
      const effective = effectiveCount(matured.map((entry) => entry.entryDay), horizon);
      const base = { horizon, alerts: group.entries.length, matured: matured.length, pending, missing, effective };
      if (effective < MINIMUM_EFFECTIVE) {
        return { ...base, status: 'insufficient', reason: `${effective} non-overlapping ${effective === 1 ? 'alert has' : 'alerts have'} a ${horizon}-day outcome; ${MINIMUM_EFFECTIVE} are needed before any rate is shown.` };
      }
      const outcomes = matured.map((entry) => entry.outcomes[index]);
      const rate = outcomes.filter((outcome) => outcome.right).length / outcomes.length;
      // Against a coin flip, judged on the independent count: overlapping
      // alerts repeat one outcome and must not narrow the band.
      const zScore = (rate - 0.5) / Math.sqrt(0.25 / effective);
      return {
        ...base,
        status: effective < THIN_EFFECTIVE ? 'thin' : 'calculated',
        rightRate: round(rate * 100, 0),
        versusChance: zScore >= 2 ? 'above' : zScore <= -2 ? 'below' : 'within',
        medianRelativePercent: round(median(outcomes.map((outcome) => outcome.relativePercent))),
        medianMove: round(median(outcomes.map((outcome) => outcome.move).filter(Number.isFinite))),
      };
    });
    return { id: group.id, label: group.label, claim: group.claim, claimPhrase: CLAIM_PHRASES[group.claim], assets: [...group.assets].sort(), alerts: group.entries.length, horizons: byHorizon };
  }).sort((left, right) => right.alerts - left.alerts || left.label.localeCompare(right.label));

  const recent = [...scored]
    .sort((left, right) => new Date(right.alert.detectedAt) - new Date(left.alert.detectedAt))
    .slice(0, recentLimit)
    .map((entry) => ({
      modelId: entry.alert.modelId,
      key: entry.alert.key,
      text: entry.alert.text,
      detectedAt: entry.alert.detectedAt,
      group: entry.claim.label,
      asset: entry.claim.asset,
      claim: entry.claim.claim,
      outcomes: entry.outcomes,
    }));

  const scoredGroups = summaries.filter((group) => group.horizons.some((horizon) => horizon.status !== 'insufficient'));
  const status = !alerts.length ? 'unavailable' : scoredGroups.length ? 'calculated' : 'provisional';
  return {
    version: ALERT_OUTCOMES_VERSION,
    status,
    reason: !alerts.length ? 'No alerts are stored yet; outcomes are scored once ingestion has raised some.' : undefined,
    horizons,
    alerts: alerts.length,
    scoredAlerts: scored.length,
    unscored: [...unscored.entries()].map(([modelId, count]) => ({ modelId, count })),
    groups: summaries,
    recent,
    read: describeOutcomes(summaries, horizons, alerts.length),
    methodology: `Each alert is scored on the claim it implicitly makes. Macro warnings claim risk-off and are right when SPY then returned less than its own median ${horizons.join('- and ')}-day return; screener breakouts claim outperformance and are right when the stock then beat SPY by more than its median excess; every other alert only says "look now", and is right when the move that followed was larger than the asset's median absolute move. The entry is the first close after the detection day. Alerts of one kind within a horizon of each other share their outcome window, so the effective count keeps only non-overlapping ones: under ${MINIMUM_EFFECTIVE} shows no rate and under ${THIN_EFFECTIVE} is thin. Typical returns are measured over the same loaded history, which includes the alert periods themselves.`,
    limits: 'The record starts when alert storage did: a few months of alerts is a handful of independent outcomes, and a rate from it says little either way. A 50% right rate is what chance produces for every claim here.',
  };
}

function quoted(label) {
  return `\u201c${label}\u201d`;
}

/**
 * Names only what clears chance. Leading with the best-scoring kind would be
 * selection: with several kinds of alert, one will look good by luck.
 */
function describeOutcomes(groups, horizons, total) {
  if (!total) return 'No alerts are stored yet.';
  const index = horizons.length - 1;
  const horizon = horizons[index];
  const rated = groups.filter((group) => group.horizons[index].status !== 'insufficient');
  if (!rated.length) {
    const matured = groups.reduce((sum, group) => sum + group.horizons[0].matured, 0);
    return `${total} stored ${total === 1 ? 'alert' : 'alerts'}, ${matured} with a ${horizons[0]}-day outcome so far; no kind of alert has enough non-overlapping outcomes for a rate yet.`;
  }
  const describe = (group) => `${quoted(group.label)} at ${group.horizons[index].rightRate}% over ${group.horizons[index].effective} independent`;
  const above = rated.filter((group) => group.horizons[index].versusChance === 'above');
  const below = rated.filter((group) => group.horizons[index].versusChance === 'below');
  const rates = rated.map((group) => group.horizons[index].rightRate);
  const parts = [];
  if (above.length) parts.push(`Over ${horizon} days, ${above.map(describe).join('; ')} ${above.length === 1 ? 'is' : 'are'} right more often than chance allows.`);
  if (below.length) parts.push(`${above.length ? 'And' : `Over ${horizon} days,`} ${below.map(describe).join('; ')} ${below.length === 1 ? 'is' : 'are'} wrong more often than chance allows - read as the opposite of the claim.`);
  if (!parts.length) {
    return `Over ${horizon} days, none of the ${rated.length} ${rated.length === 1 ? 'kind' : 'kinds'} of alert with a rate is distinguishable from a coin flip yet: right rates run ${Math.min(...rates)}-${Math.max(...rates)}% on samples this size.`;
  }
  const rest = rated.length - above.length - below.length;
  if (rest) parts.push(rest === 1 ? 'The other kind is within chance.' : `The other ${rest} kinds are within chance.`);
  return parts.join(' ');
}
