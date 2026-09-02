import { ordinal, percentileRank } from './statistics.js';

/**
 * How much to buy, as a function of how expensive the thing already is.
 *
 * Flat dollar-cost averaging buys the same amount every period and therefore
 * buys the most units when price is low purely by accident. This makes that
 * accident deliberate: it places today inside the asset's own risk history and
 * scales the contribution up when the asset is cheap against itself and down
 * when it is stretched. It is a spending rule, not a forecast - it says
 * nothing about where price goes next, only where it sits relative to where it
 * has been.
 *
 * The rule never says sell and never goes to zero. Every tier keeps buying,
 * because the whole point of an accumulation schedule is that it survives
 * being wrong about the level; a rule that stops at a high and never restarts
 * is a market call wearing a schedule's clothing.
 *
 * Three risk components, all derived from price, because price is the one
 * input every asset here has:
 *
 * - Stretch above the one-year mean.
 * - Position against the three-year running high.
 * - One-year momentum.
 *
 * Each is ranked against its own history, so "80th percentile" means the same
 * thing for bitcoin as for platinum even though their raw volatilities differ
 * by an order of magnitude. They are *not* independent: all three rise
 * together in a sustained advance, so agreement between them is one piece of
 * evidence seen three ways, not three confirmations. That is why the ladder is
 * gentle - a 1.75x to 0.25x range rather than 5x to 0x.
 *
 * Realized volatility is deliberately excluded. High volatility marks both
 * blow-off tops and capitulation lows, so its direction depends on an unstated
 * horizon; assigning it a sign would be asserting a view the measure cannot
 * support.
 *
 * Windows are stated in calendar days and converted to sessions per asset from
 * that asset's own observation spacing. A fixed session count would mean seven
 * years for a market that trades five days a week and under five for one that
 * trades seven, so "one year" would silently mean different things for bitcoin
 * and for the S&P.
 */

const WINDOW_DAYS = {
  trend: 365,
  momentum: 365,
  drawdown: 1095,
  rank: 2555,
};

const COMPONENTS = [
  { key: 'stretch', label: 'Stretch above the 1Y mean', phrase: 'its stretch above the 1Y mean', weight: 0.35, high: 'unusually far above its own average', mid: 'close to its usual distance from its own average', low: 'unusually far below its own average' },
  { key: 'drawdown', label: 'Position vs the 3Y high', phrase: 'its position against the 3Y high', weight: 0.35, high: 'unusually close to its three-year high', mid: 'a normal distance below its three-year high', low: 'unusually far below its three-year high' },
  { key: 'momentum', label: '1Y momentum', phrase: 'its 1Y momentum', weight: 0.3, high: 'a strong year by its own standards', mid: 'an ordinary year by its own standards', low: 'a weak year by its own standards' },
];

/**
 * The wording has to grade with the reading. A component at the 64th
 * percentile is not "at its high", and describing it that way would put a
 * confident sentence on an unremarkable number.
 */
function describeComponent(component) {
  if (component.percentile >= 70) return component.high;
  if (component.percentile <= 30) return component.low;
  return component.mid;
}

/**
 * The ladder. The five multiples average exactly 1.0, so an asset whose risk
 * is spread evenly across the tiers spends the same as flat dollar-cost
 * averaging over the same period. Without that constraint the schedule could
 * beat the flat baseline simply by deploying more money, and the comparison
 * below would be measuring the budget rather than the rule.
 */
const TIERS = [
  { max: 20, key: 'deep', label: 'Deep value', multiple: 1.75 },
  { max: 40, key: 'discount', label: 'Discounted', multiple: 1.4 },
  { max: 60, key: 'baseline', label: 'Baseline', multiple: 1 },
  { max: 80, key: 'extended', label: 'Extended', multiple: 0.6 },
  { max: Infinity, key: 'stretched', label: 'Stretched', multiple: 0.25 },
];

/** A weekly cadence, because that is how a schedule is actually run. */
const CADENCE_SESSIONS_PER_WEEK = 7;
const MINIMUM_RANK_OBSERVATIONS = 250;
const MINIMUM_COVERAGE = 0.5;

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function rollingMean(values, window) {
  const out = new Array(values.length).fill(null);
  if (window < 1) return out;
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= window) sum -= values[index - window];
    if (index >= window - 1) out[index] = sum / window;
  }
  return out;
}

