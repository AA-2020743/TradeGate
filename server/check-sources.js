/**
 * Calls every external-source loader once and reports what each returned.
 *
 *   npm run check:sources          readable report
 *   npm run check:sources -- --json
 *
 * Run it on the server after a deploy: it uses the same .env, keys and
 * database as the app, and touches nothing but the in-memory cache.
 */
import { config } from './config.js';
import { closeDatabase, getIngestionStatus, isDatabaseConfigured } from './database.js';
import {
  getAccumulationSchedules,
  getAlertOutcomes,
  getBitcoinCycleWorkspace,
  getCryptoOptionsWorkspace,
  getFactorReturns,
  getIndexValuation,
  getLiquiditySnapshot,
  getMarketSnapshot,
  getPriceCrossCheck,
  getTreasuryFunding,
} from './providers.js';
import { formatReport, summarizeIngestion, summarizeSource } from './sourceCheck.js';

const TIMEOUT_MS = 90_000;

const SOURCES = [
  {
    name: 'FRED macro series',
    endpoint: '/api/macro/liquidity',
    load: getLiquiditySnapshot,
    answered: (payload) => payload.provider.failedSeries === 0 && payload.provider.abandonedSeries === 0,
    figure: (payload) => `${payload.provider.requestedSeries - payload.provider.failedSeries} of ${payload.provider.requestedSeries} series fetched (${payload.provider.mode}), ${payload.provider.staleSeries} stale, ${payload.provider.abandonedSeries} abandoned`,
  },
  {
    name: 'Market quotes (Twelve Data, CoinGecko)',
    endpoint: '/api/markets/snapshot',
    load: getMarketSnapshot,
    answered: (payload) => (payload.assets ?? []).some((asset) => Number.isFinite(asset.price)),
    figure: (payload) => `${(payload.assets ?? []).filter((asset) => Number.isFinite(asset.price)).length} assets priced`,
  },
  {
    name: 'Yahoo 10-year histories (DCA)',
    endpoint: '/api/analytics/accumulation',
    load: getAccumulationSchedules,
    figure: (payload) => `${(payload.schedules ?? []).filter((schedule) => schedule.status !== 'unavailable').length} of ${(payload.schedules ?? []).length} assets ranked, as of ${payload.asOf ?? 'n/a'}`,
  },
  {
    name: 'Shiller S&P data (valuation)',
    endpoint: '/api/analytics/index-valuation',
    load: getIndexValuation,
    figure: (payload) => (Number.isFinite(payload.cape) ? `CAPE ${payload.cape} for ${payload.asOf}, earnings through ${payload.earningsThrough}; from ${payload.source}` : null),
  },
  {
    name: 'Deribit options',
    endpoint: '/api/analytics/crypto-options',
    load: getCryptoOptionsWorkspace,
    figure: (payload) => (payload.surfaces ?? []).map((surface) => `${surface.currency} ${surface.status}`).join(', ') || null,
  },
  {
    name: 'Treasury Fiscal Data',
    endpoint: '/api/macro/treasury',
    load: getTreasuryFunding,
    figure: () => null,
  },
  {
    name: 'Ken French factors',
    endpoint: '/api/analytics/factors',
    load: getFactorReturns,
    figure: (payload) => (payload.asOf ? `through ${String(payload.asOf).slice(0, 10)}` : null),
  },
  {
    name: 'Bitcoin workspace (derivatives venues, on-chain)',
    endpoint: '/api/analytics/bitcoin',
    load: getBitcoinCycleWorkspace,
    figure: (payload) => (payload.leverage?.venue ? `funding from ${payload.leverage.venue}` : null),
  },
  {
    name: 'Price cross-check (primary vs Yahoo)',
    endpoint: '/api/analytics/price-crosscheck',
    load: getPriceCrossCheck,
    figure: (payload) => `${payload.passed?.length ?? 0} verified, ${payload.review?.length ?? 0} under review, ${payload.notIndependent?.length ?? 0} not independent, ${payload.unavailable?.length ?? 0} unavailable`,
  },
  {
    name: 'Stored alerts (PostgreSQL) + outcomes',
    endpoint: '/api/analytics/alert-outcomes',
    load: getAlertOutcomes,
    figure: (payload) => (Number.isFinite(payload.alerts) ? `${payload.alerts} alerts stored, ${payload.scoredAlerts ?? 0} scorable` : null),
  },
];

function withTimeout(promise, name) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${name} did not answer within ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

const summaries = [];
try {
  // One at a time: several share upstreams (Yahoo, FRED) and a burst would
  // trip their rate limits, which would read as a source failure.
  for (const source of SOURCES) {
    const started = Date.now();
    const [result] = await Promise.allSettled([withTimeout(Promise.resolve().then(source.load), source.name)]);
    summaries.push(summarizeSource(source, result, Date.now() - started));
    if (!process.argv.includes('--json')) process.stderr.write(`checked ${source.name}\n`);
  }
  const jobs = isDatabaseConfigured() ? await getIngestionStatus().catch(() => []) : [];
  const ingestion = summarizeIngestion({ enabled: config.ingestionEnabled, databaseConfigured: isDatabaseConfigured(), jobs });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ sources: summaries, ingestion }, null, 2));
  } else {
    console.log(formatReport(summaries));
    console.log(`\n${{ ok: 'OK  ', partial: 'PART', failed: 'FAIL' }[ingestion.verdict]}  Ingestion (stored history)`);
    for (const line of ingestion.lines) console.log(`      ${line}`);
  }
} finally {
  await closeDatabase();
}
// Background timers in the providers (cache refreshes) must not hold the process open.
process.exit(0);
