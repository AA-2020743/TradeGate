import { percentileRank } from './statistics.js';
import { resolveVintage } from './vintage.js';

/**
 * What an asset is worth in gold, and what that says that its dollar price
 * does not.
 *
 * A dollar price mixes two things: how the asset did, and what happened to the
 * unit it is quoted in. Dividing by gold removes the second, so the ratio
 * answers a different question - not "did this go up" but "did this buy more
 * of the oldest monetary asset than it used to". Over long horizons the two
 * answers can point opposite ways, and the gap between them is the part of a
 * dollar gain that was the currency moving rather than the asset.
 *
 * Two readings come out of it. *Within* an asset, where its gold ratio sits
 * against its own history says whether today is expensive or cheap on that
 * measure. *Across* assets, ranking those percentiles against each other says
 * which is winning in hard-money terms, which is not always the one winning in
 * dollars.
 *
 * For equity indices the model reads price and total return separately,
 * because the difference is not cosmetic: a price index can be flat in gold
 * terms over a decade while the same index with dividends reinvested is well
 * ahead, and that gap *is* the real return, delivered as income rather than
 * as price.
 *
 * Limits, published with it. Gold is a volatile denominator, so a falling
 * ratio can be gold strength rather than asset weakness - the model publishes
 * both legs' own returns so the two are separable. Ratios of price indices
 * ignore dividends by construction, which is why the total-return series is
 * carried alongside rather than instead. And a ratio percentile is a statement
 * about this history only; a series that has spent its whole life in one
 * regime cannot rank today against a different one.
 */

const HORIZONS = [
  { key: 'year', sessions: 252, label: '1 year' },
  { key: 'threeYear', sessions: 756, label: '3 years' },
  { key: 'fiveYear', sessions: 1260, label: '5 years' },
];
const RANK_WINDOW = 2520;
const STRETCH_WINDOW = 200;

function alignByDate(numerator, denominator) {
  const byDate = new Map((denominator ?? []).filter((point) => Number.isFinite(point?.value) && point.value > 0).map((point) => [point.date, point.value]));
  return (numerator ?? [])
    .filter((point) => Number.isFinite(point?.value) && point.value > 0 && byDate.has(point.date))
    .map((point) => ({ date: point.date, numerator: point.value, denominator: byDate.get(point.date), ratio: point.value / byDate.get(point.date) }));
}

