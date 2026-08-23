/**
 * Macro models that sit alongside the liquidity and regime engines: the yield
 * curve, market-implied inflation, the rate path the curve is pricing, the
 * forward liquidity calendar, the regime's own transition history, and a growth
 * nowcast built from freely available proxies.
 *
 * Every model publishes `status: 'calculated' | 'provisional' | 'unavailable'`
 * with an explicit reason, and none of them substitutes a proxy for a series it
 * could not reach.
 */

const DAY_MS = 86_400_000;
const DAYS_PER_MONTH = 30.44;

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
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

function percentileRank(values, value) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length || !Number.isFinite(value)) return null;
  return Math.round((finite.filter((entry) => entry <= value).length / finite.length) * 100);
}

/** `{ key, multiplier, history: [{ date, value }] }` into sorted `{ date, value }`. */
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

/**
 * The observation `days` before `from`, refusing one too far back to be that.
 * An unbounded lookup answers a 91-day question with a 251-day gap when a
 * series stops publishing, and answers a 28-day question with a full quarter
 * when the series only prints quarterly.
 */
export function pointDaysBefore(points, from, days) {
  if (points.length < 2) return null;
  const target = new Date(new Date(from).getTime() - (days * DAY_MS)).toISOString().slice(0, 10);
  const previous = latestAtOrBefore(points, target);
  if (!previous) return null;
  const spanDays = (new Date(from) - new Date(previous.date)) / DAY_MS;
  const cadence = medianSpacingDays(points) ?? 1;
  if (cadence > days) return null;
  if (spanDays > days + Math.max(7, days * 0.15, cadence)) return null;
  return { ...previous, spanDays: Math.round(spanDays) };
}

/** Two series differenced on the dates they share, newest last. */
function spreadSeries(longPoints, shortPoints, { maxGapDays = 5 } = {}) {
  return longPoints.flatMap((point) => {
    const other = latestAtOrBefore(shortPoints, point.date);
    if (!other) return [];
    const gap = (new Date(point.date) - new Date(other.date)) / DAY_MS;
    if (gap > maxGapDays) return [];
    return [{ date: point.date, value: point.value - other.value }];
  });
}

function unavailable(version, reason, extra = {}) {
  return { version, status: 'unavailable', reason, ...extra };
}

/**
 * The curve, and specifically what it is doing rather than only where it is.
 * An inversion is a forecast with a long and variable lag; the steepening back
 * out of one has historically been the nearer signal, so the model reports the
 * trough, how far the curve has recovered from it, and whether the
 * un-inversion has actually happened.
 */