function rollingMax(values, window) {
  const out = new Array(values.length).fill(null);
  for (let index = 0; index < values.length; index += 1) {
    const start = Math.max(0, index - window + 1);
    // Only publish once the window is actually full: a "three-year high" drawn
    // from eight months of history is not one, and it would read as a deeper
    // discount than the data supports.
    if (index < window - 1) continue;
    let highest = -Infinity;
    for (let scan = start; scan <= index; scan += 1) if (values[scan] > highest) highest = values[scan];
    out[index] = highest;
  }
  return out;
}

function trailingChange(values, window) {
  const out = new Array(values.length).fill(null);
  for (let index = window; index < values.length; index += 1) {
    const base = values[index - window];
    if (base > 0) out[index] = (values[index] / base) - 1;
  }
  return out;
}

/**
 * The measured series, computed once and shared by the live read and the
 * backtest. They must come from the same code: a schedule whose published tier
 * is derived differently from the tier its own history was scored with is
 * reporting two different numbers for the same quantity.
 */
export function prepareAccumulationSeries(points) {
  const usable = (points ?? [])
    .filter((point) => Number.isFinite(point?.value) && point.value > 0 && point?.date)
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));
  if (usable.length < MINIMUM_RANK_OBSERVATIONS) {
    return { status: 'unavailable', reason: `Needs ${MINIMUM_RANK_OBSERVATIONS} usable closes to rank today against its own history; ${usable.length} available.`, observations: usable.length };
  }

  // Observation density over the actual span, not the median gap between two
  // consecutive rows. The median gap for a weekday market is one day - the
  // weekend shows up in a minority of the gaps and the median discards it - so
  // ranking by median spacing would have made "one year" mean 365 sessions,
  // which is seventeen calendar months of trading days.
  const spanDays = (new Date(usable.at(-1).date) - new Date(usable[0].date)) / 86_400_000;
  const perDay = spanDays > 0 ? (usable.length - 1) / spanDays : 1;
  const sessionsFor = (days) => Math.max(2, Math.round(days * perDay));
  const sessions = {
    trend: sessionsFor(WINDOW_DAYS.trend),
    momentum: sessionsFor(WINDOW_DAYS.momentum),
    drawdown: sessionsFor(WINDOW_DAYS.drawdown),
    rank: sessionsFor(WINDOW_DAYS.rank),
  };

  const values = usable.map((point) => point.value);
  const trend = rollingMean(values, sessions.trend);
  const high = rollingMax(values, sessions.drawdown);
  const momentum = trailingChange(values, sessions.momentum);

  return {
    status: 'ready',
    dates: usable.map((point) => String(point.date)),
    values,
    spacingDays: round(perDay > 0 ? 1 / perDay : 1, 3),
    sessionsPerYear: Math.round(365 * perDay),
    sessions,
    observations: values.length,
    series: {
      stretch: values.map((value, index) => (Number.isFinite(trend[index]) && trend[index] > 0 ? (value / trend[index]) - 1 : null)),
      // Distance below the running high, as a fraction. Zero at the high,
      // negative beneath it - so a higher rank is a higher price, which is the
      // same polarity as the other two components.
      drawdown: values.map((value, index) => (Number.isFinite(high[index]) && high[index] > 0 ? (value / high[index]) - 1 : null)),
      momentum,
    },
  };
}

function tierFor(risk) {
  return TIERS.find((tier) => risk <= tier.max) ?? TIERS.at(-1);
}

/**
 * The risk read at one point in the history, using only what was known then.
 *
 * Every rank is taken from the window ending at `index`, never from the full
 * series, so this is safe to call inside the backtest without leaking the
 * future into a past decision. The single quantity taken from the whole
 * series is the observation density used to size the windows, which is a
 * calendar property of the market rather than a price - a market that trades
 * five days a week did so before and after any given session.
 */
