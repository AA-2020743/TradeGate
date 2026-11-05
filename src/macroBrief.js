/**
 * The Macro page's answers to the questions an investor asks of it, each in
 * one word and one sentence, with a scale where the answer is a position.
 *
 * The page runs to eight tabs of models - net liquidity, central-bank balance
 * sheets, the dollar composite, the yield curve, breakevens, growth proxies,
 * the recession model - and each speaks its own vocabulary. This reads the
 * payloads those panels already draw and says what they mean, naming the tab
 * that backs each answer. It describes today; none of it is a forecast except
 * the recession model, which is one and says so.
 *
 * A card whose model did not publish is left out rather than shown blank.
 */

const published = (model) => model && (model.status === 'calculated' || model.status === 'provisional');
const scaleOf = (value, left, right, polarity, label, min = 0, max = 100) => (Number.isFinite(value) ? { value, min, max, left, right, polarity, label } : null);

function liquidityCard(model) {
  if (!published(model) || !Number.isFinite(model.score)) return null;
  const answer = model.regime === 'Expansion' ? 'Growing' : model.regime === 'Contraction' ? 'Shrinking' : 'Flat';
  const pace = { Accelerating: ', and the pace is picking up', Decelerating: ', but the pace is slowing', Steady: ', at a steady pace' }[model.momentum] ?? '';
  return {
    key: 'liquidity',
    question: 'Is US liquidity growing?',
    answer,
    tone: answer === 'Growing' ? 'positive' : answer === 'Shrinking' ? 'negative' : 'neutral',
    sentence: `The cash the Fed's balance sheet leaves in markets, after the Treasury's account and reverse repo, is ${answer === 'Growing' ? 'growing' : answer === 'Shrinking' ? 'shrinking' : 'roughly flat'} over 13 weeks${pace}. More of it has tended to support risk assets.`,
    scale: scaleOf(model.score, 'Shrinking', 'Growing', 'pos-right', `Impulse ${model.score}/100`),
    tab: 'Liquidity',
  };
}

function globalCard(model) {
  if (!published(model) || !Number.isFinite(model.score)) return null;
  const answer = model.regime === 'Expansion' ? 'Growing' : model.regime === 'Contraction' ? 'Shrinking' : 'Flat';
  return {
    key: 'global',
    question: 'Is global liquidity growing?',
    answer,
    tone: answer === 'Growing' ? 'positive' : answer === 'Shrinking' ? 'negative' : 'neutral',
    sentence: `The major central banks' balance sheets, measured in dollars, are ${answer === 'Growing' ? 'expanding' : answer === 'Shrinking' ? 'contracting' : 'roughly unchanged'} over 13 weeks. A weaker dollar inflates this figure on its own, so it moves with the currency as well as with policy.`,
    scale: scaleOf(model.score, 'Shrinking', 'Growing', 'pos-right', `Impulse ${model.score}/100`),
    tab: 'Global',
  };
}

function dollarCard(model) {
  if (!published(model) || !Number.isFinite(model.score)) return null;
  const answer = model.regime ?? 'Neutral';
  const firm = ['Strong', 'Firm'].includes(answer);
  const soft = ['Weak', 'Soft'].includes(answer);
  return {
    key: 'dollar',
    question: 'Is the dollar strong?',
    answer,
    // Neither good nor bad in itself: a firm dollar tightens conditions for
    // risk assets and commodities, and helps anyone holding dollars.
    tone: 'neutral',
    sentence: `${firm ? 'The dollar is firm' : soft ? 'The dollar is soft' : 'The dollar is neither firm nor soft'} on the composite of its trend, rate differentials and liquidity. ${firm ? 'A firm dollar usually tightens conditions for global risk assets and commodities.' : soft ? 'A soft dollar usually eases conditions for global risk assets and commodities.' : 'It is not pushing global conditions either way.'}`,
    scale: scaleOf(model.score, 'Weak', 'Strong', 'none', `Composite ${model.score}/100`),
    tab: 'FX',
  };
}

function growthCard(model) {
  if (!published(model) || !Number.isFinite(model.score)) return null;
  const answer = model.state ?? 'Flat';
  const scored = (model.legs ?? []).filter((leg) => Number.isFinite(leg.score));
  return {
    key: 'growth',
    question: 'Is growth picking up?',
    answer,
    tone: ['Accelerating', 'Firm'].includes(answer) ? 'positive' : ['Softening', 'Contracting'].includes(answer) ? 'negative' : 'neutral',
    sentence: `Market prices that move with the economy - copper against gold, cyclical against defensive stocks, emerging against developed markets, the curve and breakevens - read ${answer.toLowerCase()} across ${scored.length} of ${(model.legs ?? []).length} measures over 60 sessions. These are market signals, not official data, which arrives later.`,
    scale: scaleOf(model.score, 'Contracting', 'Accelerating', 'pos-right', `Growth ${model.score}/100`),
    tab: 'Rates',
  };
}