export function calculateYieldCurveModel(seriesList, { rankWindow = 2520 } = {}) {
  const version = 'yield-curve-v1';
  const tenYear = seriesPoints(seriesList, 'us10yYield');
  const twoYear = seriesPoints(seriesList, 'us2yYield');
  const threeMonth = seriesPoints(seriesList, 'us3mYield');
  if (!tenYear.length || (!twoYear.length && !threeMonth.length)) {
    return unavailable(version, 'Needs the 10-year yield plus at least one of the 2-year or 3-month yields.', { spreads: [] });
  }

  const buildSpread = (key, name, shortPoints, shortName) => {
    if (!shortPoints.length) {
      return { key, name, status: 'unavailable', reason: `The ${shortName} history is required.` };
    }
    const points = spreadSeries(tenYear, shortPoints);
    if (points.length < 60) {
      return { key, name, status: 'unavailable', reason: `Needs 60 sessions where both legs publish; ${points.length} available.` };
    }
    const latest = points.at(-1);
    const window = points.slice(-rankWindow);
    const inverted = latest.value < 0;

    // The most recent uninterrupted run of inverted sessions, and the trough
    // inside it. A curve that inverted, recovered, and inverted again is two
    // episodes, not one long one.
    let runStart = null;
    for (let index = points.length - 1; index >= 0; index -= 1) {
      if (points[index].value < 0) runStart = index;
      else if (runStart !== null) break;
    }
    const currentRun = runStart !== null ? points.slice(runStart) : [];

    // The last completed inversion episode, for a curve that has already
    // un-inverted: everything back to the first non-inverted session before it.
    let lastEpisode = null;
    let lastInvertedIndex = null;
    if (!inverted) {
      let end = null;
      let start = null;
      for (let index = points.length - 1; index >= 0; index -= 1) {
        if (points[index].value < 0) {
          if (end === null) end = index;
          start = index;
        } else if (end !== null) {
          break;
        }
      }
      // An episode that runs back to the first observation is still an episode:
      // requiring a non-inverted session before it missed a curve that was
      // already inverted when the history began.
      if (end !== null) {
        lastEpisode = points.slice(start, end + 1);
        lastInvertedIndex = end;
      }
    }
    const episode = inverted ? currentRun : lastEpisode;
    const trough = episode?.length ? episode.reduce((worst, point) => (point.value < worst.value ? point : worst)) : null;
    const recovered = trough ? latest.value - trough.value : null;

    return {
      key,
      name,
      status: window.length >= rankWindow ? 'calculated' : 'provisional',
      asOf: latest.date,
      observations: points.length,
      rankedAgainst: window.length,
      spread: round(latest.value, 3),
      percentile: percentileRank(window.map((point) => point.value), latest.value),
      inverted,
      sessionsInverted: inverted ? currentRun.length : 0,
      trough: trough ? { value: round(trough.value, 3), date: trough.date } : null,
      recoveredFromTrough: round(recovered, 3),
      // An un-inversion is the crossing itself, not merely being positive:
      // a curve that has been positive for two years is not "un-inverting".
      unInverted: Boolean(!inverted && lastEpisode?.length),
      sessionsSinceUnInversion: lastInvertedIndex === null ? null : points.length - 1 - lastInvertedIndex,
      change60d: (() => {
        const past = points.at(-61);
        return past ? round(latest.value - past.value, 3) : null;
      })(),
    };
  };

  const spreads = [
    buildSpread('tenTwo', '10-year minus 2-year', twoYear, '2-year'),
    buildSpread('tenThreeMonth', '10-year minus 3-month', threeMonth, '3-month'),
  ];
  const published = spreads.filter((spread) => spread.status !== 'unavailable');
  if (!published.length) {
    return unavailable(version, spreads.map((spread) => spread.reason).filter(Boolean).join(' '), { spreads });
  }

  const anyInverted = published.some((spread) => spread.inverted);
  const allInverted = published.every((spread) => spread.inverted);
  const steepening = published.every((spread) => Number.isFinite(spread.change60d) && spread.change60d > 0.05);
  const flattening = published.every((spread) => Number.isFinite(spread.change60d) && spread.change60d < -0.05);
  const recentlyUnInverted = published.some((spread) => spread.unInverted && Number.isFinite(spread.sessionsSinceUnInversion) && spread.sessionsSinceUnInversion <= 130);

  const state = allInverted ? 'Inverted'
    : anyInverted ? 'Partially inverted'
      : recentlyUnInverted ? 'Recently un-inverted'
        : steepening ? 'Steepening'
          : flattening ? 'Flattening'
            : 'Normal';

  const leading = published[0];
  return {
    version,
    status: published.length === spreads.length && published.every((spread) => spread.status === 'calculated') ? 'calculated' : 'provisional',
    asOf: published.map((spread) => spread.asOf).sort().at(0) ?? null,
    spreads,
    state,
    inverted: anyInverted,
    read: `${state}: ${published.map((spread) => `${spread.name} at ${spread.spread}%${spread.inverted ? ` and inverted for ${spread.sessionsInverted} sessions` : ''}`).join('; ')}.${leading?.trough ? ` The ${leading.name.toLowerCase()} troughed at ${leading.trough.value}% on ${leading.trough.date} and has recovered ${leading.recoveredFromTrough} points since.` : ''}${recentlyUnInverted ? ' The un-inversion itself is the nearer signal — an inversion forecasts on a long and variable lag, the steepening out of one does not.' : ''}`,
    methodology: `Each spread is differenced only on dates both legs publish, ranked against its own last ${rankWindow} sessions. An inversion episode is an uninterrupted run of negative sessions, so a curve that inverted, recovered and inverted again is two episodes rather than one; the trough and the recovery from it are measured inside the current or most recent episode. "Un-inverted" means the crossing happened inside the available history, not merely that the spread is positive today.`,
  };
}

/**
 * What the market is pricing for inflation, and how far that sits from what has
 * actually been printing. Breakevens are a market price and CPI is a lagged
 * official statistic; the gap between them is the model's point, so neither is
 * presented as the other.
 */
