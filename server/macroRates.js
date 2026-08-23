/**
 * Rate-structure models: what is inside a nominal yield, how the US curve sits
 * against the rest of the world, whether official data has been surprising, what
 * the liquidity impulse has actually been worth, and the market's own read on
 * when reserves stop being abundant.
 *
 * Every model publishes `status` with an explicit reason and names the feed it
 * is waiting on rather than substituting a proxy for it.
 */

const DAY_MS = 86_400_000;

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function deviation(values) {
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(values.reduce((total, value) => total + ((value - average) ** 2), 0) / (values.length - 1));
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ordinal(value) {
  if (!Number.isFinite(value)) return '—';
  const lastTwo = Math.abs(value) % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${value}th`;
  return `${value}${{ 1: 'st', 2: 'nd', 3: 'rd' }[Math.abs(value) % 10] ?? 'th'}`;
}

/**
 * A percentile of a distribution with no spread is float dust, not information.
 * Four indicators each scoring an identical z came back at the 100th, 31st and
 * 22nd percentiles purely because the values differed in the fifteenth decimal
 * place, which reads as a contradiction next to identical numbers.
 */
function percentileRank(values, value) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length || !Number.isFinite(value)) return null;
  const spread = Math.max(...finite) - Math.min(...finite);
  const scale = Math.max(Math.abs(value), ...finite.map(Math.abs), 1);
  if (spread <= scale * 1e-9) return null;
  return Math.round((finite.filter((entry) => entry <= value).length / finite.length) * 100);
}

function unavailable(version, reason, extra = {}) {
  return { version, status: 'unavailable', reason, ...extra };
}

export function seriesPoints(seriesList, key) {
  const series = (seriesList ?? []).find((item) => item?.key === key);
  return (series?.history ?? [])
    .filter((point) => Number.isFinite(point?.value) && point?.date)
    .map((point) => ({ date: String(point.date).slice(0, 10), value: point.value * (series.multiplier ?? 1) }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function latestAtOrBefore(points, date) {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (points[index].date <= date) return points[index];
  }
  return null;
}

function medianSpacingDays(points) {
  if (points.length < 3) return null;
  const gaps = points.slice(1).map((point, index) => (new Date(point.date) - new Date(points[index].date)) / DAY_MS);
  const sorted = gaps.filter((gap) => gap > 0).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The same bounded lookback the rest of the workspace uses. */
export function changeOver(points, days) {
  if (points.length < 2) return null;
  const latest = points.at(-1);
  const target = new Date(new Date(latest.date).getTime() - (days * DAY_MS)).toISOString().slice(0, 10);
  const previous = latestAtOrBefore(points, target);
  if (!previous) return null;
  const spanDays = (new Date(latest.date) - new Date(previous.date)) / DAY_MS;
  const cadence = medianSpacingDays(points) ?? 1;
  if (cadence > days) return null;
  if (spanDays > days + Math.max(7, days * 0.15, cadence)) return null;
  return { absolute: latest.value - previous.value, spanDays: Math.round(spanDays), fromDate: previous.date, latest };
}

/** Two series differenced on the dates they share. */
function alignedSpread(left, right, { maxGapDays = 40 } = {}) {
  return left.flatMap((point) => {
    const other = latestAtOrBefore(right, point.date);
    if (!other) return [];
    const gap = (new Date(point.date) - new Date(other.date)) / DAY_MS;
    if (gap > maxGapDays) return [];
    return [{ date: point.date, value: point.value - other.value }];
  });
}

/**
 * A nominal yield is a real yield plus compensation for expected inflation. A
 * selloff driven by the real leg is a growth or policy repricing; one driven by
 * breakevens is an inflation repricing, and they call for opposite things. The
 * curve model can say the 10-year moved; only this can say what moved it.
 */
export function calculateNominalDecomposition(seriesList, { windows = [20, 91] } = {}) {
  const version = 'nominal-decomposition-v1';
  const nominal = seriesPoints(seriesList, 'us10yYield');
  const real = seriesPoints(seriesList, 'realYield10y');
  const breakeven = seriesPoints(seriesList, 'breakeven10y');
  const missing = [
    ...(nominal.length ? [] : ['FRED DGS10 nominal 10-year']),
    ...(real.length ? [] : ['FRED DFII10 real 10-year']),
    ...(breakeven.length ? [] : ['FRED T10YIE 10-year breakeven']),
  ];
  if (missing.length) return unavailable(version, `Needs all three legs to split a nominal move; missing ${missing.join(', ')}.`, { missing, windows: [] });

  const decomposed = windows.map((days) => {
    const nominalChange = changeOver(nominal, days);
    const realChange = changeOver(real, days);
    const breakevenChange = changeOver(breakeven, days);
    if (!nominalChange || !realChange || !breakevenChange) {
      return { days, status: 'unavailable', reason: `One of the three legs cannot reach back ${days} days.` };
    }
    const total = nominalChange.absolute;
    // Real and breakeven are separately published series, so they do not sum to
    // the nominal exactly. The residual is reported rather than silently
    // absorbed into whichever leg happens to be larger.
    const residual = total - (realChange.absolute + breakevenChange.absolute);
    const magnitude = Math.abs(realChange.absolute) + Math.abs(breakevenChange.absolute);
    const realShare = magnitude > 0 ? Math.abs(realChange.absolute) / magnitude : null;
    const driver = realShare === null ? null
      : realShare >= 0.65 ? 'real yields'
        : realShare <= 0.35 ? 'inflation compensation'
          : 'both legs together';
    return {
      days,
      status: 'calculated',
      spanDays: nominalChange.spanDays,
      nominalBasisPoints: round(total * 100, 1),
      realBasisPoints: round(realChange.absolute * 100, 1),
      breakevenBasisPoints: round(breakevenChange.absolute * 100, 1),
      residualBasisPoints: round(residual * 100, 1),
      realSharePercent: realShare === null ? null : Math.round(realShare * 100),
      driver,
    };
  });

  const published = decomposed.filter((entry) => entry.status === 'calculated');
  if (!published.length) return unavailable(version, 'No window could be measured across all three legs.', { windows: decomposed });
  const headline = published.at(-1);
  return {
    version,
    status: published.length === windows.length ? 'calculated' : 'provisional',
    asOf: nominal.at(-1).date,
    nominalPercent: round(nominal.at(-1).value, 2),
    realPercent: round(real.at(-1).value, 2),
    breakevenPercent: round(breakeven.at(-1).value, 2),
    windows: decomposed,
    driver: headline.driver,
    read: `Over ${headline.spanDays} days the 10-year moved ${headline.nominalBasisPoints > 0 ? '+' : ''}${headline.nominalBasisPoints}bp, of which real yields account for ${headline.realBasisPoints > 0 ? '+' : ''}${headline.realBasisPoints}bp and inflation compensation ${headline.breakevenBasisPoints > 0 ? '+' : ''}${headline.breakevenBasisPoints}bp — ${headline.driver} did the work.${Math.abs(headline.residualBasisPoints) >= 3 ? ` A ${headline.residualBasisPoints}bp residual remains because the three series are published separately and do not reconcile exactly.` : ''}`,
    methodology: 'The nominal 10-year, the TIPS real 10-year and the 10-year breakeven are three separately published series, so their legs do not sum to the nominal exactly; the residual is published rather than folded into whichever leg is larger. The driver is named from each leg\'s share of the total absolute movement, which is why a move can be attributed to both legs together rather than forced onto one.',
  };
}

/**
 * The Kim-Wright decomposition of the 10-year into expected short rates and the
 * term premium. A steepening driven by expectations is the market pricing more
 * growth or more policy; one driven by term premium is the market demanding
 * more to hold duration, and only the second is a supply or credibility story.
 */
export function calculateTermPremium(seriesList, { rankWindow = 2520, windows = [20, 91] } = {}) {
  const version = 'term-premium-v1';
  const premium = seriesPoints(seriesList, 'termPremium10y');
  const nominal = seriesPoints(seriesList, 'us10yYield');
  if (!premium.length) {
    return unavailable(version, 'FRED THREEFYTP10 (Kim-Wright 10-year term premium) is required.', { missing: ['FRED THREEFYTP10'], windows: [] });
  }
  const latest = premium.at(-1);
  const history = premium.slice(-rankWindow);
  // Expected short rates are the nominal yield less the premium, on the dates
  // both publish, so an expectations move is measured rather than inferred.
  const expectations = nominal.length ? alignedSpread(nominal, premium, { maxGapDays: 7 }) : [];

  const decomposed = windows.map((days) => {
    const premiumChange = changeOver(premium, days);
    const expectationChange = expectations.length ? changeOver(expectations, days) : null;
    if (!premiumChange) return { days, status: 'unavailable', reason: `The term premium cannot reach back ${days} days.` };
    if (!expectationChange) {
      return {
        days,
        status: 'provisional',
        spanDays: premiumChange.spanDays,
        premiumBasisPoints: round(premiumChange.absolute * 100, 1),
        expectationsBasisPoints: null,
        driver: null,
        reason: 'The nominal 10-year is required to separate expectations from the premium.',
      };
    }
    const magnitude = Math.abs(premiumChange.absolute) + Math.abs(expectationChange.absolute);
    const premiumShare = magnitude > 0 ? Math.abs(premiumChange.absolute) / magnitude : null;
    return {
      days,
      status: 'calculated',
      spanDays: premiumChange.spanDays,
      premiumBasisPoints: round(premiumChange.absolute * 100, 1),
      expectationsBasisPoints: round(expectationChange.absolute * 100, 1),
      premiumSharePercent: premiumShare === null ? null : Math.round(premiumShare * 100),
      driver: premiumShare === null ? null
        : premiumShare >= 0.65 ? 'term premium'
          : premiumShare <= 0.35 ? 'rate expectations'
            : 'both together',
    };
  });

  const published = decomposed.filter((entry) => entry.status === 'calculated');
  const headline = published.at(-1) ?? null;
  const percentile = percentileRank(history.map((point) => point.value), latest.value);
  return {
    version,
    status: published.length === windows.length && history.length >= rankWindow ? 'calculated' : 'provisional',
    asOf: latest.date,
    premiumPercent: round(latest.value, 2),
    percentile,
    rankedAgainst: history.length,
    negative: latest.value < 0,
    expectationsPercent: expectations.length ? round(expectations.at(-1).value, 2) : null,
    windows: decomposed,
    driver: headline?.driver ?? null,
    read: `The 10-year term premium is ${round(latest.value, 2)}%, the ${ordinal(percentile)} percentile of its last ${history.length} observations${latest.value < 0 ? ' and still negative, meaning holders are accepting less than the expected path of short rates to own duration' : ''}.${headline ? ` Over ${headline.spanDays} days the premium moved ${headline.premiumBasisPoints > 0 ? '+' : ''}${headline.premiumBasisPoints}bp against ${headline.expectationsBasisPoints > 0 ? '+' : ''}${headline.expectationsBasisPoints}bp of expectations — ${headline.driver} drove the yield.` : ''}`,
    methodology: `The Kim-Wright premium is a model estimate, not an observable price, and is revised: it is ranked against its own last ${rankWindow} observations rather than read as a level. Expected short rates are the nominal 10-year minus the premium on the dates both publish, so an expectations move is measured rather than inferred from what is left over.`,
  };
}

const RATE_MARKETS = [
  { key: 'germany10y', name: 'Germany', currency: 'EUR' },
  { key: 'japan10y', name: 'Japan', currency: 'JPY' },
  { key: 'uk10y', name: 'United Kingdom', currency: 'GBP' },
];

/**
 * The US long rate against the rest of the developed world. The dollar model
 * has no rate-differential leg at all, and the differential is the single most
 * used driver in FX.
 */
export function calculateRateDivergence(seriesList, { window = 91, rankWindow = 1260 } = {}) {
  const version = 'rate-divergence-v1';
  const us = seriesPoints(seriesList, 'us10yYield');
  if (!us.length) return unavailable(version, 'FRED DGS10 is required as the US leg.', { markets: [] });

  const markets = RATE_MARKETS.map((market) => {
    const points = seriesPoints(seriesList, market.key);
    if (points.length < 12) {
      return { ...market, status: 'unavailable', reason: `Needs 12 observations of the ${market.name} long rate; ${points.length} available.` };
    }
    // The foreign legs are monthly OECD series, so the spread is built on their
    // dates rather than on the daily US ones — a daily spread against a monthly
    // series is the monthly series repeated twenty times.
    const spread = alignedSpread(points, us, { maxGapDays: 10 }).map((point) => ({ date: point.date, value: -point.value }));
    if (spread.length < 12) {
      return { ...market, status: 'unavailable', reason: `The ${market.name} and US legs share fewer than 12 dates.` };
    }
    const latest = spread.at(-1);
    const change = changeOver(spread, window);
    const history = spread.slice(-rankWindow);
    return {
      ...market,
      status: history.length >= 60 ? 'calculated' : 'provisional',
      asOf: latest.date,
      cadenceDays: Math.round(medianSpacingDays(points) ?? 0),
      spreadPercent: round(latest.value, 2),
      percentile: percentileRank(history.map((point) => point.value), latest.value),
      rankedAgainst: history.length,
      changeBasisPoints: change ? round(change.absolute * 100, 1) : null,
      spanDays: change?.spanDays ?? null,
      foreignPercent: round(points.at(-1).value, 2),
    };
  });

  const published = markets.filter((market) => market.status !== 'unavailable');
  if (!published.length) {
    return unavailable(version, `No foreign long rate published a usable spread: ${markets.map((market) => market.reason).filter(Boolean).join(' ')}`, { markets });
  }

  const averageSpread = mean(published.map((market) => market.spreadPercent));
  const averageChange = mean(published.map((market) => market.changeBasisPoints).filter(Number.isFinite));
  const widening = Number.isFinite(averageChange) && averageChange > 5;
  const narrowing = Number.isFinite(averageChange) && averageChange < -5;
  const state = widening ? 'US yield advantage widening'
    : narrowing ? 'US yield advantage narrowing'
      : 'US yield advantage steady';
  // Positive and widening is dollar-supportive; the sign of that support is the
  // whole reason the leg exists, so it is scored rather than described.
  const score = Number.isFinite(averageSpread)
    ? Math.round(Math.min(100, Math.max(0, 50 + (averageSpread * 12) + ((averageChange ?? 0) * 0.4))))
    : null;

  return {
    version,
    status: published.length === markets.length ? 'calculated' : 'provisional',
    asOf: published.map((market) => market.asOf).sort().at(0) ?? null,
    usPercent: round(us.at(-1).value, 2),
    markets,
    averageSpreadPercent: round(averageSpread, 2),
    averageChangeBasisPoints: round(averageChange, 1),
    state,
    score,
    read: `${state}: the US 10-year yields ${round(averageSpread, 2)} points more than the average of ${published.map((market) => market.name).join(', ')}${Number.isFinite(averageChange) ? `, ${averageChange > 0 ? 'up' : 'down'} ${Math.abs(round(averageChange, 1))}bp over about ${window} days` : ''}. A widening advantage pulls capital toward the dollar; a narrowing one removes that pull.`,
    methodology: `Each spread is the US 10-year minus a foreign long rate, built on the foreign series' own dates because those are monthly OECD readings — a daily spread against a monthly series is the monthly value repeated twenty times. Spreads are ranked against their own history rather than read as levels, since the neutral level of a rate differential drifts with relative inflation.`,
  };
}

