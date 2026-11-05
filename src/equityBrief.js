import { describeTechnical } from './technicalSummary.js';

/**
 * The equity section's answers to the questions an investor actually asks,
 * each in one word and one sentence.
 *
 * The page carries around twenty-five panels - drawdown profile, volatility
 * term structure, CAPE, constituent breadth, rotation quadrants, revision
 * diffusion, Fear & Greed - and every one of them is correct, but none says
 * "is the market expensive?" or "is this rally broad?" This reads the same
 * payloads those panels draw and states the answer, naming the panel that
 * backs it. Nothing is recomputed and nothing is forecast: each card describes
 * today, and where the evidence says a reading has little forecasting value
 * (valuation over a year, sentiment untested here) the card says so.
 *
 * A card whose inputs did not publish is left out rather than shown blank.
 */

const DEFENSIVE = new Set(['XLV', 'XLP', 'XLU', 'XLRE']);

/** "a", "a and b", "a, b and c". */
function joinParts(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

function ordinal(value) {
  const rounded = Math.round(value);
  const lastTwo = Math.abs(rounded) % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${rounded}th`;
  return `${rounded}${{ 1: 'st', 2: 'nd', 3: 'rd' }[Math.abs(rounded) % 10] ?? 'th'}`;
}

/**
 * Where the card's main reading sits between two named ends, for the scale
 * marker. `polarity` says which end is better for an investor ('pos-right',
 * 'pos-left'), or that neither is ('none').
 */
const scaleOf = (value, left, right, polarity, label) => (Number.isFinite(value) ? { value, left, right, polarity, label } : null);

const capitalize = (text) => text.replace(/^./, (letter) => letter.toUpperCase());

const calculated = (model) => model?.status === 'calculated' || model?.status === 'provisional';

function trendCard(indexName, technical) {
  const summary = describeTechnical(technical, indexName);
  if (!summary) return null;
  return {
    key: 'trend',
    question: 'Which way is it trending?',
    answer: technical.regime === 'Constructive' ? 'Up' : technical.regime === 'Guarded' ? 'Down' : 'Sideways',
    tone: summary.tone,
    sentence: capitalize(summary.sentence),
    scale: scaleOf(technical.score, 'Down', 'Up', 'pos-right', `Trend score ${technical.score}`),
    anchor: 'equity-focus',
  };
}

function riskCard(indexName, { drawdown, volatility, vixTerm }) {
  const hasDrawdown = calculated(drawdown) && Number.isFinite(drawdown.drawdownPercent);
  const terms = calculated(volatility) ? (volatility.terms ?? []).filter((term) => Number.isFinite(term.annualizedPercent)) : [];
  const short = terms.length ? terms.reduce((first, term) => (term.window < first.window ? term : first)) : null;
  const hasVix = vixTerm?.status === 'calculated' && Number.isFinite(vixTerm.vixVix3m);
  if (!hasDrawdown && !short && !hasVix) return null;

  const depth = hasDrawdown ? drawdown.drawdownPercent : 0;
  const shock = volatility?.slope === 'inverted';
  const backwardation = hasVix && /backwardation/i.test(vixTerm.state ?? '');
  const busyTape = Number.isFinite(short?.percentile) && short.percentile >= 75;
  const answer = shock || backwardation || depth <= -10 ? 'Stressed'
    : busyTape || depth <= -5 || /flat/i.test(vixTerm?.state ?? '') ? 'Elevated'
      : 'Calm';

  const parts = [];
  if (hasDrawdown) {
    parts.push(drawdown.inDrawdown && depth < -0.5
      ? `${indexName} is ${Math.abs(depth).toFixed(1)}% below its ${drawdown.peakDate} peak`
      : `${indexName} is at or near its high`);
  }
  if (short) {
    parts.push(`its ${short.window}-day volatility of ${short.annualizedPercent}% ${Number.isFinite(short.percentile) ? `is higher than ${short.percentile}% of its own readings over the last three years` : 'has no history to rank against yet'}`);
  }
  if (hasVix) {
    parts.push(backwardation
      ? 'near-dated options cost more than three-month ones, which is how stress is priced'
      : /flat/i.test(vixTerm.state ?? '') ? 'near-dated and three-month options are priced about the same, a curve that has lost its calm shape'
        : 'near-dated options cost less than three-month ones, the usual calm shape');
  }
  if (shock) parts.push('the last few weeks have been much more violent than the past year');
  const sentence = `${joinParts(parts).replace(/^./, (letter) => letter.toUpperCase())}.`;
  const scale = scaleOf(short?.percentile, 'Calm', 'Turbulent', 'pos-left', Number.isFinite(short?.percentile) ? `Volatility ${ordinal(short.percentile)} pct.` : null);
  return { key: 'risk', question: 'How risky is it right now?', answer, tone: answer === 'Calm' ? 'positive' : answer === 'Stressed' ? 'negative' : 'neutral', sentence, scale, anchor: 'equity-risk' };
}

function valuationCard(valuation) {
  if (!calculated(valuation) || !Number.isFinite(valuation.cape) || !Number.isFinite(valuation.capePercentile)) return null;
  const percentile = valuation.capePercentile;
  const answer = percentile >= 80 ? 'Expensive' : percentile <= 20 ? 'Cheap' : 'Fairly valued';
  const since = valuation.historyFrom ? ` since ${String(valuation.historyFrom).slice(0, 4)}` : ' on record';
  return {
    key: 'valuation',
    question: 'Is the S&P 500 expensive?',
    answer,
    tone: answer === 'Expensive' ? 'negative' : answer === 'Cheap' ? 'positive' : 'neutral',
    sentence: `Its cyclically adjusted P/E of ${valuation.cape} is higher than ${percentile}% of months${since}${Number.isFinite(valuation.medianCape) ? ` (median ${valuation.medianCape})` : ''}${Number.isFinite(valuation.earningsYield) ? `, an earnings yield of ${valuation.earningsYield}%` : ''}. Valuation has said little about the next year or two; it is a guide to returns over the coming decade.`,
    scale: scaleOf(percentile, 'Cheap', 'Expensive', 'pos-left', `${ordinal(percentile)} percentile`),
    anchor: 'equity-valuation',
  };
}

function breadthCard({ breadth, equalWeight, trendUp }) {
  const hasBreadth = breadth?.status === 'calculated' && Number.isFinite(breadth.pctAbove200);
  const hasEqual = equalWeight?.status === 'calculated' && Number.isFinite(equalWeight.slope50);
  if (!hasBreadth && !hasEqual) return null;
  const share = hasBreadth ? breadth.pctAbove200 : null;
  const lagging = hasEqual && equalWeight.slope50 < -1;
  const answer = share !== null && share < 40 ? 'Weak'
    : (share !== null && share < 55 && trendUp) || lagging ? 'Narrow'
      : share !== null && share >= 60 ? 'Broad' : 'Mixed';
  const parts = [];
  if (hasBreadth) parts.push(`${share}% of S&P 500 stocks trade above their 200-day average`);
  if (hasEqual) {
    parts.push(Math.abs(equalWeight.slope50) < 1
      ? 'the average stock has kept pace with the index over 50 days'
      : equalWeight.slope50 > 0
        ? `the average stock has beaten the index by ${equalWeight.slope50.toFixed(1)}% over 50 days, so gains are spreading`
        : `the average stock has trailed the index by ${Math.abs(equalWeight.slope50).toFixed(1)}% over 50 days, so gains are concentrated in the largest names`);
  }
  return {
    key: 'breadth',
    question: 'Is the move broad or narrow?',
    answer,
    tone: answer === 'Broad' ? 'positive' : answer === 'Weak' ? 'negative' : 'neutral',
    sentence: `${joinParts(parts).replace(/^./, (letter) => letter.toUpperCase())}.`,
    scale: scaleOf(share, 'Narrow', 'Broad', 'pos-right', `${share}% above 200-day`),
    anchor: 'equity-breadth',
  };
}

function leadershipCard(rotation) {
  const ranked = (rotation?.sectors ?? []).filter((sector) => Number.isFinite(sector.rank)).sort((left, right) => left.rank - right.rank);
  if (ranked.length < 4) return null;
  const top = ranked.slice(0, 3);
  const defensive = top.filter((sector) => DEFENSIVE.has(sector.symbol)).length;
  const answer = defensive >= 2 ? 'Defensive' : defensive === 0 ? 'Cyclical' : 'Mixed';
  const names = top.map((sector) => sector.name);
  return {
    key: 'leadership',
    question: 'Which US sectors are leading?',
    answer,
    tone: answer === 'Cyclical' ? 'positive' : answer === 'Defensive' ? 'negative' : 'neutral',
    sentence: `${joinParts(names)} have been strongest against the S&P 500. ${answer === 'Defensive'
      ? 'Defensive sectors in front usually means investors are seeking safety.'
      : answer === 'Cyclical' ? 'Economically sensitive sectors in front usually means investors are leaning into growth.'
        : 'Leadership is split between defensive and economically sensitive sectors.'}`,
    anchor: 'equity-sectors',
  };
}

function earningsCard(revisions) {
  if (!calculated(revisions) || !Number.isFinite(revisions.diffusion) || !Number.isFinite(revisions.covered)) return null;
  const answer = revisions.diffusion >= 60 ? 'Rising' : revisions.diffusion <= 40 ? 'Falling' : 'Mixed';
  return {
    key: 'earnings',
    question: 'Are earnings estimates rising?',
    answer,
    tone: answer === 'Rising' ? 'positive' : answer === 'Falling' ? 'negative' : 'neutral',
    sentence: `Analysts have raised more estimates than they cut for ${revisions.diffusion}% of the ${revisions.covered} S&P 500 companies sampled.${revisions.narrow ? ' A few heavily covered names are carrying the overall direction.' : ''}${revisions.status === 'provisional' ? ' Coverage is partial, so treat this as provisional.' : ''}`,
    scale: scaleOf(revisions.diffusion, 'Cutting', 'Raising', 'pos-right', `${revisions.diffusion}% raising`),
    anchor: 'equity-revisions',
  };
}

function sentimentCard(fearGreed) {
  if (!fearGreed || !Number.isFinite(fearGreed.score)) return null;
  const rating = String(fearGreed.rating ?? '').trim();
  const answer = rating ? rating.replace(/\b\w/g, (letter) => letter.toUpperCase()) : fearGreed.score >= 55 ? 'Greed' : fearGreed.score <= 45 ? 'Fear' : 'Neutral';
  return {
    key: 'sentiment',
    question: 'What is the mood in US stocks?',
    answer,
    tone: 'neutral',
    sentence: `CNN's Fear & Greed index reads ${Math.round(fearGreed.score)} of 100${Number.isFinite(fearGreed.percentile1y) ? `, higher than ${fearGreed.percentile1y}% of the past year's readings` : ''}. Extremes are often read as contrarian signals; this platform has not tested whether that works.`,
    scale: scaleOf(fearGreed.score, 'Extreme fear', 'Extreme greed', 'none', `${Math.round(fearGreed.score)} of 100`),
    anchor: 'equity-sentiment',
  };
}