export function calculateInflationNowcast(seriesList, { rankWindow = 2520 } = {}) {
  const version = 'inflation-nowcast-v1';
  const forward5y5y = seriesPoints(seriesList, 'forwardInflation5y5y');
  const breakeven5y = seriesPoints(seriesList, 'breakeven5y');
  const breakeven10y = seriesPoints(seriesList, 'breakeven10y');
  const cpi = seriesPoints(seriesList, 'cpi');

  const marketLegs = [
    { key: 'breakeven5y', name: '5-year breakeven', points: breakeven5y },
    { key: 'breakeven10y', name: '10-year breakeven', points: breakeven10y },
    { key: 'forward5y5y', name: '5-year, 5-year forward', points: forward5y5y },
  ].map((leg) => {
    if (leg.points.length < 60) {
      return { key: leg.key, name: leg.name, status: 'unavailable', reason: `Needs 60 observations; ${leg.points.length} available.` };
    }
    const latest = leg.points.at(-1);
    const window = leg.points.slice(-rankWindow);
    const past = leg.points.at(-61);
    return {
      key: leg.key,
      name: leg.name,
      status: window.length >= rankWindow ? 'calculated' : 'provisional',
      asOf: latest.date,
      percent: round(latest.value, 2),
      percentile: percentileRank(window.map((point) => point.value), latest.value),
      change60d: past ? round(latest.value - past.value, 2) : null,
      rankedAgainst: window.length,
    };
  });
  const published = marketLegs.filter((leg) => leg.status !== 'unavailable');
  if (!published.length) {
    return unavailable(version, 'No breakeven or forward-inflation series returned enough observations.', { market: marketLegs, realized: null });
  }

  // Year-over-year CPI, computed from the index rather than taken as a headline
  // number, so the vintage is the index's own.
  const realized = (() => {
    if (cpi.length < 13) return { status: 'unavailable', reason: `Needs 13 monthly CPI observations for a year-over-year rate; ${cpi.length} available.` };
    const latest = cpi.at(-1);
    const yearAgo = pointDaysBefore(cpi, latest.date, 365);
    if (!yearAgo || yearAgo.value <= 0) return { status: 'unavailable', reason: 'No CPI observation a year before the latest one.' };
    const yearOverYear = ((latest.value / yearAgo.value) - 1) * 100;
    const threeMonth = (() => {
      const prior = pointDaysBefore(cpi, latest.date, 92);
      return prior && prior.value > 0 ? (((latest.value / prior.value) ** 4) - 1) * 100 : null;
    })();
    // CPI is released with a lag of weeks; the model says how stale its own
    // realized leg is rather than implying it is current. A future-dated
    // observation is a feed problem, not a negative lag, so it is flagged
    // rather than rendered as "-674 days old".
    const rawLagDays = Math.round((Date.now() - new Date(latest.date).getTime()) / DAY_MS);
    return {
      status: 'calculated',
      asOf: latest.date,
      yearOverYearPercent: round(yearOverYear, 2),
      threeMonthAnnualizedPercent: round(threeMonth, 2),
      lagDays: Math.max(0, rawLagDays),
      futureDated: rawLagDays < 0,
    };
  })();

  const anchor = published.find((leg) => leg.key === 'forward5y5y') ?? published.find((leg) => leg.key === 'breakeven10y') ?? published[0];
  const gap = realized.status === 'calculated' && Number.isFinite(anchor.percent)
    ? round(anchor.percent - realized.yearOverYearPercent, 2)
    : null;
  const near5 = published.find((leg) => leg.key === 'breakeven5y');
  const far = published.find((leg) => leg.key === 'breakeven10y') ?? published.find((leg) => leg.key === 'forward5y5y');
  const termSlope = near5 && far && Number.isFinite(near5.percent) && Number.isFinite(far.percent)
    ? round(far.percent - near5.percent, 2)
    : null;

  const state = gap === null ? null
    : gap <= -0.75 ? 'Market prices inflation well below what is printing'
      : gap >= 0.75 ? 'Market prices inflation well above what is printing'
        : 'Market and realized inflation are close';

  return {
    version,
    status: published.length === marketLegs.length && realized.status === 'calculated' && published.every((leg) => leg.status === 'calculated') ? 'calculated' : 'provisional',
    asOf: published.map((leg) => leg.asOf).sort().at(0) ?? null,
    market: marketLegs,
    realized,
    anchor: { key: anchor.key, name: anchor.name, percent: anchor.percent },
    gapVsRealized: gap,
    termSlope,
    state,
    read: gap === null
      ? `${anchor.name} prices ${anchor.percent}% inflation, the ${ordinal(anchor.percentile)} percentile of its last ${anchor.rankedAgainst} observations. A realized CPI rate is required before the two can be compared.`
      : `${state}: ${anchor.name} at ${anchor.percent}% against ${realized.yearOverYearPercent}% year-over-year CPI, a ${gap > 0 ? '+' : ''}${gap}-point gap.${realized.futureDated ? ` The CPI observation is dated ${realized.asOf}, ahead of today — the feed is returning a date it should not.` : realized.lagDays > 45 ? ` The CPI leg is ${realized.lagDays} days old, which is the statistic's own release lag, not a stale feed.` : ''}${termSlope === null ? '' : ` The breakeven curve is ${termSlope > 0 ? 'upward-sloping' : termSlope < 0 ? 'inverted' : 'flat'} at ${termSlope} points.`}`,
    methodology: 'Breakevens and the 5-year, 5-year forward are market prices and are ranked against their own histories. Realized inflation is computed from the CPI index itself, year over year and as a three-month annualized rate, so its vintage is the index\'s own and its release lag is published rather than hidden. The gap between the market anchor and realized CPI is the model\'s point: neither leg is presented as a substitute for the other.',
  };
}

// Roughly what one 25bp move is worth to the front of the curve. The 2-year
// does not move one-for-one with the funds rate, so this is a scaling of the
// curve's own signal and is labelled as an implied count, never as a forecast.
const BASIS_POINTS_PER_MOVE = 25;