function changeOver(values, sessions) {
  if (values.length <= sessions) return null;
  const base = values.at(-(sessions + 1));
  return base > 0 ? ((values.at(-1) / base) - 1) * 100 : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** One asset priced in another, with both legs' own returns kept separable. */
export function calculateRatioValuation({ key, name, numeratorName, denominatorName, numerator, denominator, note = null } = {}) {
  const aligned = alignByDate(numerator, denominator);
  const shortest = HORIZONS[0].sessions;
  if (aligned.length <= shortest) {
    return {
      key,
      name,
      status: 'unavailable',
      reason: `Needs more than ${shortest} sessions where ${numeratorName} and ${denominatorName} both publish; ${aligned.length} available.`,
      observations: aligned.length,
      horizons: [],
    };
  }

  const ratios = aligned.map((point) => point.ratio);
  const numerators = aligned.map((point) => point.numerator);
  const denominators = aligned.map((point) => point.denominator);

  const horizons = HORIZONS.map((horizon) => {
    const ratioChange = changeOver(ratios, horizon.sessions);
    const numeratorChange = changeOver(numerators, horizon.sessions);
    const denominatorChange = changeOver(denominators, horizon.sessions);
    if (![ratioChange, numeratorChange, denominatorChange].every(Number.isFinite)) {
      return { ...horizon, status: 'unavailable', reason: `Needs ${horizon.sessions + 1} aligned sessions; ${aligned.length} available.` };
    }
    return {
      ...horizon,
      status: 'calculated',
      // In dollars, in gold, and the wedge between them. The wedge is the
      // denominator's contribution, not a claim about why gold moved: calling
      // it debasement would assert a cause the ratio cannot establish, since
      // gold rising on its own demand looks identical here.
      nominalPercent: round(numeratorChange),
      denominatorPercent: round(denominatorChange),
      realPercent: round(ratioChange),
      denominatorEffectPoints: round(numeratorChange - ratioChange),
    };
  });

  const rankSlice = ratios.slice(-RANK_WINDOW);
  const percentile = percentileRank(rankSlice, ratios.at(-1));
  const average = ratios.length >= STRETCH_WINDOW
    ? ratios.slice(-STRETCH_WINDOW).reduce((total, value) => total + value, 0) / STRETCH_WINDOW
    : null;
  const stretchPercent = Number.isFinite(average) && average > 0 ? round(((ratios.at(-1) / average) - 1) * 100) : null;
  const published = horizons.filter((horizon) => horizon.status === 'calculated');

  return {
    key,
    name,
    numeratorName,
    denominatorName,
    status: published.length === HORIZONS.length ? 'calculated' : published.length ? 'provisional' : 'unavailable',
    asOf: aligned.at(-1).date,
    observations: aligned.length,
    ratio: round(ratios.at(-1), 6),
    percentile,
    rankedAgainst: rankSlice.length,
    stretchPercent,
    horizons,
    note,
    reason: published.length ? undefined : 'No horizon could be measured from the aligned history.',
  };
}

/**
 * The pair a reader is really asking about when they ask what the market has
 * done: the same index with and without dividends, both priced in gold.
 */
export function compareIncomeContribution(priceValuation, totalReturnValuation) {
  if (priceValuation?.status === 'unavailable' || totalReturnValuation?.status === 'unavailable') {
    return { status: 'unavailable', reason: 'Both the price and total-return series must publish before the income share can be separated.' };
  }
  const horizons = HORIZONS.map((horizon) => {
    const price = priceValuation.horizons.find((entry) => entry.key === horizon.key);
    const total = totalReturnValuation.horizons.find((entry) => entry.key === horizon.key);
    if (price?.status !== 'calculated' || total?.status !== 'calculated') {
      return { ...horizon, status: 'unavailable', reason: 'One of the two series does not reach this horizon.' };
    }
    return {
      ...horizon,
      status: 'calculated',
      priceRealPercent: price.realPercent,
      totalRealPercent: total.realPercent,
      // What dividends added, measured in gold rather than in dollars, so it
      // is a real contribution rather than a nominal one.
      incomePoints: round(total.realPercent - price.realPercent),
    };
  });
  const published = horizons.filter((horizon) => horizon.status === 'calculated');
  if (!published.length) return { status: 'unavailable', reason: 'Neither series reaches a shared horizon.', horizons };

  const longest = published.at(-1);
  return {
    status: published.length === HORIZONS.length ? 'calculated' : 'provisional',
    horizons,
    read: `Over ${longest.label} and priced in gold, the index returned ${longest.priceRealPercent > 0 ? '+' : ''}${longest.priceRealPercent}% on price and ${longest.totalRealPercent > 0 ? '+' : ''}${longest.totalRealPercent}% with dividends reinvested. ${
      longest.priceRealPercent <= 0 && longest.totalRealPercent > 0
        ? `The price index bought no more gold than it did ${longest.label} ago; every point of real return came from income.`
        : `Income added ${longest.incomePoints} points of that.`
    }`,
    methodology: 'Both series are divided by the same gold history and compared over identical windows, so the difference between them is the dividend contribution measured in gold rather than in dollars. A price index priced in gold answers whether the shares themselves buy more metal than before; the total-return version answers whether an investor who reinvested did.',
  };
}

/** Which assets are strongest in hard-money terms, which is not the dollar ranking. */
export function rankHardMoneyStrength(valuations) {
  const ranked = (valuations ?? [])
    .filter((entry) => entry?.status !== 'unavailable' && Number.isFinite(entry?.percentile))
    .map((entry) => ({
      key: entry.key,
      name: entry.name,
      percentile: entry.percentile,
      stretchPercent: entry.stretchPercent,
      yearRealPercent: entry.horizons?.find((horizon) => horizon.key === 'year')?.realPercent ?? null,
      yearNominalPercent: entry.horizons?.find((horizon) => horizon.key === 'year')?.nominalPercent ?? null,
    }))
    .sort((left, right) => right.percentile - left.percentile);

  if (ranked.length < 2) {
    return { status: 'unavailable', reason: `Needs two ratios with a usable rank; ${ranked.length} available.`, entries: ranked };
  }

  // The finding worth surfacing: an asset up in dollars and down in gold.
  const diverging = ranked.filter((entry) => Number.isFinite(entry.yearNominalPercent) && Number.isFinite(entry.yearRealPercent)
    && entry.yearNominalPercent > 0 && entry.yearRealPercent < 0);

  return {
    status: 'calculated',
    entries: ranked,
    strongest: ranked[0],
    weakest: ranked.at(-1),
    diverging: diverging.map((entry) => entry.key),
    read: `${ranked[0].name} sits highest against its own gold history at the ${ranked[0].percentile}th percentile; ${ranked.at(-1).name} sits lowest at the ${ranked.at(-1).percentile}th.${
      diverging.length
        ? ` ${diverging.map((entry) => entry.name).join(', ')} ${diverging.length === 1 ? 'is' : 'are'} higher in dollars over the past year and lower in gold, so that gain was the currency rather than the asset.`
        : ' No asset here is up in dollars and down in gold over the past year.'
    }`,
    methodology: 'Each asset is ranked by where its own gold ratio sits in its own history, not against the others directly - the ratios have different units and only their percentiles are comparable. An asset up in dollars and down in gold over the same window is flagged, because that is the case where the dollar chart and the gold chart disagree about direction.',
  };
}

export { HORIZONS as HARD_MONEY_HORIZONS };
