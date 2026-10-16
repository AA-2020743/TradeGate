import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WATCHLIST_ROWS_MAX_SYMBOLS, annualizationDaysFor, buildWatchlistRow, chartWindow, parseWatchlistRowSymbols, trackedWatchlistRow,
} from './watchlistRows.js';

// A year of weekday closes rising 0.1% a session from 100.
function yearOfCloses({ sessions = 252, start = Date.UTC(2025, 9, 1), drift = 0.001 } = {}) {
  const points = [];
  let value = 100;
  for (let t = start; points.length < sessions; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day === 0 || day === 6) continue;
    points.push({ date: new Date(t).toISOString().slice(0, 10), value });
    value *= 1 + drift;
  }
  return points;
}

test('symbols are cleaned, deduplicated and bounded', () => {
  assert.deepEqual(parseWatchlistRowSymbols(' msft, MSFT ,brk.b'), { ok: true, symbols: ['MSFT', 'BRK.B'] });
  // A single symbol is a valid list here, unlike the portfolio reading.
  assert.deepEqual(parseWatchlistRowSymbols('AMD'), { ok: true, symbols: ['AMD'] });
  assert.equal(parseWatchlistRowSymbols('').ok, false);
  assert.equal(parseWatchlistRowSymbols('AAPL,<script>').ok, false);
  const many = Array.from({ length: WATCHLIST_ROWS_MAX_SYMBOLS + 1 }, (_, index) => `S${index}`).join(',');
  assert.match(parseWatchlistRowSymbols(many).reason, /At most 50/);
});

test('crypto is annualized over every calendar day and everything else over trading days', () => {
  assert.equal(annualizationDaysFor('ETH'), 365);
  assert.equal(annualizationDaysFor('msft'), 252);
});

test('the chart covers the last three months of the series, measured from its own newest close', () => {
  const window = chartWindow(yearOfCloses());
  const span = (new Date(window.at(-1).timestamp) - new Date(window[0].timestamp)) / 86_400_000;
  assert.ok(span <= 92 && span >= 85, `span ${span}`);
  assert.equal(chartWindow([]).length, 0);
});

test('an untracked ticker with a year of closes is scored by the same model as everything else', () => {
  const row = buildWatchlistRow({ symbol: 'MSFT', yearPoints: yearOfCloses(), source: 'Yahoo Finance daily closes' });
  assert.equal(row.status, 'calculated');
  assert.equal(row.tracked, false);
  assert.equal(row.source, 'Yahoo Finance daily closes');
  assert.ok(Number.isFinite(row.model.score));
  assert.equal(typeof row.model.regime, 'string');
  assert.ok(row.changePct > 0, 'a rising series shows a positive three-month change');
  assert.equal(row.last, row.points.at(-1).value);
  assert.equal(row.reason, null);
});

test('a ticker with no closes says so rather than showing blanks', () => {
  const row = buildWatchlistRow({ symbol: 'ZZZZ', yearPoints: [], source: 'Yahoo Finance daily closes' });
  assert.equal(row.status, 'unavailable');
  assert.equal(row.model, null);
  assert.match(row.reason, /No daily closes were returned for ZZZZ/);
  // A provider failure is reported as the reason instead of blaming the ticker.
  assert.match(buildWatchlistRow({ symbol: 'MSFT', yearPoints: [], reason: 'Yahoo did not answer.' }).reason, /Yahoo did not answer/);
});

test('a tracked symbol keeps the history and score the rest of the app shows', () => {
  const history = { source: 'PostgreSQL (stored provider history)', stored: true, points: yearOfCloses({ sessions: 64 }).map((point) => ({ timestamp: `${point.date}T00:00:00.000Z`, value: point.value })) };
  const technical = { model: { score: 71, regime: 'Constructive', asOf: '2026-01-01T00:00:00.000Z', indicators: { pctFrom52wHigh: -2.5 } } };
  const row = trackedWatchlistRow({ symbol: 'NVDA', history, technical });
  assert.equal(row.status, 'calculated');
  assert.equal(row.tracked, true);
  assert.equal(row.stored, true);
  assert.deepEqual([row.model.score, row.model.regime, row.model.pctFrom52wHigh], [71, 'Constructive', -2.5]);

  const stale = trackedWatchlistRow({ symbol: 'NVDA', history: { ...history, stale: true }, technical: { model: null } });
  assert.equal(stale.status, 'unavailable');
  assert.match(stale.reason, /too old/);
  const failed = trackedWatchlistRow({ symbol: 'NVDA', history: null, technical: null, reason: 'Twelve Data answered 429.' });
  assert.match(failed.reason, /429/);
});

test('a listing under a year old is still scored, from the closes it has', () => {
  const row = buildWatchlistRow({ symbol: 'NEWCO', yearPoints: yearOfCloses({ sessions: 80 }), source: 'Yahoo Finance daily closes' });
  assert.equal(row.status, 'calculated');
  assert.ok(Number.isFinite(row.model.score));
});
