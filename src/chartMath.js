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
