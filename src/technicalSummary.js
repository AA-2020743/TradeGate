/**
 * The technical state in words an investor reads without a glossary.
 *
 * The Overview card said "Constructive. Score 72/100 from 252 provider
 * observations. RSI 61.3." Every number in that sentence is correct, and none
 * of them says what the chart is doing. This states it: which way the trend
 * points, what carries that (the moving averages, the last month's move,
 * distance from the year's high), and whether the short-term move is
 * stretched. It describes; it does not forecast. The card's own footnote says
 * so, and the Markets page carries the regime's track record.
 */

const COUNT_WORDS = ['no', 'one', 'two', 'three'];

/** "a", "a and b", "a, b and c". */
function joinParts(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

function averagesPart(latest, indicators) {
  const averages = [indicators.sma20, indicators.sma50, indicators.sma200].filter(Number.isFinite);
  if (!averages.length || !Number.isFinite(latest)) return null;
  const above = averages.filter((average) => latest >= average).length;
  const total = averages.length;
  const of = total === 1 ? 'its only moving average' : `its ${COUNT_WORDS[total]} moving averages`;
  if (above === total) return total === 1 ? `trades above ${of}` : `trades above all ${COUNT_WORDS[total]} of its moving averages`;
  if (above === 0) return total === 1 ? `trades below ${of}` : `trades below all ${COUNT_WORDS[total]} of its moving averages`;
  return `trades above ${COUNT_WORDS[above]} of ${of}`;
}

function momentumPart(momentum) {
  if (!Number.isFinite(momentum)) return null;
  if (Math.abs(momentum) < 0.05) return 'is flat over the past month';
  return `is ${momentum > 0 ? 'up' : 'down'} ${Math.abs(momentum).toFixed(1)}% over the past month`;
}

function highPart(pctFromHigh) {
  if (!Number.isFinite(pctFromHigh)) return null;
  if (pctFromHigh >= -0.5) return 'sits at or near its 52-week high';
  return `sits ${Math.abs(pctFromHigh).toFixed(1)}% below its 52-week high`;
}

/**
 * @param model  a technical-v1 snapshot
 * @param label  what to call the asset ("SPY", "Bitcoin")
 * @returns {{ headline: string, sentence: string, tone: 'positive'|'neutral'|'negative' } | null}
 */
export function describeTechnical(model, label) {
  if (!model || !Number.isFinite(model.score)) return null;
  const indicators = model.indicators ?? {};
  const headline = model.regime === 'Constructive' ? 'The trend is up'
    : model.regime === 'Guarded' ? 'The trend is down'
      : 'No clear trend';
  const tone = model.regime === 'Constructive' ? 'positive' : model.regime === 'Guarded' ? 'negative' : 'neutral';
  const parts = [averagesPart(model.latest, indicators), momentumPart(indicators.momentum20d), highPart(indicators.pctFrom52wHigh)].filter(Boolean);
  const rsi = indicators.rsi14;
  const stretch = Number.isFinite(rsi) && rsi >= 70 ? ` The short-term move is stretched: its 14-day RSI of ${rsi.toFixed(0)} is above the 70 usually read as overbought.`
    : Number.isFinite(rsi) && rsi <= 30 ? ` The short-term move is stretched: its 14-day RSI of ${rsi.toFixed(0)} is below the 30 usually read as oversold.`
      : '';
  const sentence = parts.length ? `${label} ${joinParts(parts)}.${stretch}` : `Too little of ${label}'s history was available to describe the trend.`;
  return { headline, sentence, tone };
}