/**
 * How many cuts or hikes the curve is pricing, inferred from the front end
 * against the policy rate. Fed funds futures are not freely available, so this
 * is explicitly a curve-implied proxy and says so in every reading.
 */
export function calculateRatePath(seriesList, { movesHorizonMonths = 24 } = {}) {
  const version = 'rate-path-v1';
  const twoYear = seriesPoints(seriesList, 'us2yYield');
  const threeMonth = seriesPoints(seriesList, 'us3mYield');
  const tenYear = seriesPoints(seriesList, 'us10yYield');
  if (!twoYear.length || !threeMonth.length) {
    return unavailable(version, 'Needs both the 2-year and 3-month Treasury yields to infer a path.', { legs: [] });
  }
  const front = threeMonth.at(-1);
  const belly = latestAtOrBefore(twoYear, front.date);
  if (!belly) {
    return unavailable(version, 'The 2-year and 3-month yields do not share a recent date.', { legs: [] });
  }
  const gapBasisPoints = (belly.value - front.value) * 100;
  const impliedMoves = gapBasisPoints / BASIS_POINTS_PER_MOVE;
  const direction = impliedMoves <= -0.5 ? 'cuts' : impliedMoves >= 0.5 ? 'hikes' : 'no material change';

  const legs = [
    { key: 'threeMonth', name: '3-month bill', percent: round(front.value, 2), asOf: front.date },
    { key: 'twoYear', name: '2-year note', percent: round(belly.value, 2), asOf: belly.date },
    ...(tenYear.length ? [{ key: 'tenYear', name: '10-year note', percent: round(latestAtOrBefore(tenYear, front.date)?.value, 2), asOf: latestAtOrBefore(tenYear, front.date)?.date ?? null }] : []),
  ];

  // How the pricing has moved: the same gap 60 sessions ago.
  const pastFront = threeMonth.at(-61);
  const pastBelly = pastFront ? latestAtOrBefore(twoYear, pastFront.date) : null;
  const pastMoves = pastFront && pastBelly ? ((pastBelly.value - pastFront.value) * 100) / BASIS_POINTS_PER_MOVE : null;
  const shift = Number.isFinite(pastMoves) ? round(impliedMoves - pastMoves, 2) : null;

  return {
    version,
    status: tenYear.length ? 'calculated' : 'provisional',
    asOf: front.date,
    legs,
    gapBasisPoints: round(gapBasisPoints, 1),
    impliedMoves: round(impliedMoves, 2),
    impliedMovesRounded: Math.round(impliedMoves),
    direction,
    horizonMonths: movesHorizonMonths,
    shift60d: shift,
    read: `The curve prices roughly ${Math.abs(round(impliedMoves, 1))} ${Math.abs(impliedMoves) === 1 ? 'move' : 'moves'} of ${direction} over about ${movesHorizonMonths} months: the 2-year sits ${round(gapBasisPoints, 0)}bp ${gapBasisPoints >= 0 ? 'above' : 'below'} the 3-month bill.${shift === null ? '' : ` That pricing has moved ${shift > 0 ? '+' : ''}${shift} moves over the last 60 sessions.`} This is inferred from the Treasury curve, not read from fed funds futures, which are not freely available.`,
    methodology: `The 3-month bill tracks the policy rate closely and the 2-year embeds the expected path over roughly ${movesHorizonMonths} months. Their difference, divided by ${BASIS_POINTS_PER_MOVE}bp, gives an implied count of moves. The 2-year does not move one-for-one with the funds rate, so this is a scaled reading of the curve's own signal and is labelled as implied throughout — it is not a probability and not a forecast.`,
  };
}

const QUARTER_END_MONTHS = [2, 5, 8, 11];

/**
 * The forward liquidity calendar. The two most predictable liquidity shocks are
 * the quarter-end Treasury general account rebuild and the reverse-repo drain,
 * and the runway model has no forward view at all.
 *
 * There is no free feed of Treasury financing schedules, so the TGA leg is
 * built from the account's own seasonal history — the average change across the
 * same calendar window in prior years — and is published as a seasonal
 * expectation, never as an announced schedule.
 */