export function riskAt(prepared, index) {
  if (prepared?.status !== 'ready' || index < 0 || index >= prepared.values.length) return null;
  const start = Math.max(0, index - prepared.sessions.rank + 1);

  const components = COMPONENTS.map((component) => {
    const window = prepared.series[component.key].slice(start, index + 1).filter(Number.isFinite);
    const value = prepared.series[component.key][index];
    const percentile = window.length >= MINIMUM_RANK_OBSERVATIONS ? percentileRank(window, value) : null;
    return {
      key: component.key,
      label: component.label,
      phrase: component.phrase,
      weight: component.weight,
      description: Number.isFinite(percentile) ? describeComponent({ ...component, percentile }) : null,
      value: round(Number.isFinite(value) ? value * 100 : null),
      percentile,
      rankedAgainst: window.length,
      reason: Number.isFinite(percentile)
        ? undefined
        : window.length < MINIMUM_RANK_OBSERVATIONS
          ? `Needs ${MINIMUM_RANK_OBSERVATIONS} prior readings to rank; ${window.length} available.`
          : 'The history of this measure has no usable spread to rank against.',
    };
  });

  const available = components.filter((component) => Number.isFinite(component.percentile));
  const availableWeight = available.reduce((total, component) => total + component.weight, 0);
  const totalWeight = COMPONENTS.reduce((total, component) => total + component.weight, 0);
  const coverage = availableWeight / totalWeight;
  if (coverage < MINIMUM_COVERAGE) {
    return { status: 'unavailable', reason: `Only ${Math.round(coverage * 100)}% of the risk components could be ranked here.`, components, coverage: round(coverage, 3) };
  }

  const risk = Math.round(available.reduce((total, component) => total + (component.percentile * component.weight), 0) / availableWeight);
  const tier = tierFor(risk);
  return { status: 'calculated', risk, tier, coverage: round(coverage, 3), components };
}

/**
 * The risk read the asset would carry at a different price today.
 *
 * Same windows, same history, same ranking - only the latest close is swapped.
 * The three components all move with price (a higher close is further above
 * the mean, closer to the high, and a stronger year), so the blended read is
 * monotonic in price and can be inverted by search.
 */
export function riskAtPrice(prepared, price) {
  if (prepared?.status !== 'ready' || !(price > 0)) return null;
  const index = prepared.values.length - 1;
  const { values, sessions } = prepared;
  if (index < Math.max(sessions.trend, sessions.momentum)) return null;

  // The candidate close is part of its own averages and its own running high,
  // so both are rebuilt around it rather than reused from the real close.
  let trendSum = 0;
  for (let scan = index - sessions.trend + 1; scan < index; scan += 1) trendSum += values[scan];
  const trendMean = (trendSum + price) / sessions.trend;

  let priorHigh = -Infinity;
  const highStart = index - sessions.drawdown + 1;
  if (highStart >= 0) for (let scan = highStart; scan < index; scan += 1) if (values[scan] > priorHigh) priorHigh = values[scan];
  const momentumBase = values[index - sessions.momentum];

  const candidate = {
    stretch: trendMean > 0 ? (price / trendMean) - 1 : null,
    drawdown: Number.isFinite(priorHigh) ? (price / Math.max(priorHigh, price)) - 1 : null,
    momentum: momentumBase > 0 ? (price / momentumBase) - 1 : null,
  };

  const start = Math.max(0, index - sessions.rank + 1);
  const available = [];
  for (const component of COMPONENTS) {
    const value = candidate[component.key];
    if (!Number.isFinite(value)) continue;
    const window = prepared.series[component.key].slice(start, index).filter(Number.isFinite);
    if (window.length < MINIMUM_RANK_OBSERVATIONS) continue;
    const percentile = percentileRank([...window, value], value);
    if (Number.isFinite(percentile)) available.push({ ...component, percentile });
  }
  const weight = available.reduce((total, component) => total + component.weight, 0);
  const totalWeight = COMPONENTS.reduce((total, component) => total + component.weight, 0);
  if (weight / totalWeight < MINIMUM_COVERAGE) return null;
  return Math.round(available.reduce((total, component) => total + (component.percentile * component.weight), 0) / weight);
}

/**
 * The price that moves the contribution, which is the question a schedule is
 * actually asked. A percentile tells a reader where they are; it does not tell
 * them what has to happen next, and the rule already knows.
 *
 * Found by bisection on price rather than by inverting the ranks, because the
 * blend of three percentiles has no closed form. A boundary the price cannot
 * reach - above its running high the drawdown component saturates and the read
 * stops rising - is reported as unreachable instead of being extrapolated.
 */
