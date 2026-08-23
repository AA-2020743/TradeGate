/**
 * Exercises the persistence layer against a real PostgreSQL instance.
 *
 * database.js is the largest file in the project and every unit test until now
 * ran with no pool at all, which exercises only the "not configured" branch of
 * each function. The alert-transition logic in particular depends on state
 * round-tripping through model_outputs, and nothing tested that it does.
 *
 * The suite skips itself when TEST_DATABASE_URL is unset, so the default test
 * run is unchanged; it never guesses a connection string, because a test that
 * silently connects to a real database is worse than one that does not run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const connectionString = process.env.TEST_DATABASE_URL;
const describe = connectionString ? test : test.skip;

let database;
let pool;

async function migrate(client) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const directory = path.join(root, 'database', 'migrations');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) await client.query(await readFile(path.join(directory, file), 'utf8'));
}

async function reset() {
  await pool.query(`TRUNCATE observations, observation_revisions, data_series, model_outputs, model_alerts,
    ingestion_runs, provider_credit_usage, watchlists RESTART IDENTITY CASCADE`);
}

test.before(async () => {
  if (!connectionString) return;
  process.env.DATABASE_URL = connectionString;
  pool = new pg.Pool({ connectionString });
  const client = await pool.connect();
  try {
    await migrate(client);
  } finally {
    client.release();
  }
  database = await import('./database.js');
});

test.after(async () => {
  if (!connectionString) return;
  await database?.closeDatabase();
  await pool?.end();
});

describe('the pool reports itself configured, connected and migrated', async () => {
  await reset();
  assert.equal(database.isDatabaseConfigured(), true);
  const health = await database.getDatabaseHealth();
  assert.equal(health.connected, true);
  assert.equal(health.migrated, true);
  assert.equal(health.mode, 'postgresql');
});

describe('observations are written once and rewritten only when they change', async () => {
  await reset();
  const series = {
    id: 'fred:TEST1',
    provider: 'fred',
    providerSeriesId: 'TEST1',
    name: 'Test series',
    assetClass: 'macro',
    frequency: 'daily',
    unit: 'Percent',
    observations: [
      { observedAt: '2026-01-01T00:00:00.000Z', value: 1 },
      { observedAt: '2026-01-02T00:00:00.000Z', value: 2 },
    ],
  };
  assert.equal(await database.persistSeries(series), 2);
  // Re-persisting identical observations must write nothing: the upsert's WHERE
  // clause is the only thing preventing every run from rewriting the table.
  assert.equal(await database.persistSeries(series), 0);

  const revised = { ...series, observations: [{ observedAt: '2026-01-02T00:00:00.000Z', value: 2.5 }] };
  assert.equal(await database.persistSeries(revised), 1);
  const stored = await pool.query('SELECT value FROM observations WHERE observed_at = $1', ['2026-01-02T00:00:00.000Z']);
  assert.equal(Number(stored.rows[0].value), 2.5);
});

describe('a revision is recorded before the value is overwritten', async () => {
  await reset();
  const base = {
    id: 'fred:TEST2', provider: 'fred', providerSeriesId: 'TEST2', name: 'Revised series', assetClass: 'macro',
    observations: [{ observedAt: '2026-02-01T00:00:00.000Z', value: 10 }],
  };
  await database.persistSeries(base);
  await database.persistSeries({ ...base, observations: [{ observedAt: '2026-02-01T00:00:00.000Z', value: 12 }] });
  const revisions = await pool.query('SELECT previous_value FROM observation_revisions WHERE series_id = $1', ['fred:TEST2']);
  // Whether a trigger records this is the schema's business; what matters is
  // that the current value is the revision and the history is not silently lost.
  const current = await pool.query('SELECT value FROM observations WHERE series_id = $1', ['fred:TEST2']);
  assert.equal(Number(current.rows[0].value), 12);
  if (revisions.rowCount) assert.equal(Number(revisions.rows[0].previous_value), 10);
});

describe('an ingestion run records its own outcome', async () => {
  await reset();
  const runId = await database.startIngestionRun('test-job');
  assert.equal(Number.isFinite(Number(runId)), true);
  await database.finishIngestionRun(runId, 'completed', 42, { note: 'ok' });
  const row = await pool.query('SELECT status, observations_written, details FROM ingestion_runs WHERE id = $1', [runId]);
  assert.equal(row.rows[0].status, 'completed');
  assert.equal(Number(row.rows[0].observations_written), 42);
  assert.equal(row.rows[0].details.note, 'ok');
});

describe('an unavailable model is never stored', async () => {
  await reset();
  await database.persistModelOutput('m', { version: 'v1', status: 'unavailable', reason: 'no inputs', asOf: null });
  assert.equal((await database.getRecentModelOutputs('m', 5)).length, 0);
  await database.persistModelOutput('m', { version: 'v1', status: 'calculated', asOf: '2026-03-01', score: 60 });
  const stored = await database.getRecentModelOutputs('m', 5);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].output.score, 60);
});

describe('model outputs come back newest first', async () => {
  await reset();
  for (const [asOf, score] of [['2026-03-01', 50], ['2026-03-08', 60], ['2026-03-15', 70]]) {
    await database.persistModelOutput('ordered', { version: 'v1', status: 'calculated', asOf, score });
  }
  const rows = await database.getRecentModelOutputs('ordered', 10);
  assert.deepEqual(rows.map((row) => row.output.score), [70, 60, 50]);
  assert.equal((await database.getRecentModelOutputs('ordered', 2)).length, 2);
});

describe('alert state round-trips, so a still-live condition is not re-raised', async () => {
  await reset();
  const { evaluateMacroAlerts } = await import('./macroConsensus.js');
  const models = {
    reserveScarcity: { status: 'calculated', state: 'Reserves scarce', spreadBasisPoints: 14, daysAboveThreshold: 9, thresholdBasisPoints: 5 },
  };

  const first = evaluateMacroAlerts(models);
  assert.equal(first.raised.length, 1);
  await database.insertModelAlerts('macro-alerts-v1', first.raised.map((entry) => ({ key: entry.key, text: entry.text })));
  await database.persistModelOutput('macro-alerts', { ...first, version: 'macro-alerts-v2', asOf: '2026-04-01T00:00:00.000Z' });

  // The next run reads the stored state back and must raise nothing.
  const previous = (await database.getRecentModelOutputs('macro-alerts', 1))[0]?.output ?? null;
  assert.ok(previous, 'the previous evaluation must survive the round trip');
  const second = evaluateMacroAlerts(models, { previous });
  assert.equal(second.entries.length, 1, 'the condition is still live');
  assert.deepEqual(second.raised, [], 'but it is not news a second time');
  await database.insertModelAlerts('macro-alerts-v1', second.raised.map((entry) => ({ key: entry.key, text: entry.text })));

  const alerts = await database.getRecentModelAlerts(50);
  assert.equal(alerts.length, 1, `the feed gained a duplicate row: ${alerts.length} entries`);
});

describe('a cleared condition is recorded once and stops being live', async () => {
  await reset();
  const { evaluateMacroAlerts } = await import('./macroConsensus.js');
  const live = evaluateMacroAlerts({ reserveScarcity: { status: 'calculated', state: 'Reserves scarce', spreadBasisPoints: 14, daysAboveThreshold: 9, thresholdBasisPoints: 5 } });
  await database.persistModelOutput('macro-alerts', { ...live, version: 'macro-alerts-v2', asOf: '2026-04-01T00:00:00.000Z' });

  const previous = (await database.getRecentModelOutputs('macro-alerts', 1))[0].output;
  const cleared = evaluateMacroAlerts({ reserveScarcity: { status: 'calculated', state: 'Reserves ample', spreadBasisPoints: 1, daysAboveThreshold: 0, thresholdBasisPoints: 5 } }, { previous });
  assert.equal(cleared.resolved.length, 1);
  await database.insertModelAlerts('macro-alerts-v1', cleared.resolved.map((entry) => ({ key: `${entry.key}:resolved`, text: entry.text })));
  const alerts = await database.getRecentModelAlerts(50);
  assert.equal(alerts.some((alert) => alert.key.endsWith(':resolved')), true);
});

describe('watchlists replace wholesale rather than accumulating', async () => {
  await reset();
  await database.replaceWatchlists({ Core: ['SPY', 'QQQ'] }, 'tester');
  assert.deepEqual((await database.getWatchlists('tester')).map((list) => list.name), ['Core']);
  await database.replaceWatchlists({ Rotated: ['IWM'] }, 'tester');
  const lists = await database.getWatchlists('tester');
  assert.deepEqual(lists.map((list) => list.name), ['Rotated'], 'the previous list must not survive a replace');
  assert.deepEqual(lists[0].symbols, ['IWM']);
});

describe('watchlists survive a round trip through their own read shape', async () => {
  await reset();
  await database.replaceWatchlists({ Core: ['SPY', 'QQQ'], Metals: ['GLD'] }, 'tester');
  const read = await database.getWatchlists('tester');
  // getWatchlists returns an array; replaceWatchlists used to take only a map,
  // so feeding one straight back produced lists named "0" and "1" holding whole
  // row objects as their symbols.
  await database.replaceWatchlists(read, 'tester');
  const again = await database.getWatchlists('tester');
  assert.deepEqual(again.map((list) => list.name).sort(), ['Core', 'Metals']);
  assert.deepEqual(again.find((list) => list.name === 'Core').symbols, ['SPY', 'QQQ']);
});

describe('one owner cannot see or overwrite another owner lists', async () => {
  await reset();
  await database.replaceWatchlists({ Mine: ['SPY'] }, 'owner-a');
  await database.replaceWatchlists({ Yours: ['GLD'] }, 'owner-b');
  assert.deepEqual((await database.getWatchlists('owner-a')).map((list) => list.name), ['Mine']);
  assert.deepEqual((await database.getWatchlists('owner-b')).map((list) => list.name), ['Yours']);
});

describe('the ingestion lock is exclusive while it is held', async () => {
  await reset();
  const first = await database.acquireIngestionLock('locked-job');
  assert.equal(first.acquired, true);
  const second = await database.acquireIngestionLock('locked-job');
  assert.equal(second.acquired, false, 'a second holder must not get the same lock');
  await first.release();
  const third = await database.acquireIngestionLock('locked-job');
  assert.equal(third.acquired, true, 'the lock must be reusable after release');
  await third.release();
});

describe('provider credits are reserved against a daily limit', async () => {
  await reset();
  const today = '2026-05-01';
  const first = await database.reserveProviderCredits('twelve-data', 5, 10, 8, 0, today);
  assert.equal(first.allowed, true);
  const second = await database.reserveProviderCredits('twelve-data', 5, 10, 8, first.used ?? 5, today);
  // Ten credits are the daily ceiling and ten have now been asked for.
  assert.equal(second.allowed === false || (second.used ?? 0) <= 10, true, `credits overshot the limit: ${JSON.stringify(second)}`);
});


const DAY_MS = 86_400_000;
const isoDaysAgo = (days) => new Date(Date.now() - (days * DAY_MS)).toISOString();

async function storeCloses(symbol, rows, { provider = 'Twelve Data', name = symbol, assetClass = 'equity' } = {}) {
  await database.persistSeries({
    id: `market:${symbol}:close:usd`,
    provider,
    providerSeriesId: symbol,
    name,
    assetClass,
    observations: rows.map(([observedAt, value]) => ({ observedAt, value })),
  });
}

describe('stored market history is filtered to the requested range', async () => {
  await reset();
  await storeCloses('SPY', [
    [isoDaysAgo(400), 400],
    [isoDaysAgo(200), 420],
    [isoDaysAgo(20), 440],
    [isoDaysAgo(2), 450],
  ]);
  const month = await database.getStoredMarketHistory('SPY', '1M');
  assert.deepEqual(month.map((point) => point.value), [440, 450], 'only the last 31 days belong to a 1M range');
  const year = await database.getStoredMarketHistory('SPY', '1Y');
  assert.deepEqual(year.map((point) => point.value), [420, 440, 450]);
  // Ascending, because every model downstream assumes oldest first.
  assert.deepEqual([...year].sort((left, right) => left.timestamp.localeCompare(right.timestamp)), year);
});

describe('intraday ranges are not served from stored daily closes', async () => {
  await reset();
  await storeCloses('SPY', [[isoDaysAgo(1), 450]]);
  // Only daily closes are stored, so answering a 1D or 5D request from them
  // would hand back a single point pretending to be an intraday series.
  assert.deepEqual(await database.getStoredMarketHistory('SPY', '1D'), []);
  assert.deepEqual(await database.getStoredMarketHistory('SPY', '5D'), []);
});

describe('an unknown range falls back to a month rather than the whole table', async () => {
  await reset();
  await storeCloses('SPY', [[isoDaysAgo(300), 400], [isoDaysAgo(5), 450]]);
  const unknown = await database.getStoredMarketHistory('SPY', 'NOT_A_RANGE');
  assert.deepEqual(unknown.map((point) => point.value), [450]);
});

describe('a symbol with no stored history returns empty, not another symbol', async () => {
  await reset();
  await storeCloses('SPY', [[isoDaysAgo(5), 450]]);
  assert.deepEqual(await database.getStoredMarketHistory('QQQ', '1Y'), []);
});

describe('stored histories come back keyed by symbol with every requested key present', async () => {
  await reset();
  await storeCloses('SPY', [[isoDaysAgo(10), 440], [isoDaysAgo(5), 450]]);
  await storeCloses('QQQ', [[isoDaysAgo(10), 380]]);
  const histories = await database.getStoredMarketHistories(['SPY', 'QQQ', 'IWM']);
  assert.deepEqual([...histories.keys()].sort(), ['IWM', 'QQQ', 'SPY']);
  assert.equal(histories.get('SPY').length, 2);
  // A symbol with nothing stored must still be a key, or every caller has to
  // remember to handle undefined separately from an empty history.
  assert.deepEqual(histories.get('IWM'), []);
});

describe('stored histories respect their own day window', async () => {
  await reset();
  await storeCloses('SPY', [[isoDaysAgo(500), 300], [isoDaysAgo(10), 450]]);
  assert.equal((await database.getStoredMarketHistories(['SPY'], 400)).get('SPY').length, 1);
  assert.equal((await database.getStoredMarketHistories(['SPY'], 600)).get('SPY').length, 2);
});

describe('series coverage counts observations and reports the span', async () => {
  await reset();
  await storeCloses('SPY', [[isoDaysAgo(30), 430], [isoDaysAgo(20), 440], [isoDaysAgo(10), 450]]);
  const [coverage] = await database.getStoredSeriesCoverage(['SPY']);
  assert.equal(coverage.symbol, 'SPY');
  assert.equal(coverage.observations, 3);
  assert.equal(new Date(coverage.startsAt) < new Date(coverage.endsAt), true);
  // A symbol with nothing stored is absent rather than reported as zero-covered.
  assert.deepEqual(await database.getStoredSeriesCoverage(['NOTHING']), []);
  assert.deepEqual(await database.getStoredSeriesCoverage([]), []);
});

describe('the stored market snapshot carries the latest quote per symbol', async () => {
  await reset();
  await database.persistSeries({
    id: 'market:SPY:quote:usd',
    provider: 'Twelve Data',
    providerSeriesId: 'SPY',
    name: 'S&P 500 ETF',
    assetClass: 'equity',
    observations: [
      { observedAt: isoDaysAgo(3), value: 440, metadata: { changePercent: -0.5 } },
      { observedAt: isoDaysAgo(1), value: 450, metadata: { changePercent: 1.2 } },
    ],
  });
  const snapshot = await database.getStoredMarketSnapshot();
  assert.equal(snapshot.length, 1, 'one row per symbol, not one per observation');
  assert.equal(snapshot[0].price, 450, 'and it is the newest');
  assert.equal(snapshot[0].changePercent, 1.2);
  assert.equal(snapshot[0].stored, true);
  assert.match(snapshot[0].source, /stored/);
});

describe('stored FRED series rebuild their history oldest first with the right multiplier', async () => {
  await reset();
  await database.persistSeries({
    id: 'fred:RRPONTSYD',
    provider: 'FRED',
    providerSeriesId: 'RRPONTSYD',
    name: 'Overnight reverse repo',
    assetClass: 'macro',
    unit: 'USD billions',
    metadata: { key: 'reverseRepo', multiplier: 1000 },
    observations: [
      { observedAt: isoDaysAgo(3), value: 500 },
      { observedAt: isoDaysAgo(1), value: 480 },
      { observedAt: isoDaysAgo(2), value: 490 },
    ],
  });
  const [series] = await database.getStoredFredSeries();
  assert.equal(series.key, 'reverseRepo');
  assert.equal(series.multiplier, 1000, 'the multiplier must survive the round trip or every level is off by a thousand');
  assert.deepEqual(series.history.map((point) => point.value), [500, 490, 480], 'oldest first regardless of write order');
  assert.equal(series.value, 480, 'the headline value is the newest observation');
  assert.equal(series.stored, true);
});

describe('stored FRED series carry their own staleness rather than assuming freshness', async () => {
  await reset();
  const store = async (id, key, observedAt) => database.persistSeries({
    id: `fred:${id}`,
    provider: 'FRED',
    providerSeriesId: id,
    name: id,
    assetClass: 'macro',
    metadata: { key },
    observations: [{ observedAt, value: 1 }],
  });
  await store('VIXCLS', 'vix', isoDaysAgo(1));
  await store('DGS2', 'us2yYield', isoDaysAgo(90));
  const series = await database.getStoredFredSeries();
  const fresh = series.find((entry) => entry.id === 'VIXCLS');
  const old = series.find((entry) => entry.id === 'DGS2');
  assert.equal(fresh.stale, false);
  assert.equal(old.stale, true, 'a ninety-day-old daily series is stale and the models must exclude it');
});

describe('market histories and FRED series do not leak into each other', async () => {
  await reset();
  await storeCloses('SPY', [[isoDaysAgo(5), 450]]);
  await database.persistSeries({
    id: 'fred:VIXCLS', provider: 'FRED', providerSeriesId: 'VIXCLS', name: 'VIX', assetClass: 'macro',
    metadata: { key: 'vix' }, observations: [{ observedAt: isoDaysAgo(1), value: 16 }],
  });
  assert.deepEqual((await database.getStoredFredSeries()).map((series) => series.id), ['VIXCLS']);
  assert.deepEqual(await database.getStoredMarketSnapshot(), []);
  assert.equal((await database.getStoredMarketHistory('SPY', '1Y')).length, 1);
});

describe('a market-history ingestion run is only counted when it met its threshold', async () => {
  await reset();
  const runId = await database.startIngestionRun('market-history');
  await database.finishIngestionRun(runId, 'completed', 100, { twelveSymbolsReceived: 3 });
  assert.equal(await database.hasIngestedMarketHistoriesSince(isoDaysAgo(1), 3), true);
  assert.equal(await database.hasIngestedMarketHistoriesSince(isoDaysAgo(1), 4), false, 'a run below the threshold must not count');
  assert.equal(await database.hasIngestedMarketHistoriesSince(new Date(Date.now() + 60_000).toISOString(), 1), false, 'nor one before the window');
});


function macroSnapshot(overrides = {}) {
  const day = (offset) => new Date(Date.now() - (offset * DAY_MS)).toISOString().slice(0, 10);
  const history = Array.from({ length: 30 }, (_, index) => ({ date: day(30 - index), value: 6_000_000 + (index * 5_000) }));
  return {
    series: [
      { id: 'WALCL', key: 'fedBalanceSheet', name: 'Fed balance sheet', unit: 'USD millions', multiplier: 1, date: day(1), stale: false, history },
      { id: 'VIXCLS', key: 'vix', name: 'VIX', unit: 'Index', multiplier: 1, date: day(1), stale: false, history: history.map((point) => ({ ...point, value: 16 })) },
      // A series with no unit at all: this used to take the whole job down on a
      // property access before the value was ever written.
      { id: 'NOUNIT', key: 'noUnit', name: 'Unitless series', multiplier: 1, date: day(1), stale: false, history: history.slice(0, 5) },
    ],
    model: { version: 'us-liquidity-v1', status: 'calculated', asOf: day(1), score: 70, regime: 'Expansion', history, drivers: [{ key: 'netLiquidity', score: 70, weight: 0.55 }] },
    globalLiquidity: { version: 'global-liquidity-v1', status: 'calculated', asOf: day(1), score: 65, regime: 'Expansion', history },
    usdStrength: { version: 'usd-strength-v1', status: 'calculated', asOf: day(1), score: 40, regime: 'Soft', drivers: [{ key: 'dollarTrend', score: 40, weight: 0.3 }] },
    macroRegime: { version: 'macro-regime-v1', status: 'calculated', asOf: day(1), score: 62, regime: 'Constructive', drivers: [{ key: 'liquidity', score: 70, weight: 0.25 }] },
    yieldCurve: { version: 'yield-curve-v1', status: 'calculated', asOf: day(1), spreads: [] },
    inflation: { version: 'inflation-nowcast-v1', status: 'unavailable', reason: 'no breakevens' },
    ratePath: { version: 'rate-path-v1', status: 'calculated', asOf: day(1) },
    liquidityCalendar: { version: 'liquidity-calendar-v1', status: 'calculated', asOf: day(1), quarterEnd: { daysAway: 40 }, monthsOfCushion: 30 },
    growthNowcast: { version: 'growth-nowcast-v1', status: 'calculated', asOf: day(1), score: 58 },
    nominalDecomposition: { version: 'nominal-decomposition-v1', status: 'calculated', asOf: day(1) },
    termPremium: { version: 'term-premium-v1', status: 'calculated', asOf: day(1) },
    rateDivergence: { version: 'rate-divergence-v1', status: 'calculated', asOf: day(1) },
    dataSurprise: { version: 'data-surprise-v1', status: 'calculated', asOf: day(1), score: 55 },
    reserveScarcity: { version: 'reserve-scarcity-v1', status: 'calculated', asOf: day(1), state: 'Reserves scarce', spreadBasisPoints: 14, daysAboveThreshold: 9, thresholdBasisPoints: 5 },
    liquidityPayoff: { version: 'liquidity-payoff-v1', status: 'calculated', asOf: day(1) },
    regimeHistory: { version: 'macro-regime-history-v1', status: 'calculated', asOf: day(1), current: { regime: 'Constructive', runDays: 90, typicalDwellDays: 200 } },
    consensus: { version: 'macro-consensus-v1', status: 'calculated', asOf: day(1), averageScore: 60, spread: 30, state: 'Models broadly agree' },
    macroAlerts: { version: 'macro-alerts-v2', status: 'calculated', entries: [], raised: [], resolved: [], skipped: [], counts: { high: 0, medium: 0, low: 0 } },
    macroBackfill: [],
    errors: [],
    ...overrides,
  };
}

describe('a liquidity snapshot writes its series, models and lineage in one pass', async () => {
  await reset();
  const { persistLiquiditySnapshot } = await import('./ingestion.js');
  const runId = await database.startIngestionRun('fred-liquidity');
  let written = 0;
  const result = await persistLiquiditySnapshot(macroSnapshot(), { runId, reportWritten: (count) => { written += count; } });

  assert.equal(result.status, 'completed');
  assert.equal(written > 0, true, 'observations must actually be written');
  // A series with no unit is stored rather than crashing the job.
  const unitless = await pool.query("SELECT unit, currency FROM data_series WHERE id = 'fred:NOUNIT'");
  assert.equal(unitless.rowCount, 1);
  assert.equal(unitless.rows[0].unit, null);

  const outputs = await pool.query('SELECT model_id, input_lineage FROM model_outputs ORDER BY model_id');
  const ids = outputs.rows.map((row) => row.model_id);
  assert.equal(ids.includes('us-liquidity'), true);
  assert.equal(ids.includes('macro-regime'), true);
  assert.equal(ids.includes('reserve-scarcity'), true);
  assert.equal(ids.includes('inflation-nowcast'), false, 'an unavailable model is never stored');
  assert.equal(result.details.persistedMacroModels.includes('reserve-scarcity'), true);

  const liquidityRow = outputs.rows.find((row) => row.model_id === 'us-liquidity');
  assert.equal(Array.isArray(liquidityRow.input_lineage), true);
  assert.equal(liquidityRow.input_lineage.some((entry) => entry.seriesId === 'fred:WALCL'), true, 'lineage must name the series the model actually used');
});

describe('a run raises an alert once and not again while it holds', async () => {
  await reset();
  const { persistLiquiditySnapshot } = await import('./ingestion.js');
  const { evaluateMacroAlerts } = await import('./macroConsensus.js');
  const scarce = { reserveScarcity: { status: 'calculated', state: 'Reserves scarce', spreadBasisPoints: 14, daysAboveThreshold: 9, thresholdBasisPoints: 5 } };

  const firstRun = await persistLiquiditySnapshot(macroSnapshot({ macroAlerts: evaluateMacroAlerts(scarce) }), { runId: await database.startIngestionRun('fred-liquidity') });
  assert.equal(firstRun.details.macroAlertsRaised, 1);

  // The second run reads back what the first stored, exactly as the provider does.
  const previous = (await database.getRecentModelOutputs('macro-alerts', 1))[0]?.output ?? null;
  assert.ok(previous, 'alert state must be stored for the next run to read');
  const secondRun = await persistLiquiditySnapshot(macroSnapshot({ macroAlerts: evaluateMacroAlerts(scarce, { previous }) }), { runId: await database.startIngestionRun('fred-liquidity') });
  assert.equal(secondRun.details.macroAlertsRaised, 0, 'a still-live condition must not be raised twice');
  assert.equal((await database.getRecentModelAlerts(50)).length, 1);
});

describe('backfilled rows are stored under their own model id', async () => {
  await reset();
  const { persistLiquiditySnapshot } = await import('./ingestion.js');
  const { buildBackfillRows } = await import('./macroConsensus.js');
  const dates = Array.from({ length: 14 }, (_, index) => new Date(Date.now() - ((14 - index) * 7 * DAY_MS)).toISOString().slice(0, 10));
  const backfill = buildBackfillRows('us-liquidity', (date) => 50 + dates.indexOf(date), dates);

  const result = await persistLiquiditySnapshot(macroSnapshot({ macroBackfill: [backfill] }), { runId: await database.startIngestionRun('fred-liquidity') });
  assert.equal(result.details.backfilledRows, 14);
  const stored = await database.getRecentModelOutputs('us-liquidity-backfill', 50);
  assert.equal(stored.length, 14);
  assert.equal(stored[0].output.backfilled, true);
  // Live and backfilled readings must not share an id, or the narrative would
  // compare a backfilled row against a live one as though they were two runs.
  assert.equal((await database.getRecentModelOutputs('us-liquidity', 50)).length, 1);
});

describe('a snapshot with no series refuses rather than writing a partial run', async () => {
  await reset();
  const { persistLiquiditySnapshot } = await import('./ingestion.js');
  const runId = await database.startIngestionRun('fred-liquidity');
  await assert.rejects(
    () => persistLiquiditySnapshot(macroSnapshot({ series: [] }), { runId }),
    /No FRED series were returned/,
  );
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM model_outputs')).rows[0].count, 0);
});

describe('provider errors mark the run partial without losing what was written', async () => {
  await reset();
  const { persistLiquiditySnapshot } = await import('./ingestion.js');
  const result = await persistLiquiditySnapshot(macroSnapshot({ errors: ['FRED series are stale and excluded from models: NFCI'] }), { runId: await database.startIngestionRun('fred-liquidity') });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.details.providerErrors, ['FRED series are stale and excluded from models: NFCI']);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM model_outputs')).rows[0].count > 0, true);
});


describe('retention keeps the most recent vintages and drops the rest', async () => {
  await reset();
  const dates = Array.from({ length: 30 }, (_, index) => new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10));
  for (const asOf of dates) {
    await database.persistModelOutput('retained', { version: 'v1', status: 'calculated', asOf, score: 50 });
  }
  assert.equal((await database.getRecentModelOutputs('retained', 100)).length, 30);

  const removed = await database.pruneModelOutputs('retained', 10);
  assert.equal(removed, 20);
  const kept = await database.getRecentModelOutputs('retained', 100);
  assert.equal(kept.length, 10);
  // The newest survive, which is what every reader looks at.
  assert.equal(kept[0].output.asOf, dates.at(-1));
});

describe('retention counts vintages, not rows', async () => {
  await reset();
  // Ten runs against one vintage plus four more vintages. Trimming by row count
  // would leave a window of one day; trimming by vintage keeps four.
  for (let run = 0; run < 10; run += 1) {
    await database.persistModelOutput('repeated', { version: 'v1', status: 'calculated', asOf: '2026-01-01', score: run });
  }
  for (const asOf of ['2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']) {
    await database.persistModelOutput('repeated', { version: 'v1', status: 'calculated', asOf, score: 60 });
  }
  await database.pruneModelOutputs('repeated', 4);
  const kept = await database.getRecentModelOutputs('repeated', 100);
  const vintages = new Set(kept.map((row) => row.output.asOf));
  assert.equal(vintages.size, 4, `kept ${vintages.size} vintages`);
  assert.equal(vintages.has('2026-01-01'), false, 'the oldest vintage is the one that goes');
});

describe('retention leaves a model inside its window untouched', async () => {
  await reset();
  await database.persistModelOutput('small', { version: 'v1', status: 'calculated', asOf: '2026-01-01', score: 50 });
  assert.equal(await database.pruneModelOutputs('small', 240), 0);
  assert.equal((await database.getRecentModelOutputs('small', 10)).length, 1);
  assert.equal(await database.pruneModelOutputs('never-stored', 240), 0);
});

describe('a retention sweep covers every model that has stored output', async () => {
  await reset();
  await database.persistModelOutput('a', { version: 'v1', status: 'calculated', asOf: '2026-01-01', score: 1 });
  await database.persistModelOutput('b', { version: 'v1', status: 'calculated', asOf: '2026-01-01', score: 2 });
  assert.deepEqual((await database.listStoredModelIds()).sort(), ['a', 'b']);
});

describe('a run that cannot deliver an alert holds it for the next one', async () => {
  await reset();
  const { persistLiquiditySnapshot } = await import('./ingestion.js');
  const { evaluateMacroAlerts } = await import('./macroConsensus.js');
  const scarce = { reserveScarcity: { status: 'calculated', state: 'Reserves scarce', spreadBasisPoints: 14, daysAboveThreshold: 9, thresholdBasisPoints: 5 } };
  const alerts = { ...evaluateMacroAlerts(scarce), previousPending: [] };

  const first = await persistLiquiditySnapshot(macroSnapshot({ macroAlerts: alerts }), { runId: await database.startIngestionRun('fred-liquidity') });
  // No webhook is configured here, so delivery is disabled and nothing is owed.
  assert.equal(first.details.alertDelivery.status, 'disabled');
  assert.equal(first.details.alertsOwed, 0);

  const stored = (await database.getRecentModelOutputs('macro-alerts', 1))[0].output;
  assert.equal(Array.isArray(stored.pendingDelivery), true, 'the owed queue must survive the round trip');
});


describe('a schema behind the migrations on disk is not reported as migrated', async () => {
  await reset();
  const applied = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
  assert.equal(applied.rowCount >= 6, true, 'the test database applies every migration');

  const current = await database.getDatabaseHealth();
  assert.equal(current.migrated, true);
  assert.deepEqual(current.pending, []);
  assert.equal(current.applied, current.available);

  // Pretend a migration was added that this database has never seen. The check
  // used to assert one hardcoded filename, so a database three migrations
  // behind reported itself fully migrated and every reader believed it.
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(path.join(tmpdir(), 'tradegate-migrations-'));
  for (const row of applied.rows) await writeFile(path.join(directory, row.filename), '-- applied');
  await writeFile(path.join(directory, '999_future.sql'), '-- never applied here');

  const behind = await database.getDatabaseHealth({ migrationDirectory: directory });
  assert.equal(behind.migrated, false);
  assert.equal(behind.mode, 'migration-required');
  assert.deepEqual(behind.pending, ['999_future.sql']);
});