export function calculateLiquidityCalendar(seriesList, { horizonDays = 90, now = new Date(), runway = null } = {}) {
  const version = 'liquidity-calendar-v1';
  const treasury = seriesPoints(seriesList, 'treasuryGeneralAccount');
  const reverseRepo = seriesPoints(seriesList, 'reverseRepo');
  const fed = seriesPoints(seriesList, 'fedBalanceSheet');
  if (treasury.length < 380) {
    return unavailable(version, `Needs at least a year of TGA history to read its own seasonality; ${treasury.length} observations available.`, { events: [] });
  }

  const today = new Date(now);
  const asOf = treasury.at(-1).date;

  const nextQuarterEnd = (() => {
    const year = today.getUTCFullYear();
    for (const month of QUARTER_END_MONTHS) {
      const candidate = new Date(Date.UTC(year, month + 1, 0));
      if (candidate > today) return candidate;
    }
    return new Date(Date.UTC(year + 1, 3, 0));
  })();
  const daysToQuarterEnd = Math.round((nextQuarterEnd - today) / DAY_MS);

  // The TGA's own change across this calendar window in each prior year.
  const seasonalSamples = [];
  for (let yearsBack = 1; yearsBack <= 5; yearsBack += 1) {
    const start = new Date(today.getTime() - (yearsBack * 365 * DAY_MS));
    const end = new Date(start.getTime() + (horizonDays * DAY_MS));
    const startPoint = latestAtOrBefore(treasury, start.toISOString().slice(0, 10));
    const endPoint = latestAtOrBefore(treasury, end.toISOString().slice(0, 10));
    if (!startPoint || !endPoint || startPoint.date === endPoint.date) continue;
    seasonalSamples.push({ yearsBack, change: endPoint.value - startPoint.value });
  }
  const seasonalChange = seasonalSamples.length >= 2 ? mean(seasonalSamples.map((sample) => sample.change)) : null;
  const seasonalAgreement = seasonalSamples.length >= 2
    ? Math.max(seasonalSamples.filter((sample) => sample.change > 0).length, seasonalSamples.filter((sample) => sample.change < 0).length) / seasonalSamples.length
    : null;

  // The runway model already measures the level, the drain and the months of
  // cushion. Recomputing them here produced a second set of numbers for the
  // same quantities that disagreed by whatever the two windows differed by, so
  // the calendar defers to it and only computes them when it is absent.
  const reverseRepoLevel = Number.isFinite(runway?.reverseRepoLevel) ? runway.reverseRepoLevel : reverseRepo.at(-1)?.value ?? null;
  const reverseRepoDrain = Number.isFinite(runway?.drainPerMonth) && runway.drainPerMonth > 0
    ? -runway.drainPerMonth
    : (() => {
      if (reverseRepo.length < 70) return null;
      const latest = reverseRepo.at(-1);
      const prior = pointDaysBefore(reverseRepo, latest.date, 91);
      return prior ? (latest.value - prior.value) / (prior.spanDays / DAYS_PER_MONTH) : null;
    })();
  const monthsOfCushion = Number.isFinite(runway?.runwayMonths)
    ? runway.runwayMonths
    : Number.isFinite(reverseRepoLevel) && Number.isFinite(reverseRepoDrain) && reverseRepoDrain < 0
      ? reverseRepoLevel / Math.abs(reverseRepoDrain)
      : null;
  const cushionSource = Number.isFinite(runway?.runwayMonths) ? runway.version ?? 'liquidity-runway-v1' : 'this model';

  const fedRunRate = (() => {
    if (fed.length < 14) return null;
    const latest = fed.at(-1);
    const prior = pointDaysBefore(fed, latest.date, 91);
    return prior ? (latest.value - prior.value) / (prior.spanDays / DAYS_PER_MONTH) : null;
  })();

  const events = [
    {
      key: 'quarterEnd',
      name: 'Quarter-end',
      date: nextQuarterEnd.toISOString().slice(0, 10),
      daysAway: daysToQuarterEnd,
      kind: 'calendar',
      note: 'Quarter-end reliably pulls cash into the Treasury general account and out of reserves, then releases it. The date is arithmetic; the size is not announced in advance.',
    },
    ...(seasonalChange === null ? [] : [{
      key: 'tgaSeasonal',
      name: `TGA seasonal path, next ${horizonDays} days`,
      date: null,
      daysAway: horizonDays,
      kind: 'seasonal',
      expectedChangeUsdMillions: Math.round(seasonalChange),
      liquidityEffectUsdMillions: Math.round(-seasonalChange),
      samples: seasonalSamples.length,
      agreement: Math.round(seasonalAgreement * 100),
      note: `Averaged across the same calendar window in ${seasonalSamples.length} prior years, ${Math.round(seasonalAgreement * 100)}% of which moved the same way. A seasonal expectation from the account's own history, not an announced financing schedule — no free feed of those exists.`,
    }]),
    ...(monthsOfCushion === null ? [] : [{
      key: 'rrpExhaustion',
      name: 'Reverse-repo facility exhausted',
      date: new Date(today.getTime() + (monthsOfCushion * 30.44 * DAY_MS)).toISOString().slice(0, 10),
      daysAway: Math.round(monthsOfCushion * 30.44),
      kind: 'projection',
      note: `Projected from the current level and the trailing drain rate measured by ${cushionSource}. Straight-line: the drain has not been constant and the projection moves with it.`,
    }]),
  ].sort((left, right) => left.daysAway - right.daysAway);

  const nearest = events[0] ?? null;
  return {
    version,
    status: seasonalChange === null ? 'provisional' : 'calculated',
    asOf,
    horizonDays,
    events,
    quarterEnd: { date: nextQuarterEnd.toISOString().slice(0, 10), daysAway: daysToQuarterEnd },
    tgaSeasonalChangeUsdMillions: seasonalChange === null ? null : Math.round(seasonalChange),
    reverseRepoLevel,
    reverseRepoDrainPerMonth: reverseRepoDrain === null ? null : Math.round(reverseRepoDrain),
    fedRunRatePerMonth: fedRunRate === null ? null : Math.round(fedRunRate),
    monthsOfCushion: monthsOfCushion === null ? null : round(monthsOfCushion, 1),
    cushionSource,
    read: nearest
      ? `Next up: ${nearest.name}${nearest.date ? ` on ${nearest.date}` : ''}, ${nearest.daysAway} days away.${seasonalChange === null ? '' : ` The TGA's own seasonality points to a ${seasonalChange >= 0 ? 'rebuild' : 'drawdown'} of ${Math.abs(Math.round(seasonalChange / 1000))}bn over the next ${horizonDays} days, which would ${seasonalChange >= 0 ? 'drain' : 'add'} reserves.`}`
      : 'No forward liquidity event could be placed from the available history.',
    methodology: `The quarter-end date is arithmetic. The TGA path is the average change across the same calendar window in up to five prior years, published with the number of samples and how many agreed on direction — a seasonal expectation from the account's own history, because no free feed of Treasury financing schedules exists. Reverse-repo exhaustion is a straight-line projection from the current level and the trailing 91-day drain, which is only as good as the assumption that the drain holds.`,
  };
}