export function tierPriceLadder(prepared, currentRisk) {
  if (prepared?.status !== 'ready') return [];
  const spot = prepared.values.at(-1);
  const priceForTier = (tier, index) => {
    const floor = index === 0 ? 0 : TIERS[index - 1].max + 1;
    // The price that first lands inside this tier, approached from whichever
    // side the asset is currently on.
    const target = currentRisk > tier.max ? tier.max : floor;
    const wanted = currentRisk > tier.max
      ? (risk) => risk <= target
      : (risk) => risk >= target;
    let low = spot * 0.05;
    let high = spot * 6;
    if (!wanted(riskAtPrice(prepared, currentRisk > tier.max ? low : high) ?? currentRisk)) return null;
    for (let step = 0; step < 60; step += 1) {
      const mid = (low + high) / 2;
      const risk = riskAtPrice(prepared, mid);
      if (!Number.isFinite(risk)) return null;
      if (currentRisk > tier.max ? risk <= target : risk >= target) {
        if (currentRisk > tier.max) low = mid; else high = mid;
      } else if (currentRisk > tier.max) high = mid; else low = mid;
    }
    // Rounding for display can cross the boundary the search just found: the
    // read steps in whole percentiles, so the qualifying price and the next
    // one differ by a fraction of a cent. Settle toward the side that still
    // qualifies, so a published price always buys the tier it names.
    const falling = currentRisk > tier.max;
    const settled = falling ? low : high;
    return falling ? Math.floor(settled * 1e6) / 1e6 : Math.ceil(settled * 1e6) / 1e6;
  };

  return TIERS.map((tier, index) => {
    const floor = index === 0 ? 0 : TIERS[index - 1].max + 1;
    const current = currentRisk >= floor && currentRisk <= tier.max;
    if (current) {
      return { key: tier.key, label: tier.label, multiple: tier.multiple, range: `${floor}\u2013${Number.isFinite(tier.max) ? tier.max : 100}`, current: true, price: round(spot, 6), movePercent: 0 };
    }
    const price = priceForTier(tier, index);
    return {
      key: tier.key,
      label: tier.label,
      multiple: tier.multiple,
      range: `${floor}\u2013${Number.isFinite(tier.max) ? tier.max : 100}`,
      current: false,
      price: Number.isFinite(price) ? price : null,
      movePercent: Number.isFinite(price) ? round(((price / spot) - 1) * 100) : null,
      reason: Number.isFinite(price) ? undefined : 'No price reaches this tier from here: past its own running high the distance-to-high component stops rising, so the blended read has a ceiling.',
    };
  });
}

function boundariesFor(risk) {
  const index = TIERS.findIndex((tier) => risk <= tier.max);
  const below = TIERS[index - 1] ?? null;
  const above = TIERS[index + 1] ?? null;
  const current = TIERS[index] ?? TIERS.at(-1);
  return {
    // How far the risk read has to move before the contribution changes, and
    // to what. A tier one point from its edge and one twenty points inside it
    // are different claims.
    toLighter: Number.isFinite(current.max) ? { points: (current.max - risk) + 1, tier: above?.label ?? null, multiple: above?.multiple ?? null } : null,
    toHeavier: below ? { points: risk - below.max, tier: below.label, multiple: below.multiple } : null,
  };
}

/**
 * Walk the asset's own history running both schedules side by side.
 *
 * At each weekly step the tier is recomputed from the data available up to
 * that step only, the tiered leg buys `multiple` units of budget and the flat
 * leg buys one, and both are converted to units at that session's close. The
 * comparison is cost per unit, which is scale-free, so a schedule cannot look
 * better by spending more.
 */
export function backtestAccumulation(prepared, { cadenceSessions } = {}) {
  if (prepared?.status !== 'ready') return { status: 'unavailable', reason: prepared?.reason ?? 'No usable history.' };
  const step = cadenceSessions ?? Math.max(1, Math.round(CADENCE_SESSIONS_PER_WEEK / (prepared.spacingDays || 1)));

  let tieredSpend = 0;
  let tieredUnits = 0;
  let flatSpend = 0;
  let flatUnits = 0;
  const timeInTier = new Map(TIERS.map((tier) => [tier.key, 0]));
  let firstDate = null;
  let buys = 0;

  for (let index = 0; index < prepared.values.length; index += step) {
    const read = riskAt(prepared, index);
    if (read?.status !== 'calculated') continue;
    const price = prepared.values[index];
    if (!(price > 0)) continue;
    if (!firstDate) firstDate = prepared.dates[index];
    tieredSpend += read.tier.multiple;
    tieredUnits += read.tier.multiple / price;
    flatSpend += 1;
    flatUnits += 1 / price;
    timeInTier.set(read.tier.key, timeInTier.get(read.tier.key) + 1);
    buys += 1;
  }

  if (buys < 20) {
    return { status: 'unavailable', reason: `Needs 20 scheduled purchases after the ranking window fills; ${buys} available.`, buys };
  }

  const tieredCost = tieredSpend / tieredUnits;
  const flatCost = flatSpend / flatUnits;
  const last = prepared.values.at(-1);

  return {
    status: 'calculated',
    from: firstDate,
    to: prepared.dates.at(-1),
    buys,
    cadenceSessions: step,
    tieredCostPerUnit: round(tieredCost, 6),
    flatCostPerUnit: round(flatCost, 6),
    // Negative is good: the tiered schedule paid less per unit.
    costAdvantagePercent: round(((tieredCost / flatCost) - 1) * 100),
    tieredReturnPercent: round(((last / tieredCost) - 1) * 100),
    flatReturnPercent: round(((last / flatCost) - 1) * 100),
    capitalRatio: round(tieredSpend / flatSpend, 3),
    timeInTier: TIERS.map((tier) => ({ key: tier.key, label: tier.label, multiple: tier.multiple, sharePercent: round((timeInTier.get(tier.key) / buys) * 100, 1) })),
    methodology: 'Each step recomputes the tier from data up to that step only, so no purchase uses information that did not exist when it was made. The legs are compared on cost per unit rather than on ending value, because the tiered leg deploys a different amount of capital and a total-value comparison would be measuring the budget. One asset over one history is one path: a rule that buys weakness beats a flat schedule in a market that mean-reverts and trails it in one that only goes up, and this measures which of those the asset has been, not which it will be.',
  };
}