/**
 * Whether official data has been coming in above or below its own recent trend.
 * A licensed surprise index measures releases against economist forecasts; no
 * free forecast feed exists, so this measures each release against the trend of
 * its own history and says exactly that.
 */
export function calculateDataSurprise(seriesList, { indicators = [], lookback = 24, rankWindow = 120 } = {}) {
  const version = 'data-surprise-v1';
  const scored = indicators.map((indicator) => {
    const points = seriesPoints(seriesList, indicator.key);
    if (points.length < lookback + 4) {
      return { ...indicator, status: 'unavailable', reason: `Needs ${lookback + 4} observations; ${points.length} available.` };
    }
    // Each release against the mean and spread of the preceding window, in
    // standard deviations, which is what "surprising" means without a forecast.
    const surprises = points.map((point, index) => {
      if (index < lookback) return null;
      const window = points.slice(index - lookback, index).map((entry) => entry.value);
      const sigma = deviation(window);
      const average = mean(window);
      if (!sigma || !Number.isFinite(average)) return null;
      return { date: point.date, value: ((point.value - average) / sigma) * (indicator.inverse ? -1 : 1) };
    }).filter(Boolean);
    if (surprises.length < 6) {
      return { ...indicator, status: 'unavailable', reason: 'Not enough scored releases to publish.' };
    }
    const latest = surprises.at(-1);
    const recent = surprises.slice(-6);
    return {
      ...indicator,
      status: 'calculated',
      asOf: latest.date,
      zScore: round(latest.value, 2),
      averageRecent: round(mean(recent.map((entry) => entry.value)), 2),
      percentile: percentileRank(surprises.slice(-rankWindow).map((entry) => entry.value), latest.value),
      observations: surprises.length,
    };
  });

  const published = scored.filter((entry) => entry.status === 'calculated');
  if (published.length < 2) {
    return unavailable(version, `Needs two scored indicators; ${published.length} could be scored.`, { indicators: scored, score: null });
  }
  const composite = mean(published.map((entry) => entry.averageRecent));
  const score = Math.round(Math.min(100, Math.max(0, 50 + (composite * 25))));
  const state = composite >= 0.5 ? 'Data running above its own trend'
    : composite <= -0.5 ? 'Data running below its own trend'
      : 'Data in line with its own trend';

  return {
    version,
    status: published.length === scored.length ? 'calculated' : 'provisional',
    asOf: published.map((entry) => entry.asOf).sort().at(0) ?? null,
    indicators: scored,
    composite: round(composite, 2),
    score,
    state,
    coverage: Math.round((published.length / scored.length) * 100),
    read: `${state}: ${published.length} of ${scored.length} indicators score an average of ${round(composite, 2)} standard deviations over their last six releases.`,
    methodology: `Each release is scored against the mean and standard deviation of the preceding ${lookback} observations of the same series. This is not a forecast-surprise index: a licensed one measures releases against economist expectations, and no free feed of those exists, so a print in line with expectations but far above its own trend scores as a surprise here and would not there. Series where a higher reading is worse are inverted before scoring.`,
  };
}