const REGIME_BANDS = [
  { name: 'Expansion / risk-on', minimum: 70 },
  { name: 'Constructive', minimum: 58 },
  { name: 'Transition / choppy', minimum: 36 },
  { name: 'Contraction / risk-off', minimum: 0 },
];

function bandFor(score) {
  if (!Number.isFinite(score)) return null;
  return REGIME_BANDS.find((band) => score >= band.minimum)?.name ?? null;
}

/**
 * The regime's own history, recomputed at every past date from the same driver
 * definitions, with each transition logged alongside what the benchmark did
 * next. The regime engine classifies today and keeps no record, so it has never
 * been able to say whether its own labels have meant anything here.
 *
 * Scores are recomputed on the same series the live model uses, which means
 * they carry the current vintage of those series rather than the values that
 * were visible at the time — a revised series makes this a hindsight study, not
 * a backtest, and it is labelled as one.
 */
export function calculateRegimeTransitions(seriesList, benchmarkPoints, { stepDays = 7, minimumHistoryDays = 730, forwardWindows = [21, 63] } = {}) {
  const version = 'macro-regime-history-v1';
  const financialConditions = seriesPoints(seriesList, 'financialConditions');
  const credit = seriesPoints(seriesList, 'highYieldSpread');
  const volatility = seriesPoints(seriesList, 'vix');
  const legs = [financialConditions, credit, volatility].filter((points) => points.length);
  if (legs.length < 2) {
    return unavailable(version, 'Needs at least two of financial conditions, high-yield spreads and volatility to recompute a historical score.', { transitions: [] });
  }

  const start = legs.map((points) => points[0].date).sort().at(-1);
  const end = legs.map((points) => points.at(-1).date).sort().at(0);
  if (new Date(end) - new Date(start) < minimumHistoryDays * DAY_MS) {
    return unavailable(version, `Needs ${Math.round(minimumHistoryDays / 365)} years of overlapping history; ${Math.round((new Date(end) - new Date(start)) / DAY_MS)} days available.`, { transitions: [] });
  }

  const changeOver = (points, date, days) => {
    const current = latestAtOrBefore(points, date);
    const prior = current ? pointDaysBefore(points, current.date, days) : null;
    return current && prior ? current.value - prior.value : null;
  };
  const scoreAt = (date) => {
    const nfci = latestAtOrBefore(financialConditions, date)?.value ?? null;
    const spread = latestAtOrBefore(credit, date)?.value ?? null;
    const vix = latestAtOrBefore(volatility, date)?.value ?? null;
    const nfciChange = changeOver(financialConditions, date, 91);
    const creditChange = changeOver(credit, date, 91);
    // The same driver definitions and weights the live regime uses, restricted
    // to the three that can be recomputed from raw series alone.
    const drivers = [
      { score: Number.isFinite(nfci) ? clamp(50 - (nfci * 40) - (Number.isFinite(nfciChange) ? nfciChange * 30 : 0)) : null, weight: 0.2 },
      { score: Number.isFinite(spread) ? clamp(80 - ((spread - 3) * 15) - (Number.isFinite(creditChange) ? creditChange * 20 : 0)) : null, weight: 0.18 },
      { score: Number.isFinite(vix) ? clamp(100 - ((vix - 12) * 3.5)) : null, weight: 0.12 },
    ].filter((driver) => Number.isFinite(driver.score));
    if (drivers.length < 2) return null;
    const weight = drivers.reduce((total, driver) => total + driver.weight, 0);
    return Math.round(drivers.reduce((total, driver) => total + (driver.score * driver.weight), 0) / weight);
  };

  const benchmark = (benchmarkPoints ?? [])
    .filter((point) => Number.isFinite(point?.value) && (point?.date || point?.timestamp))
    .map((point) => ({ date: String(point.date ?? point.timestamp).slice(0, 10), value: point.value }))
    .sort((left, right) => left.date.localeCompare(right.date));
  const forwardReturn = (date, sessions) => {
    const index = benchmark.findIndex((point) => point.date >= date);
    if (index < 0) return null;
    const from = benchmark[index];
    const to = benchmark[index + sessions];
    return from && to && from.value > 0 ? round(((to.value / from.value) - 1) * 100, 2) : null;
  };

  const samples = [];
  for (let time = new Date(start).getTime(); time <= new Date(end).getTime(); time += stepDays * DAY_MS) {
    const date = new Date(time).toISOString().slice(0, 10);
    const score = scoreAt(date);
    if (score === null) continue;
    samples.push({ date, score, regime: bandFor(score) });
  }
  if (samples.length < 20) {
    return unavailable(version, `Only ${samples.length} historical scores could be recomputed; at least 20 are needed.`, { transitions: [] });
  }

  const transitions = [];
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].regime === samples[index - 1].regime) continue;
    transitions.push({
      date: samples[index].date,
      from: samples[index - 1].regime,
      to: samples[index].regime,
      score: samples[index].score,
      ...Object.fromEntries(forwardWindows.map((sessions) => [`forward${sessions}`, forwardReturn(samples[index].date, sessions)])),
    });
  }

  const dwell = {};
  let runRegime = samples[0].regime;
  let runLength = 1;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].regime === runRegime) {
      runLength += 1;
      continue;
    }
    dwell[runRegime] = [...(dwell[runRegime] ?? []), runLength * stepDays];
    runRegime = samples[index].regime;
    runLength = 1;
  }
  dwell[runRegime] = [...(dwell[runRegime] ?? []), runLength * stepDays];

  const current = samples.at(-1);
  const currentRun = (() => {
    let length = 1;
    for (let index = samples.length - 2; index >= 0 && samples[index].regime === current.regime; index -= 1) length += 1;
    return length * stepDays;
  })();
  const typicalDwell = dwell[current.regime]?.length ? Math.round(mean(dwell[current.regime])) : null;

  return {
    version,
    status: benchmark.length ? 'calculated' : 'provisional',
    asOf: current.date,
    reason: benchmark.length ? null : 'Forward returns need a benchmark history; the transition dates publish without them.',
    stepDays,
    samples: samples.length,
    coveredFrom: samples[0].date,
    transitions,
    current: { regime: current.regime, score: current.score, runDays: currentRun, typicalDwellDays: typicalDwell },
    dwellDays: Object.fromEntries(Object.entries(dwell).map(([regime, lengths]) => [regime, { episodes: lengths.length, medianDays: Math.round(mean(lengths)) }])),
    read: `${transitions.length} regime ${transitions.length === 1 ? 'change' : 'changes'} across ${samples.length} recomputed readings since ${samples[0].date}. The tape has been in ${current.regime} for ${currentRun} days${typicalDwell ? `, against a ${typicalDwell}-day average for that regime in this history` : ''}.`,
    methodology: `The score is recomputed every ${stepDays} days from financial conditions, high-yield spreads and volatility using the same weights and clamps the live regime applies to them, then bucketed into the same bands. This is a hindsight study rather than a backtest: the series carry their current vintage, so a revised observation is used at a date when its revision did not exist. Forward returns are the benchmark's move over the following sessions from the transition date, and are omitted where the history does not extend far enough.`,
  };
}

