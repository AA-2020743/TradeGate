import test from 'node:test';
import assert from 'node:assert/strict';
import { attachSeriesCoverage, getAllEquityHistorySymbols, getCoreEquityHistorySymbols, indexCatalog, sectorCatalog } from './equityCatalog.js';

test('equity catalog has unique provider symbols', () => {
  const symbols = getAllEquityHistorySymbols();
  assert.equal(new Set(symbols).size, symbols.length);
});

test('core equity ingestion includes priority indices and all sectors', () => {
  const coreSymbols = new Set(getCoreEquityHistorySymbols());
  for (const index of indexCatalog.filter((item) => item.priority === 1)) assert.ok(coreSymbols.has(index.symbol));
  for (const sector of sectorCatalog) assert.ok(coreSymbols.has(sector.symbol));
});

test('series coverage requires calculation history and identifies stale data', () => {
  const fresh = new Date('2026-08-20T00:00:00.000Z').toISOString();
  const stale = new Date('2026-08-01T00:00:00.000Z').toISOString();
  const [ready, stopped, pending] = attachSeriesCoverage(indexCatalog.slice(0, 3), [
    { symbol: indexCatalog[0].symbol, observations: 252, startsAt: '2025-08-20T00:00:00.000Z', endsAt: fresh },
    { symbol: indexCatalog[1].symbol, observations: 80, startsAt: '2026-05-01T00:00:00.000Z', endsAt: stale },
  ], new Date('2026-08-20T12:00:00.000Z').getTime());
  assert.equal(ready.coverage.status, 'ready');
  // This assertion used to read status 'partial' alongside stale true on the
  // same object, which is the contradiction rather than the behaviour: the
  // interface renders the status without the flag beside it, so a history that
  // had stopped looked identical to one still filling up.
  assert.equal(stopped.coverage.stale, true);
  assert.equal(stopped.coverage.status, 'stale');
  assert.equal(pending.coverage.status, 'pending');
});

test('coverage reports a stalled history as stale however thin it is', () => {
  const now = Date.parse('2026-08-24T12:00:00.000Z');
  const stopped = '2025-08-20T00:00:00.000Z';
  const printing = '2026-08-21T00:00:00.000Z';
  const rows = [
    { symbol: 'DEEP_DEAD', observations: 400, endsAt: stopped },
    { symbol: 'THIN_DEAD', observations: 150, endsAt: stopped },
    { symbol: 'THIN_LIVE', observations: 150, endsAt: printing },
    { symbol: 'NEW_DEAD', observations: 20, endsAt: stopped },
    { symbol: 'NEW_LIVE', observations: 20, endsAt: printing },
    { symbol: 'DEEP_LIVE', observations: 400, endsAt: printing },
    { symbol: 'NOTHING', observations: 0, endsAt: null },
  ];
  const status = Object.fromEntries(
    attachSeriesCoverage(rows.map((row) => ({ symbol: row.symbol })), rows, now)
      .map((item) => [item.symbol, item.coverage.status]),
  );

  // Staleness was only checked above 200 observations, so a 150-session
  // history that stopped a year ago reported the same "partial" as one still
  // printing daily - and the interface shows this status without the stale
  // flag beside it, which made the two indistinguishable.
  assert.equal(status.THIN_DEAD, 'stale');
  assert.equal(status.THIN_LIVE, 'partial');
  assert.notEqual(status.THIN_DEAD, status.THIN_LIVE);

  // A short history that is still printing is accumulating, not dead.
  assert.equal(status.NEW_LIVE, 'pending');
  assert.equal(status.NEW_DEAD, 'stale');

  assert.equal(status.DEEP_DEAD, 'stale');
  assert.equal(status.DEEP_LIVE, 'ready');
  assert.equal(status.NOTHING, 'pending');
});
