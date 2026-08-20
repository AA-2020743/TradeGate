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
  const [ready, partial, pending] = attachSeriesCoverage(indexCatalog.slice(0, 3), [
    { symbol: indexCatalog[0].symbol, observations: 252, startsAt: '2025-08-20T00:00:00.000Z', endsAt: fresh },
    { symbol: indexCatalog[1].symbol, observations: 80, startsAt: '2026-05-01T00:00:00.000Z', endsAt: stale },
  ], new Date('2026-08-20T12:00:00.000Z').getTime());
  assert.equal(ready.coverage.status, 'ready');
  assert.equal(partial.coverage.status, 'partial');
  assert.equal(partial.coverage.stale, true);
  assert.equal(pending.coverage.status, 'pending');
});