/**
 * @returns {{ cards: Array<{ key, question, answer, tone, sentence, anchor }>, summary: string | null }}
 */
export function buildEquityBrief({ indexName = 'the index', technical = null, drawdown = null, volatility = null, vixTerm = null, valuation = null, breadth = null, equalWeight = null, rotation = null, revisions = null, fearGreed = null } = {}) {
  const trend = trendCard(indexName, technical);
  const cards = [
    trend,
    riskCard(indexName, { drawdown, volatility, vixTerm }),
    valuationCard(valuation),
    breadthCard({ breadth, equalWeight, trendUp: technical?.regime === 'Constructive' }),
    leadershipCard(rotation),
    earningsCard(revisions),
    sentimentCard(fearGreed),
  ].filter(Boolean);
  const pick = (key) => cards.find((card) => card.key === key)?.answer.toLowerCase();
  const pieces = [
    pick('trend') ? `trend ${pick('trend')}` : null,
    pick('risk') ? `risk ${pick('risk')}` : null,
    pick('valuation') ? (pick('valuation') === 'fairly valued' ? 'valuation fair' : `valuation ${pick('valuation')}`) : null,
    pick('breadth') ? `breadth ${pick('breadth')}` : null,
  ].filter(Boolean);
  return {
    cards,
    summary: pieces.length >= 2 ? `${capitalize(indexName)}: ${pieces.join(', ')}.` : null,
  };
}

