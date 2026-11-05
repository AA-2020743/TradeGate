import { ordinal } from './chartMath.js';

/**
 * The Forex page's answers to the questions a currency investor asks, each
 * in one word and one sentence, with a scale where the answer is a position.
 *
 * The page carries the six crosses' momentum, the dollar's breadth, the US
 * yield advantage, the carry trade and its record, the rotation checks and
 * CFTC positioning - each in its own terms. This reads the payloads those
 * panels already draw and says what they mean. Nothing is recomputed and
 * nothing is forecast.
 *
 * A card whose inputs did not publish is left out rather than shown blank.
 */

const scaleOf = (value, left, right, polarity, label, min = 0, max = 100) => (Number.isFinite(value) ? { value, min, max, left, right, polarity, label } : null);
const signed = (value) => `${value > 0 ? '+' : ''}${value}`;

function breadthCard(breadth) {
  if (!breadth || !Number.isFinite(breadth.pct20d) || !breadth.total) return null;
  const answer = breadth.pct20d >= 70 ? 'Rising broadly' : breadth.pct20d <= 30 ? 'Falling broadly' : 'Mixed';
  return {
    key: 'breadth',
    question: 'Is the dollar rising or falling?',
    answer,
    tone: 'neutral',
    sentence: `Over the last 20 sessions the dollar has gained against ${breadth.strong20d} of ${breadth.total} major currencies${Number.isFinite(breadth.strong60d) ? ` (${breadth.strong60d} of ${breadth.total} over 60)` : ''}. ${answer === 'Mixed' ? 'A split like this is usually about individual currencies rather than the dollar itself.' : 'A move this broad is about the dollar, not any one currency.'}`,
    scale: scaleOf(breadth.pct20d, 'Falling', 'Rising', 'none', `${breadth.strong20d} of ${breadth.total} crosses`),
    anchor: 'fx-strength',
  };
}

// Mid-sentence names and the short answer for each cross, by its key.
const CURRENCY_NAMES = {
  eur: { name: 'euro', short: 'Euro' },
  jpy: { name: 'Japanese yen', short: 'Yen' },
  gbp: { name: 'British pound', short: 'Pound' },
  cad: { name: 'Canadian dollar', short: 'Canadian dollar' },
  aud: { name: 'Australian dollar', short: 'Australian dollar' },
  chf: { name: 'Swiss franc', short: 'Swiss franc' },
};
const currencyName = (pair) => CURRENCY_NAMES[pair.key]?.name ?? pair.name;

function leadersCard(pairs) {
  const ranked = (pairs ?? []).filter((pair) => Number.isFinite(pair.momentum20d)).sort((left, right) => right.momentum20d - left.momentum20d);
  if (ranked.length < 3) return null;
  const strongest = ranked[0];
  const weakest = ranked.at(-1);
  return {
    key: 'leaders',
    question: 'Which currencies are strongest against the dollar?',
    answer: CURRENCY_NAMES[strongest.key]?.short ?? strongest.name,
    tone: 'neutral',
    sentence: `The ${currencyName(strongest)} has done best against the dollar over 20 sessions (${signed(strongest.momentum20d)}%), the ${currencyName(weakest)} worst (${signed(weakest.momentum20d)}%).`,
    scale: null,
    anchor: 'fx-strength',
  };
}

function ratesCard(divergence) {
  if (!divergence || !['calculated', 'provisional'].includes(divergence.status) || !Number.isFinite(divergence.averageSpreadPercent)) return null;
  const answer = /widening/.test(divergence.state) ? 'Widening' : /narrowing/.test(divergence.state) ? 'Narrowing' : 'Steady';
  return {
    key: 'rates',
    question: 'Do US rates still pull money toward the dollar?',
    answer,
    tone: 'neutral',
    sentence: `The US 10-year yields ${divergence.averageSpreadPercent} points more than its peers${Number.isFinite(divergence.averageChangeBasisPoints) ? `, ${divergence.averageChangeBasisPoints >= 0 ? 'up' : 'down'} ${Math.abs(divergence.averageChangeBasisPoints)}bp in about three months` : ''}. ${answer === 'Widening' ? 'A widening gap draws capital toward the dollar.' : answer === 'Narrowing' ? 'A narrowing gap removes some of that pull.' : 'The pull toward the dollar is unchanged.'}`,
    scale: scaleOf(divergence.score, 'Small', 'Large', 'none', `${divergence.averageSpreadPercent} pts advantage`),
    anchor: 'fx-macro',
  };
}