/**
 * A growth nowcast from freely available market proxies. The dollar-smile model
 * asks whether global growth is weak; until now the only input it had was an
 * equity return spread, which is one proxy standing in for a whole question.
 *
 * Each leg is scored on the same 0-100 axis where higher means stronger growth,
 * and the composite needs three of them.
 */
export function calculateGrowthNowcast({ copper, gold, cyclicals = [], defensives = [], emerging, developed, curveSpread = null, breakeven = null } = {}, { window = 60, minimumLegs = 3 } = {}) {
  const version = 'growth-nowcast-v1';
  const toPoints = (points) => (points ?? [])
    .filter((point) => Number.isFinite(point?.value) && (point?.date || point?.timestamp))
    .map((point) => ({ date: String(point.date ?? point.timestamp).slice(0, 10), value: point.value }))
    .sort((left, right) => left.date.localeCompare(right.date));

  const changeOver = (points, bars) => {
    const series = toPoints(points);
    if (series.length <= bars) return null;
    const start = series.at(-(bars + 1)).value;
    return start > 0 ? ((series.at(-1).value / start) - 1) * 100 : null;
  };
  const basketChange = (baskets) => {
    const changes = baskets.map((points) => changeOver(points, window)).filter(Number.isFinite);
    return changes.length === baskets.length && baskets.length ? mean(changes) : null;
  };

  const ratioChange = (numerator, denominator) => {
    const left = toPoints(numerator);
    const right = new Map(toPoints(denominator).map((point) => [point.date, point.value]));
    const aligned = left.filter((point) => right.has(point.date)).map((point) => ({ date: point.date, value: point.value / right.get(point.date) }));
    return aligned.length > window && aligned.at(-(window + 1)).value > 0
      ? ((aligned.at(-1).value / aligned.at(-(window + 1)).value) - 1) * 100
      : null;
  };

  const copperGold = ratioChange(copper, gold);
  const cyclicalChange = basketChange(cyclicals);
  const defensiveChange = basketChange(defensives);
  const cyclicalSpread = Number.isFinite(cyclicalChange) && Number.isFinite(defensiveChange) ? cyclicalChange - defensiveChange : null;
  const emChange = changeOver(emerging, window);
  const dmChange = changeOver(developed, window);
  const emSpread = Number.isFinite(emChange) && Number.isFinite(dmChange) ? emChange - dmChange : null;

  const legs = [
    { key: 'copperGold', name: 'Copper versus gold', value: copperGold, score: Number.isFinite(copperGold) ? clamp(50 + (copperGold * 2.5)) : null, note: 'An industrial metal against a monetary one: the ratio rises when the market prices real activity over safety.' },
    { key: 'cyclicalDefensive', name: 'Cyclicals versus defensives', value: cyclicalSpread, score: Number.isFinite(cyclicalSpread) ? clamp(50 + (cyclicalSpread * 4)) : null, note: 'Equal-weight cyclical baskets against defensive ones over the same window.' },
    { key: 'emergingDeveloped', name: 'Emerging versus developed equity', value: emSpread, score: Number.isFinite(emSpread) ? clamp(50 + (emSpread * 3)) : null, note: 'Emerging markets lead when global trade and commodity demand are expanding.' },
    { key: 'curve', name: 'Curve slope', value: curveSpread, score: Number.isFinite(curveSpread) ? clamp(50 + (curveSpread * 25)) : null, note: 'A steeper curve prices growth and inflation ahead; an inverted one prices the opposite.' },
    { key: 'breakeven', name: 'Inflation breakeven momentum', value: breakeven, score: Number.isFinite(breakeven) ? clamp(50 + (breakeven * 40)) : null, note: 'Breakevens rise with demand as well as with supply shocks, so this leg is weighted like the others rather than trusted alone.' },
  ];
  const scored = legs.filter((leg) => Number.isFinite(leg.score));
  if (scored.length < minimumLegs) {
    return unavailable(version, `Needs ${minimumLegs} of the ${legs.length} growth proxies; ${scored.length} could be calculated.`, {
      legs: legs.map((leg) => ({ ...leg, value: round(leg.value, 2), score: Number.isFinite(leg.score) ? Math.round(leg.score) : null })),
      score: null,
    });
  }

  const score = Math.round(mean(scored.map((leg) => leg.score)));
  const state = score >= 65 ? 'Accelerating' : score >= 55 ? 'Firm' : score >= 45 ? 'Flat' : score >= 35 ? 'Softening' : 'Contracting';
  const disagreement = Math.max(...scored.map((leg) => leg.score)) - Math.min(...scored.map((leg) => leg.score));

  return {
    version,
    status: scored.length === legs.length ? 'calculated' : 'provisional',
    window,
    score,
    state,
    coverage: Math.round((scored.length / legs.length) * 100),
    disagreement: Math.round(disagreement),
    legs: legs.map((leg) => ({ ...leg, value: round(leg.value, 2), score: Number.isFinite(leg.score) ? Math.round(leg.score) : null })),
    missing: legs.filter((leg) => !Number.isFinite(leg.score)).map((leg) => leg.name),
    read: `${state} at ${score}/100 from ${scored.length} of ${legs.length} proxies over ${window} sessions.${disagreement >= 45 ? ` The proxies disagree by ${Math.round(disagreement)} points, so the composite is an average of genuinely different readings rather than a consensus.` : ''}`,
    methodology: `Each proxy is scored 0-100 on the same axis, higher meaning stronger growth, and the composite is their unweighted average across whichever publish. These are market prices standing in for activity data, which they lead but do not measure: a commodity supply shock moves copper against gold without any change in demand. The spread between the strongest and weakest leg is published so a wide disagreement is visible rather than averaged away.`,
  };
}