/**
 * What the liquidity impulse has actually been worth. The transmission model
 * measures the correlation and the lead, but never asks what happened next.
 * Impulses are bucketed by tercile and each bucket reports the asset's forward
 * return, so a weak link with a large payoff is distinguishable from a strong
 * link with none.
 */
export function calculateLiquidityPayoff(liquidityPoints, assetPoints, { changeDays = 91, forwardDays = 63, minimumPerBucket = 8, maxGapDays = 10 } = {}) {
  const version = 'liquidity-payoff-v1';
  const liquidity = (liquidityPoints ?? [])
    .filter((point) => Number.isFinite(point?.value) && (point?.date || point?.timestamp))
    .map((point) => ({ date: String(point.date ?? point.timestamp).slice(0, 10), value: point.value }))
    .sort((left, right) => left.date.localeCompare(right.date));
  const asset = (assetPoints ?? [])
    .filter((point) => Number.isFinite(point?.value) && (point?.date || point?.timestamp))
    .map((point) => ({ date: String(point.date ?? point.timestamp).slice(0, 10), value: point.value }))
    .sort((left, right) => left.date.localeCompare(right.date));
  if (liquidity.length < 40 || asset.length < 120) {
    return unavailable(version, `Needs 40 liquidity observations and 120 asset closes; ${liquidity.length} and ${asset.length} available.`, { buckets: [] });
  }

  const assetAt = (date) => {
    const point = latestAtOrBefore(asset, date);
    if (!point) return null;
    return ((new Date(date) - new Date(point.date)) / DAY_MS) <= maxGapDays ? point : null;
  };

  const samples = liquidity.flatMap((point, index) => {
    if (index === 0) return [];
    const priorTarget = new Date(new Date(point.date).getTime() - (changeDays * DAY_MS)).toISOString().slice(0, 10);
    const prior = latestAtOrBefore(liquidity, priorTarget);
    if (!prior || prior.value <= 0) return [];
    const spanDays = (new Date(point.date) - new Date(prior.date)) / DAY_MS;
    if (spanDays > changeDays * 1.3) return [];
    const impulse = ((point.value / prior.value) - 1) * 100;
    const from = assetAt(point.date);
    const to = assetAt(new Date(new Date(point.date).getTime() + (forwardDays * DAY_MS)).toISOString().slice(0, 10));
    // A sample whose forward window has not closed yet is dropped, not counted
    // as a zero return.
    if (!from || !to || to.date <= from.date || from.value <= 0) return [];
    return [{ date: point.date, impulse, forward: ((to.value / from.value) - 1) * 100 }];
  });

  if (samples.length < minimumPerBucket * 3) {
    return unavailable(version, `Needs ${minimumPerBucket * 3} impulse observations with a closed forward window; ${samples.length} available.`, { buckets: [], samples: samples.length });
  }

  const sorted = [...samples].sort((left, right) => left.impulse - right.impulse);
  const size = Math.floor(sorted.length / 3);
  const definitions = [
    { key: 'weak', name: 'Weakest third of impulses', rows: sorted.slice(0, size) },
    { key: 'middle', name: 'Middle third', rows: sorted.slice(size, sorted.length - size) },
    { key: 'strong', name: 'Strongest third of impulses', rows: sorted.slice(sorted.length - size) },
  ];
  const buckets = definitions.map((definition) => ({
    key: definition.key,
    name: definition.name,
    observations: definition.rows.length,
    impulseFrom: round(definition.rows[0]?.impulse, 2),
    impulseTo: round(definition.rows.at(-1)?.impulse, 2),
    averageForwardPercent: round(mean(definition.rows.map((row) => row.forward)), 2),
    positiveSharePercent: definition.rows.length ? Math.round((definition.rows.filter((row) => row.forward > 0).length / definition.rows.length) * 100) : null,
  }));

  const strong = buckets.find((bucket) => bucket.key === 'strong');
  const weak = buckets.find((bucket) => bucket.key === 'weak');
  const edge = Number.isFinite(strong?.averageForwardPercent) && Number.isFinite(weak?.averageForwardPercent)
    ? round(strong.averageForwardPercent - weak.averageForwardPercent, 2)
    : null;

  return {
    version,
    status: 'calculated',
    asOf: samples.at(-1).date,
    changeDays,
    forwardDays,
    samples: samples.length,
    buckets,
    edgePercent: edge,
    read: `Across ${samples.length} overlapping observations, the strongest third of ${changeDays}-day liquidity impulses was followed by ${strong.averageForwardPercent}% over the next ${forwardDays} days against ${weak.averageForwardPercent}% for the weakest third — a ${edge > 0 ? '+' : ''}${edge}-point spread.`,
    methodology: `Each liquidity observation is scored by its ${changeDays}-day impulse and paired with the asset's return over the following ${forwardDays} days; samples whose forward window has not closed are dropped rather than counted as zero. The observations overlap, so they are not independent and the spread between terciles is descriptive of this history rather than a tested edge. Nothing here is out of sample.`,
  };
}