/** Today's tier for one asset, with the history the rule would have produced. */
export function calculateAccumulationSchedule({ key, name, points, baselineContribution = 100, note = null } = {}) {
  const prepared = prepareAccumulationSeries(points);
  if (prepared.status !== 'ready') {
    return { key, name, status: 'unavailable', reason: prepared.reason, observations: prepared.observations ?? 0 };
  }

  const index = prepared.values.length - 1;
  const read = riskAt(prepared, index);
  if (read?.status !== 'calculated') {
    return { key, name, status: 'unavailable', reason: read?.reason ?? 'The risk components could not be ranked.', observations: prepared.observations, components: read?.components ?? [] };
  }

  const backtest = backtestAccumulation(prepared);
  const boundaries = boundariesFor(read.risk);
  const heaviest = [...read.components]
    .filter((component) => Number.isFinite(component.percentile))
    .sort((left, right) => (Math.abs(right.percentile - 50) * right.weight) - (Math.abs(left.percentile - 50) * left.weight))[0];

  const contribution = round(baselineContribution * read.tier.multiple, 2);

  return {
    key,
    name,
    status: read.coverage === 1 ? 'calculated' : 'provisional',
    asOf: prepared.dates.at(-1),
    observations: prepared.observations,
    price: round(prepared.values.at(-1), 6),
    risk: read.risk,
    coverage: read.coverage,
    tier: { key: read.tier.key, label: read.tier.label, multiple: read.tier.multiple },
    multiple: read.tier.multiple,
    baselineContribution,
    contribution,
    components: read.components,
    boundaries,
    priceLadder: tierPriceLadder(prepared, read.risk),
    // Published because it is the reading's main weakness. An asset that has
    // spent its whole history extended has a risk distribution centred on
    // extended, so a middling percentile there is not the same claim as a
    // middling percentile for an asset that has ranged. The rank says where
    // today sits among this asset's own past, and nothing about whether that
    // past was cheap in absolute terms.
    limits: 'Every component is ranked against this asset\u2019s own history, so the read is relative to how this asset has behaved and not to any absolute standard. An asset that has spent most of its history near its highs will show a mid-range risk while near its highs again.',
    windowDays: WINDOW_DAYS,
    sessions: prepared.sessions,
    sessionsPerYear: prepared.sessionsPerYear,
    backtest,
    note,
    read: `${name} sits at the ${ordinal(read.risk)} percentile of its own risk history, which is the ${read.tier.label.toLowerCase()} tier: the rule contributes ${read.tier.multiple}\u00d7 the baseline, ${contribution} against a ${baselineContribution} baseline. The heaviest component is ${heaviest.phrase} at the ${ordinal(heaviest.percentile)} percentile - ${heaviest.description}.${
      boundaries.toHeavier ? ` A ${boundaries.toHeavier.points}-point fall in the risk read moves it to ${boundaries.toHeavier.tier} at ${boundaries.toHeavier.multiple}×.` : ' There is no heavier tier: this is already the largest contribution the rule makes.'
    }`,
  };
}