function carryCard(carry) {
  if (carry?.status !== 'calculated' || !carry.trade?.long?.length || !Number.isFinite(carry.trade.carry)) return null;
  const history = carry.spreadHistory;
  const worst = history?.worstMonths?.[0];
  const record = history && Number.isFinite(history.annualReturn) && Number.isFinite(history.annualVolatility)
    ? ` Since ${String(history.from).slice(0, 4)} the same rule has returned ${history.annualReturn}% a year with ${history.annualVolatility}% volatility${Number.isFinite(worst?.value) ? `; its worst month lost ${Math.abs(worst.value)}%` : ''}.`
    : '';
  return {
    key: 'carry',
    question: 'What does the carry trade pay?',
    answer: `${carry.trade.carry} pts a year`,
    tone: 'neutral',
    sentence: `Borrowing in ${carry.trade.short.join(' and ')} to hold ${carry.trade.long.join(' and ')} earns about ${carry.trade.carry} points a year in interest, before currency moves.${record}`,
    scale: null,
    anchor: 'fx-carry',
  };
}

function riskCard(riskRegime, rotationSignals) {
  if (!['Risk-on', 'Risk-off'].includes(riskRegime)) return null;
  const yen = (rotationSignals ?? []).find((signal) => /yen/i.test(signal.signal ?? ''));
  const confirmed = yen?.status === 'Confirmed';
  const diverged = yen?.status === 'Diverged';
  return {
    key: 'risk',
    question: 'Are currencies pricing risk-on or risk-off?',
    answer: riskRegime,
    tone: riskRegime === 'Risk-on' ? 'positive' : 'negative',
    sentence: `US stocks have ${riskRegime === 'Risk-on' ? 'risen' : 'fallen'} over 20 sessions.${confirmed ? ` The yen, a safe haven, moved the other way, which confirms the ${riskRegime.toLowerCase()} read.` : diverged ? ` The yen, a safe haven, moved the same way, so currencies are not confirming it.` : ''}`,
    scale: null,
    anchor: 'fx-rotation',
  };
}

function positioningCard(cot) {
  if (!cot || !Number.isFinite(cot.percentile)) return null;
  const answer = cot.percentile >= 90 ? 'Crowded long' : cot.percentile >= 70 ? 'Long' : cot.percentile <= 10 ? 'Crowded short' : cot.percentile <= 30 ? 'Short' : 'Moderate';
  return {
    key: 'positioning',
    question: 'Are speculators crowded in the dollar?',
    answer,
    tone: 'neutral',
    sentence: `Speculators' net position in Dollar Index futures is ${cot.percentile >= 50 ? 'longer' : 'shorter'} than in ${cot.percentile >= 50 ? cot.percentile : 100 - cot.percentile}% of past weekly reports. ${['Crowded long', 'Crowded short'].includes(answer) ? 'Crowded positioning leaves the dollar exposed to a sharp reversal if the crowd unwinds.' : 'It is not at an extreme.'}`,
    scale: scaleOf(cot.percentile, 'Most short', 'Most long', 'none', `${ordinal(cot.percentile)} percentile`),
    anchor: 'fx-positioning',
  };
}

/**
 * @returns {{ cards: Array<{ key, question, answer, tone, sentence, scale, anchor }>, summary: string | null }}
 */
export function buildFxBrief({ workspace = null, rateDivergence = null, carry = null } = {}) {
  const cards = [
    breadthCard(workspace?.usdBreadth),
    leadersCard(workspace?.pairs),
    ratesCard(rateDivergence),
    carryCard(carry),
    riskCard(workspace?.riskRegime, workspace?.rotationSignals),
    positioningCard(workspace?.usdCot),
  ].filter(Boolean);
  const pick = (key) => cards.find((card) => card.key === key)?.answer;
  const pieces = [
    pick('breadth') ? `the dollar ${pick('breadth').toLowerCase()}` : null,
    pick('rates') ? `its yield advantage ${pick('rates').toLowerCase()}` : null,
    pick('risk') ? `currencies ${pick('risk').toLowerCase()}` : null,
  ].filter(Boolean);
  return {
    cards,
    summary: pieces.length >= 2 ? `${pieces.join(', ').replace(/^./, (letter) => letter.toUpperCase())}.` : null,
  };
}