/**
 * The market's own read on whether reserves are still abundant. SOFR printing
 * above the rate paid on reserves means cash is bidding for balance sheet, which
 * is what reserve scarcity looks like before anything official says so — and it
 * is precisely the moment the runway model is trying to anticipate.
 */
export function calculateReserveScarcity(seriesList, { rankWindow = 504, elevatedBasisPoints = 5 } = {}) {
  const version = 'reserve-scarcity-v1';
  const sofr = seriesPoints(seriesList, 'sofr');
  const iorb = seriesPoints(seriesList, 'iorb');
  const missing = [
    ...(sofr.length ? [] : ['FRED SOFR']),
    ...(iorb.length ? [] : ['FRED IORB']),
  ];
  if (missing.length) {
    return unavailable(version, `Needs both legs of the spread; missing ${missing.join(', ')}.`, { missing });
  }
  const spread = alignedSpread(sofr, iorb, { maxGapDays: 5 }).map((point) => ({ date: point.date, value: point.value * 100 }));
  if (spread.length < 60) {
    return unavailable(version, `SOFR and IORB share fewer than 60 dates; ${spread.length} available.`, { missing: [] });
  }
  const latest = spread.at(-1);
  const history = spread.slice(-rankWindow);
  const percentile = percentileRank(history.map((point) => point.value), latest.value);
  const recent = spread.slice(-21);
  const daysAbove = recent.filter((point) => point.value >= elevatedBasisPoints).length;
  const change = changeOver(spread, 63);

  const state = latest.value >= elevatedBasisPoints * 2 ? 'Reserves scarce'
    : latest.value >= elevatedBasisPoints ? 'Reserves tightening'
      : latest.value >= 0 ? 'Reserves ample'
        : 'Reserves abundant';

  return {
    version,
    status: history.length >= rankWindow ? 'calculated' : 'provisional',
    asOf: latest.date,
    spreadBasisPoints: round(latest.value, 1),
    percentile,
    rankedAgainst: history.length,
    daysAboveThreshold: daysAbove,
    thresholdBasisPoints: elevatedBasisPoints,
    changeBasisPoints: change ? round(change.absolute, 1) : null,
    state,
    read: `SOFR is printing ${round(latest.value, 1)}bp ${latest.value >= 0 ? 'above' : 'below'} the rate paid on reserves, the ${ordinal(percentile)} percentile of its last ${history.length} sessions. ${state}${daysAbove ? `: ${daysAbove} of the last 21 sessions closed at or above ${elevatedBasisPoints}bp` : ''}.${change ? ` The spread has moved ${change.absolute > 0 ? '+' : ''}${round(change.absolute, 1)}bp over about a quarter.` : ''}`,
    methodology: `The spread of secured overnight funding over the rate paid on reserve balances, on the dates both publish. A persistently positive spread means cash is paying up for balance sheet rather than parking at the Fed, which is the market pricing reserve scarcity ahead of any official statement of it. The Standing Repo Facility take-up would sharpen this considerably and is not available as a free daily series, so it is absent rather than approximated.`,
  };
}