/**
 * Where a single budget goes when several assets are on the same rule.
 *
 * Each asset's multiple is its own answer to its own history. Turning them
 * into shares of one budget adds an assumption the individual tiers do not
 * make - that the assets deserve equal baselines - so it is published as a
 * separate reading with that assumption stated rather than folded in.
 */
export function allocateAcrossAssets(schedules, { budget = 100 } = {}) {
  const published = (schedules ?? []).filter((schedule) => schedule?.status !== 'unavailable' && Number.isFinite(schedule?.multiple));
  if (published.length < 2) {
    return { status: 'unavailable', reason: `Needs two assets with a published tier; ${published.length} available.`, entries: [] };
  }

  const totalMultiple = published.reduce((total, schedule) => total + schedule.multiple, 0);
  const entries = published
    .map((schedule) => ({
      key: schedule.key,
      name: schedule.name,
      risk: schedule.risk,
      tier: schedule.tier.label,
      multiple: schedule.multiple,
      sharePercent: round((schedule.multiple / totalMultiple) * 100, 1),
      amount: round((schedule.multiple / totalMultiple) * budget, 2),
      equalSharePercent: round(100 / published.length, 1),
    }))
    // Ties on the multiple are the normal case - five tiers, six assets - and
    // whichever asset the sort happened to put first was being named as the
    // cheapest. Risk breaks the tie, so the order means something and the
    // extremes named below are the real ones.
    .sort((left, right) => (right.sharePercent - left.sharePercent) || (left.risk - right.risk));

  const byRisk = [...entries].sort((left, right) => left.risk - right.risk);
  const cheapest = byRisk[0];
  const dearest = byRisk.at(-1);
  const even = published.every((schedule) => schedule.multiple === published[0].multiple);
  const spread = entries[0].sharePercent - entries.at(-1).sharePercent;

  const names = (list) => (list.length === 1
    ? list[0].name
    : `${list.slice(0, -1).map((entry) => entry.name).join(', ')} and ${list.at(-1).name}`);
  const heaviestGroup = entries.filter((entry) => entry.multiple === entries[0].multiple);
  const lightestGroup = entries.filter((entry) => entry.multiple === entries.at(-1).multiple);

  return {
    status: 'calculated',
    budget,
    entries,
    even,
    tilt: round(spread, 1),
    cheapest: { key: cheapest.key, name: cheapest.name, risk: cheapest.risk },
    dearest: { key: dearest.key, name: dearest.name, risk: dearest.risk },
    read: even
      ? `All ${entries.length} assets sit in the same tier (${entries[0].tier}), so the rule splits the ${budget} budget evenly at ${entries[0].equalSharePercent}% each. Their risk reads still differ - ${cheapest.name} is cheapest against its own history at the ${ordinal(cheapest.risk)} percentile and ${dearest.name} dearest at the ${ordinal(dearest.risk)} - but not by enough to cross a tier boundary.`
      : `Splitting a ${budget} budget by tier sends ${heaviestGroup[0].sharePercent}%${heaviestGroup.length > 1 ? ' each' : ''} to ${names(heaviestGroup)} in ${heaviestGroup[0].tier} and ${lightestGroup[0].sharePercent}%${lightestGroup.length > 1 ? ' each' : ''} to ${names(lightestGroup)} in ${lightestGroup[0].tier}, against ${entries[0].equalSharePercent}% each on an even split. ${cheapest.name} is the cheapest against its own history at the ${ordinal(cheapest.risk)} percentile, ${dearest.name} the dearest at the ${ordinal(dearest.risk)}.`,
    methodology: 'Shares are each asset’s multiple over the sum of the multiples, so an asset cheap against its own history draws more of the budget than one that is stretched against its own. This compares each asset only to itself: it carries no view on which asset is the better holding, and assumes the baselines were equal to begin with. It is not a portfolio weight and says nothing about position sizing or risk of ruin.',
  };
}

/** The ladder as a reader sees it, so the panel cannot describe it differently. */
export function describeLadder() {
  return TIERS.map((tier, index) => {
    const floor = index === 0 ? 0 : TIERS[index - 1].max + 1;
    return {
      key: tier.key,
      label: tier.label,
      multiple: tier.multiple,
      floor,
      ceiling: Number.isFinite(tier.max) ? tier.max : 100,
      range: `${floor}\u2013${Number.isFinite(tier.max) ? tier.max : 100}`,
    };
  });
}

export { TIERS as ACCUMULATION_TIERS, COMPONENTS as ACCUMULATION_COMPONENTS, WINDOW_DAYS as ACCUMULATION_WINDOW_DAYS };
