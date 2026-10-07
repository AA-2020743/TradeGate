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
import { SOURCES } from './sourceList.js';
import { formatReport, summarizeIngestion, summarizeSource } from './sourceCheck.js';

const TIMEOUT_MS = 90_000;

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
