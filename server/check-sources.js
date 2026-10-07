/**
 * Calls every external-source loader once and reports what each returned.
 *
 *   npm run check:sources                 readable report
 *   npm run check:sources -- --json
 *   npm run check:sources -- --in-process call the loaders here, not the app
 *
 * Run it on the server after a deploy. When the app answers on its port, each
 * source is read from the app's own endpoint - what it actually serves, from
 * its caches, with no extra provider calls. Otherwise the loaders run here,
 * with the same .env, keys and database.
 */
import { config } from './config.js';
import { closeDatabase, getIngestionStatus, isDatabaseConfigured } from './database.js';
import { SOURCES } from './sourceList.js';
import { findRunningApp, formatReport, servedLoader, summarizeIngestion, summarizeSource } from './sourceCheck.js';

const TIMEOUT_MS = 90_000;

function withTimeout(promise, name) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${name} did not answer within ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

const json = process.argv.includes('--json');
const app = process.argv.includes('--in-process') ? null : await findRunningApp(`http://127.0.0.1:${config.port}`);
const mode = app
  ? `Reading what the running app serves at ${app.baseUrl}${app.commit ? ` (build ${app.commit})` : ''}: no extra provider calls.`
  : 'The app is not answering locally (or --in-process was given): calling each loader in this process.';
if (!json) process.stderr.write(`${mode}\n`);

const summaries = [];
try {
  // One at a time: several share upstreams (Yahoo, FRED) and a burst would
  // trip their rate limits, which would read as a source failure.
  for (const source of SOURCES) {
    const started = Date.now();
    const load = app && source.endpoint ? servedLoader(app.baseUrl, source.endpoint, { timeoutMs: TIMEOUT_MS }) : source.load;
    const [result] = await Promise.allSettled([withTimeout(Promise.resolve().then(load), source.name)]);
    summaries.push(summarizeSource(source, result, Date.now() - started));
    if (!json) process.stderr.write(`checked ${source.name}\n`);
  }
  const jobs = isDatabaseConfigured() ? await getIngestionStatus().catch(() => []) : [];
  const ingestion = summarizeIngestion({ enabled: config.ingestionEnabled, databaseConfigured: isDatabaseConfigured(), jobs });
  if (json) {
    console.log(JSON.stringify({ mode: app ? 'served' : 'in-process', sources: summaries, ingestion }, null, 2));
  } else {
    console.log(`${mode}\n`);
    console.log(formatReport(summaries));
    console.log(`\n${{ ok: 'OK  ', partial: 'PART', failed: 'FAIL' }[ingestion.verdict]}  Ingestion (stored history)`);
    for (const line of ingestion.lines) console.log(`      ${line}`);
  }
} finally {
  await closeDatabase();
}
// Background timers in the providers (cache refreshes) must not hold the process open.
process.exit(0);
