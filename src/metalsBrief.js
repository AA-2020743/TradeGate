import { ordinal } from './chartMath.js';

/**
 * The Metals page's answers to the questions a gold investor asks, each in
 * one word and one sentence, with a scale where the answer is a position.
 *
 * The page carries the gold technicals, the dollar and liquidity backdrop,
 * an accumulation tier, a fit against real yields, the gold/silver and
 * gold/copper ratios and CFTC positioning - each in its own terms. This reads
 * the payloads those panels already draw and says what they mean, naming the
 * panel that backs each answer. Nothing is recomputed and nothing is
 * forecast; where a reading has a poor record as a forecast, the card says so.
 *
 * A card whose inputs did not publish is left out rather than shown blank.
 */

const scaleOf = (value, left, right, polarity, label, min = 0, max = 100) => (Number.isFinite(value) ? { value, min, max, left, right, polarity, label } : null);

/** "a", "a and b", "a, b and c". */
function joinParts(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

function trendCard(gold) {
  if (!gold || !Number.isFinite(gold.score)) return null;
  const answer = gold.score >= 65 ? 'Up' : gold.score <= 35 ? 'Down' : 'Sideways';
  const parts = [];
  if (Number.isFinite(gold.sma50) && Number.isFinite(gold.sma200)) parts.push(`its 50-day average is ${gold.sma50 > gold.sma200 ? 'above' : 'below'} its 200-day`);
  if (Number.isFinite(gold.momentum20d)) parts.push(`it is ${gold.momentum20d >= 0 ? 'up' : 'down'} ${Math.abs(gold.momentum20d)}% over 20 sessions`);
  const stretched = Number.isFinite(gold.rsi14) && gold.rsi14 >= 70 ? ' The short-term move is stretched (RSI above 70).'
    : Number.isFinite(gold.rsi14) && gold.rsi14 <= 30 ? ' The short-term move is stretched to the downside (RSI below 30).' : '';
  return {
    key: 'trend',
    question: 'Which way is gold trending?',
    answer,
    tone: answer === 'Up' ? 'positive' : answer === 'Down' ? 'negative' : 'neutral',
    sentence: `${parts.length ? `${joinParts(parts).replace(/^./, (letter) => letter.toUpperCase())}.` : `Gold's technical score is ${gold.score}.`}${stretched}`,
    scale: scaleOf(gold.score, 'Down', 'Up', 'pos-right', `Trend score ${gold.score}`),
    anchor: 'metals-trend',
  };
}

function valueCard(schedule) {
  if (!schedule || schedule.status === 'unavailable' || !schedule.tier?.label || !Number.isFinite(schedule.risk)) return null;
  const label = schedule.tier.label;
  const answer = { 'Deep value': 'Cheap', Discounted: 'Below average', Baseline: 'Average', Extended: 'Rich', Stretched: 'Stretched' }[label] ?? label;
  return {
    key: 'value',
    question: 'Is gold stretched against its own history?',
    answer,
    tone: ['Cheap', 'Below average'].includes(answer) ? 'positive' : ['Rich', 'Stretched'].includes(answer) ? 'negative' : 'neutral',
    sentence: `Measured by its distance above its own one-year average, its distance from its three-year high and its past year's gain, gold sits in the "${label}" tier, scoring ${schedule.risk} of 100. This says how far it has run, not where it goes next.`,
    scale: scaleOf(schedule.risk, 'Cheap', 'Stretched', 'pos-left', `${schedule.risk}/100`),
    anchor: 'metals-accumulation',
  };
}

function realYieldCard(model) {
  if (model?.status !== 'calculated' || !Number.isFinite(model.gapPercent)) return null;
  const gap = model.gapPercent;
  const outside = model.state === 'Outside the fit band';
  const answer = gap >= 15 ? 'Far above' : gap >= 5 ? 'Above' : gap <= -15 ? 'Far below' : gap <= -5 ? 'Below' : 'In line';
  return {
    key: 'realYield',
    question: 'Is gold priced for today\'s real yields?',
    answer,
    tone: 'neutral',
    sentence: `Gold is ${Math.abs(gap)}% ${gap >= 0 ? 'above' : 'below'} the price its long-run relationship with the 10-year real yield implies${outside ? ', outside the range that relationship has usually held' : ''}. A large gap says something other than rates - central-bank buying, fear, the dollar - is setting the price.`,
    scale: scaleOf(Math.max(-40, Math.min(40, gap)), 'Below', 'Above', 'none', `${gap > 0 ? '+' : ''}${gap}% vs the fit`, -40, 40),
    anchor: 'metals-real-yield',
  };
}

function dollarCard(macro) {
  const dollar = macro?.dollar;
  if (!dollar || !Number.isFinite(dollar.score)) return null;
  const firm = dollar.score >= 58;
  const soft = dollar.score <= 42;
  const answer = firm ? 'Headwind' : soft ? 'Tailwind' : 'Neutral';
  return {
    key: 'dollar',
    question: 'Is the dollar helping gold?',
    answer,
    tone: firm ? 'negative' : soft ? 'positive' : 'neutral',
    sentence: `The dollar composite reads ${String(dollar.regime ?? '').toLowerCase() || 'neutral'} (${dollar.score}/100). Gold is priced in dollars, so a ${firm ? 'firm dollar usually weighs on it' : soft ? 'soft dollar usually supports it' : 'dollar going nowhere is neither helping nor hurting it'}.`,
    scale: scaleOf(dollar.score, 'Soft dollar', 'Firm dollar', 'pos-left', `Dollar ${dollar.score}/100`),
    anchor: 'metals-macro',
  };
}

function ratioCard(ratio) {
  if (ratio?.status !== 'calculated' || !Number.isFinite(ratio.ratio) || !Number.isFinite(ratio.percentile)) return null;
  const answer = ratio.percentile >= 80 ? 'Silver cheap' : ratio.percentile <= 20 ? 'Gold cheap' : 'Balanced';
  return {
    key: 'ratio',
    question: 'Is silver cheap against gold?',
    answer,
    tone: 'neutral',
    sentence: `An ounce of gold buys ${ratio.ratio} ounces of silver, more than on ${ratio.percentile}% of days in this history. ${answer === 'Silver cheap' ? 'A high ratio means gold\'s monetary bid is running ahead of silver\'s industrial one.' : answer === 'Gold cheap' ? 'A low ratio means silver\'s industrial bid is running ahead of gold.' : 'Neither metal is unusually cheap against the other.'} The ratio's own record of what followed its extremes is on this page.`,
    scale: scaleOf(ratio.percentile, 'Gold cheap', 'Silver cheap', 'none', `Ratio ${ratio.ratio} · ${ordinal(ratio.percentile)} pct.`),
    anchor: 'metals-ratios',
  };
}

function positioningCard(cot) {
  if (!cot || !Number.isFinite(cot.percentile)) return null;
  const answer = cot.percentile >= 90 ? 'Crowded long' : cot.percentile >= 70 ? 'Long' : cot.percentile <= 10 ? 'Washed out' : cot.percentile <= 30 ? 'Light' : 'Moderate';
  return {
    key: 'positioning',
    question: 'Are speculators crowded in gold?',
    answer,
    tone: 'neutral',
    sentence: `Speculators' net long in gold futures is larger than in ${cot.percentile}% of past weekly reports. ${cot.percentile >= 90 ? 'A crowded long leaves fewer new buyers and more potential sellers.' : cot.percentile <= 10 ? 'Light positioning leaves room for new buyers.' : 'It is not at an extreme either way.'}`,
    scale: scaleOf(cot.percentile, 'Most short', 'Most long', 'none', `${ordinal(cot.percentile)} percentile`),
    anchor: 'metals-positioning',
  };
}

/**
 * @returns {{ cards: Array<{ key, question, answer, tone, sentence, scale, anchor }>, summary: string | null }}
 */
export function buildMetalsBrief({ gold = null, accumulation = null, realYield = null, macro = null, goldSilver = null, cot = null } = {}) {
  const schedule = (accumulation?.schedules ?? []).find((entry) => entry.key === 'gold') ?? null;
  const cards = [
    trendCard(gold),
    valueCard(schedule),
    realYieldCard(realYield),
    dollarCard(macro),
    ratioCard(goldSilver),
    positioningCard(cot),
  ].filter(Boolean);
  const pick = (key) => cards.find((card) => card.key === key)?.answer.toLowerCase();
  const pieces = [
    pick('trend') ? `trend ${pick('trend')}` : null,
    pick('value') ? `${pick('value')} against its own history` : null,
    pick('dollar') ? `the dollar a ${pick('dollar')}` : null,
    pick('positioning') ? `positioning ${pick('positioning')}` : null,
  ].filter(Boolean);
  return {
    cards,
    summary: pieces.length >= 2 ? `Gold: ${pieces.join(', ')}.`.replace('the dollar a neutral', 'the dollar neutral') : null,
  };
}
