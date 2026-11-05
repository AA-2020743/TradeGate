/**
 * Geometry for the app's charts, kept apart from the components so it can be
 * tested. Every position is a percentage of the plot width, so the charts are
 * plain HTML that reflows at any width without measuring the DOM.
 */

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

/**
 * A reading's bar on a 0-100 scale, drawn from the neutral line outward.
 * Right of neutral helps the asset, left holds it back.
 */
export function pullBar(score, neutral = 50) {
  if (!Number.isFinite(score)) return null;
  const value = clamp(score, 0, 100);
  if (value === neutral) return { side: 'flat', left: neutral, width: 0 };
  return value > neutral
    ? { side: 'pos', left: neutral, width: value - neutral }
    : { side: 'neg', left: value, width: neutral - value };
}

/** A round axis limit at or above the largest magnitude: 3.2 -> 4, 13 -> 15, 0 -> 1. */
export function niceLimit(maximum) {
  const value = Math.abs(maximum);
  if (!Number.isFinite(value) || value === 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((candidate) => candidate * magnitude >= value);
  // Rounded so 0.3 is 0.3, not 0.30000000000000004.
  return Number((step * magnitude).toPrecision(6));
}

/**
 * A signed value on a symmetric axis centred at 50%: { left, width } for its
 * bar and `at` for a point marker, all in percent of the plot.
 */
export function divergingPosition(value, limit) {
  if (!Number.isFinite(value) || !(limit > 0)) return null;
  const share = clamp(value / limit, -1, 1) * 50;
  return { left: share >= 0 ? 50 : 50 + share, width: Math.abs(share), at: 50 + share, side: value > 0 ? 'pos' : value < 0 ? 'neg' : 'flat' };
}

/** Evenly spaced ticks on a symmetric axis: limit 4 -> [-4, -2, 0, 2, 4]. */
export function divergingTicks(limit) {
  if (!(limit > 0)) return [0];
  const half = limit / 2;
  return [-limit, -half, 0, half, limit].map((tick) => Math.round(tick * 100) / 100);
}

/** A marker's position along a min-max scale, in percent, clamped to the track. */
export function scalePosition(value, minimum = 0, maximum = 100) {
  if (!Number.isFinite(value) || maximum <= minimum) return null;
  return clamp(((value - minimum) / (maximum - minimum)) * 100, 0, 100);
}

/**
 * A heatmap cell's tint for a signed value: which pole it leans to and how far
 * toward that pole's colour, capped so the cell's text stays readable on it.
 */
export function heatShare(value, limit = 1, maximumPercent = 55) {
  if (!Number.isFinite(value) || !(limit > 0)) return null;
  const share = Math.min(1, Math.abs(value) / limit);
  return { side: value > 0 ? 'pos' : value < 0 ? 'opp' : 'flat', percent: Math.round(share * maximumPercent) };
}

/** 1st, 2nd, 3rd, 11th, 93rd - and an em-dash, never "nullth", when there is no number. */
export function ordinal(value) {
  if (!Number.isFinite(value)) return '\u2014';
  const rounded = Math.round(value);
  const lastTwo = Math.abs(rounded) % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${rounded}th`;
  return `${rounded}${{ 1: 'st', 2: 'nd', 3: 'rd' }[Math.abs(rounded) % 10] ?? 'th'}`;
}

/**
 * Round tick values from zero to `limit`, at most `maxIntervals` apart:
 * 150 -> 0, 50, 100, 150; 100 -> 0, 25, 50, 75, 100; 8 -> 0, 2, 4, 6, 8.
 * Never the "38%, 113%" an even quartering of 150 prints.
 */
export function niceTicks(limit, maxIntervals = 5) {
  if (!(limit > 0)) return [0];
  const magnitude = 10 ** Math.floor(Math.log10(limit));
  for (const base of [0.1, 0.25, 0.2, 0.5, 1, 2.5, 2, 5, 10]) {
    const step = base * magnitude;
    const count = limit / step;
    if (count <= maxIntervals && Math.abs(count - Math.round(count)) < 1e-9) {
      return Array.from({ length: Math.round(count) + 1 }, (_unused, index) => Number((index * step).toPrecision(6)));
    }
  }
  return [0, limit];
}
