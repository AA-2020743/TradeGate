import { calculateTechnicalSnapshot } from './analytics.js';

/**
 * One row of a watchlist: the last three months of closes, the change over
 * them, and the technical-v1 state on the last year.
 *
 * Rows used to be fetched symbol by symbol from the history and technical
 * routes, which only serve the deployment's own fixed universe (index,
 * sector and heatmap ETFs plus a few names). Any other ticker - MSFT, ETH -
 * came back "No history" while the risk panel below it, which reads Yahoo,
 * included it. Those tickers are now read the same way the risk panel reads
 * them and scored by the same model as everything else.
 */

export const WATCHLIST_ROWS_MAX_SYMBOLS = 50;
const CHART_DAYS = 92;
const CRYPTO = new Set(['BTC', 'ETH', 'SOL']);

export function parseWatchlistRowSymbols(raw) {
  const symbols = [...new Set(String(raw ?? '').split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
  const invalid = symbols.filter((symbol) => !/^[A-Z0-9.\-]{1,10}$/.test(symbol));
  if (invalid.length) return { ok: false, reason: `Not a symbol: ${invalid.slice(0, 3).join(', ')}.` };
  if (!symbols.length) return { ok: false, reason: 'At least one symbol is required.' };
  if (symbols.length > WATCHLIST_ROWS_MAX_SYMBOLS) return { ok: false, reason: `At most ${WATCHLIST_ROWS_MAX_SYMBOLS} symbols.` };
  return { ok: true, symbols };
}

export function annualizationDaysFor(symbol) {
  return CRYPTO.has(String(symbol).toUpperCase()) ? 365 : 252;
}

function toTimestamped(points) {
  return (points ?? [])
    .map((point) => ({ timestamp: point.timestamp ?? (point.date ? `${point.date}T00:00:00.000Z` : null), value: Number(point.value) }))
    .filter((point) => point.timestamp && Number.isFinite(point.value) && point.value > 0)
    .sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
}

/** The last three calendar months of a series, measured back from its own newest close. */
export function chartWindow(points, days = CHART_DAYS) {
  const series = toTimestamped(points);
  if (!series.length) return [];
  const cutoff = new Date(series.at(-1).timestamp).getTime() - days * 86_400_000;
  return series.filter((point) => new Date(point.timestamp).getTime() >= cutoff);
}

function changeOver(points) {
  const first = points[0]?.value;
  const last = points.at(-1)?.value;
  return Number.isFinite(first) && Number.isFinite(last) && first > 0 ? Math.round(((last / first) - 1) * 10_000) / 100 : null;
}

function summarizeModel(model) {
  if (!model) return null;
  return {
    score: model.score,
    regime: model.regime,
    pctFrom52wHigh: Number.isFinite(model.indicators?.pctFrom52wHigh) ? model.indicators.pctFrom52wHigh : null,
    asOf: model.asOf,
    status: model.status ?? 'calculated',
    dataQuality: model.dataQuality ?? null,
  };
}

/**
 * A row from a year of closes. Used for tickers outside the tracked universe;
 * tracked ones arrive with their chart and model already built by the routes
 * the rest of the app reads, so a symbol scores the same here as on Overview.
 */
export function buildWatchlistRow({ symbol, yearPoints, source, reason = null }) {
  const series = toTimestamped(yearPoints);
  if (!series.length) {
    return { symbol, status: 'unavailable', tracked: false, source: source ?? null, points: [], last: null, changePct: null, model: null, reason: reason ?? `No daily closes were returned for ${symbol}; check the ticker.` };
  }
  const model = calculateTechnicalSnapshot(series, { annualizationDays: annualizationDaysFor(symbol) });
  const points = chartWindow(series);
  return {
    symbol,
    status: model ? 'calculated' : 'partial',
    tracked: false,
    source,
    asOf: series.at(-1).timestamp,
    points,
    last: points.at(-1)?.value ?? null,
    changePct: changeOver(points),
    model: summarizeModel(model),
    reason: model ? null : `Too few closes for ${symbol} to score.`,
  };
}

/** A row for a tracked symbol, from the same history and technical reads the rest of the app uses. */
export function trackedWatchlistRow({ symbol, history, technical, reason = null }) {
  const points = chartWindow(history?.stale ? [] : history?.points);
  const model = summarizeModel(technical?.model);
  return {
    symbol,
    status: model && points.length ? 'calculated' : model || points.length ? 'partial' : 'unavailable',
    tracked: true,
    source: history?.source ?? technical?.source ?? null,
    stored: Boolean(history?.stored),
    asOf: points.at(-1)?.timestamp ?? technical?.asOf ?? null,
    points,
    last: points.at(-1)?.value ?? null,
    changePct: changeOver(points),
    model,
    reason: model && points.length ? null : reason ? `${symbol} could not be read (${reason}).` : history?.stale ? `The newest close for ${symbol} is too old to show.` : `${symbol} could not be scored from its provider history.`,
  };
}