function inflationCard(model) {
  const cpi = model?.realized?.yearOverYearPercent;
  if (!published(model) || !Number.isFinite(cpi)) return null;
  const answer = cpi >= 4 ? 'High' : cpi > 2.75 ? 'Above target' : cpi >= 1.25 ? 'Near target' : 'Low';
  const anchor = model.anchor && Number.isFinite(model.anchor.percent) ? model.anchor : null;
  return {
    key: 'inflation',
    question: 'Is inflation under control?',
    answer,
    tone: answer === 'Near target' ? 'positive' : answer === 'High' ? 'negative' : 'neutral',
    sentence: `Consumer prices are up ${cpi}% on a year ago, against the Fed's 2% target.${anchor ? ` Markets price ${anchor.percent}% a year (${anchor.name.charAt(0).toLowerCase()}${anchor.name.slice(1)}), so they ${Math.abs(anchor.percent - cpi) < 0.75 ? 'expect roughly the same' : anchor.percent < cpi ? 'expect it to ease' : 'expect it to rise'}.` : ''}`,
    scale: scaleOf(Math.min(cpi, 6), '0%', '6% or more', 'none', `CPI ${cpi}% a year`, 0, 6),
    tab: 'Rates',
  };
}

const CURVE_MEANINGS = {
  Inverted: 'Short-term Treasury rates are above long-term ones. That has preceded most US recessions, on a long and variable lag.',
  'Partially inverted': 'Part of the Treasury curve is inverted, with short rates above long ones. Full inversions have preceded most US recessions, on a long lag.',
  'Recently un-inverted': 'The curve has just turned positive again after an inversion. Historically the turn back has come closer to recessions than the inversion itself.',
  Steepening: 'Long-term rates are rising relative to short ones, which the market usually prices when it expects growth, inflation or rate cuts.',
  Flattening: 'Long-term rates are falling relative to short ones, which the market usually prices when it expects slower growth or tighter policy.',
  Normal: 'Long-term rates sit comfortably above short ones, the usual shape for an economy that is not expected to slow sharply.',
};

function curveCard(model) {
  if (!published(model) || !model.state) return null;
  const tenTwo = (model.spreads ?? []).find((spread) => spread.key === 'tenTwo' && Number.isFinite(spread.spread));
  return {
    key: 'curve',
    question: 'What is the yield curve saying?',
    answer: model.state,
    tone: ['Inverted', 'Partially inverted', 'Recently un-inverted'].includes(model.state) ? 'negative' : model.state === 'Normal' || model.state === 'Steepening' ? 'positive' : 'neutral',
    sentence: `${CURVE_MEANINGS[model.state] ?? model.read}${tenTwo ? ` The 10-year sits ${Math.abs(tenTwo.spread)} points ${tenTwo.spread >= 0 ? 'above' : 'below'} the 2-year.` : ''}`,
    scale: tenTwo ? scaleOf(Math.max(-1.5, Math.min(3, tenTwo.spread)), 'Inverted', 'Steep', 'pos-right', `10y-2y ${tenTwo.spread > 0 ? '+' : ''}${tenTwo.spread}`, -1.5, 3) : null,
    tab: 'Rates',
  };
}

function recessionCard(model) {
  if (model?.status !== 'calculated' || !Number.isFinite(model.probability)) return null;
  const signal = Number.isFinite(model.signalPercent) ? model.signalPercent : 30;
  const answer = model.probability >= signal ? 'Elevated' : model.probability >= signal / 2 ? 'Moderate' : 'Low';
  // Its own record, from the episodes the model publishes: how often a
  // reading above the signal level was followed by a recession.
  const judged = (model.episodes ?? []).filter((episode) => episode.outcome === 'followed' || episode.outcome === 'not followed');
  const followed = judged.filter((episode) => episode.outcome === 'followed').length;
  const since = String(model.history?.[0]?.month ?? '').slice(0, 4);
  const record = judged.length
    ? `Since ${since || 'its history began'} it has risen above ${signal}% ${judged.length} ${judged.length === 1 ? 'time' : 'times'} with the outcome known, and a recession began within two years of ${followed}.`
    : null;
  return {
    key: 'recession',
    question: 'How likely is a recession?',
    answer,
    tone: answer === 'Low' ? 'positive' : answer === 'Elevated' ? 'negative' : 'neutral',
    sentence: `The New York Fed's yield-curve model puts the chance of a US recession 12 months out at ${model.probability}%. This one is a forecast.${record ? ` ${record}` : ''}`,
    scale: scaleOf(Math.min(model.probability, 60), 'Unlikely', 'Likely', 'pos-left', `${model.probability}% in 12 months`, 0, 60),
    tab: 'Rates',
  };
}

/**
 * @returns {{ cards: Array<{ key, question, answer, tone, sentence, scale, tab }>, summary: string | null }}
 */
export function buildMacroBrief({ liquidity = null, globalLiquidity = null, usdStrength = null, growthNowcast = null, inflation = null, yieldCurve = null, recession = null } = {}) {
  const cards = [
    liquidityCard(liquidity),
    globalCard(globalLiquidity),
    dollarCard(usdStrength),
    growthCard(growthNowcast),
    inflationCard(inflation),
    curveCard(yieldCurve),
    recessionCard(recession),
  ].filter(Boolean);
  const pick = (key) => cards.find((card) => card.key === key)?.answer.toLowerCase();
  const pieces = [
    pick('liquidity') ? `liquidity ${pick('liquidity')}` : null,
    pick('growth') ? `growth ${pick('growth')}` : null,
    pick('inflation') ? `inflation ${pick('inflation')}` : null,
    pick('recession') ? `recession risk ${pick('recession')}` : null,
  ].filter(Boolean);
  return {
    cards,
    summary: pieces.length >= 2 ? `${pieces.join(', ').replace(/^./, (letter) => letter.toUpperCase())}.` : null,
  };
}

