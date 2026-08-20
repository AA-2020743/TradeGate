import pg from 'pg';
import { config } from './config.js';
import { isDailyCloseStale, isFredSeriesStale } from './freshness.js';

const { Pool } = pg;
const pool = config.databaseUrl
  ? new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
  : null;

export function isDatabaseConfigured() {
  return Boolean(pool);
}

export async function getDatabaseHealth() {
  if (!pool) return { configured: false, connected: false, migrated: false, mode: 'not-configured', purpose: 'Time-series persistence and revision history' };
  try {
    const result = await pool.query(
      `SELECT
         to_regclass('public.observations') AS observations,
         to_regclass('public.schema_migrations') AS migrations`,
    );
    const latestMigration = result.rows[0].migrations
      ? await pool.query("SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '003_provider_credit_usage.sql') AS applied")
      : null;
    const migrated = Boolean(result.rows[0].observations && latestMigration?.rows[0].applied);
    return { configured: true, connected: true, migrated, mode: migrated ? 'postgresql' : 'migration-required', purpose: 'Time-series persistence and revision history' };
  } catch (error) {
    return { configured: true, connected: false, migrated: false, mode: 'unavailable', purpose: 'Time-series persistence and revision history', error: error.message };
  }
}

export async function closeDatabase() {
  if (pool) await pool.end();
}

export async function runQuery(text, parameters = []) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  return pool.query(text, parameters);
}

export async function withDatabaseClient(callback) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

export async function persistSeries(series, ingestionRunId = null) {
  if (!pool) return 0;
  const client = await pool.connect();
  let written = 0;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO data_series (
         id, provider, provider_series_id, name, asset_class, frequency, unit, currency, metadata, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         asset_class = EXCLUDED.asset_class,
         frequency = EXCLUDED.frequency,
         unit = EXCLUDED.unit,
         currency = EXCLUDED.currency,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [series.id, series.provider, series.providerSeriesId, series.name, series.assetClass, series.frequency ?? null, series.unit ?? null, series.currency ?? null, JSON.stringify(series.metadata ?? {})],
    );

    for (const observation of series.observations) {
      const result = await client.query(
        `INSERT INTO observations (series_id, observed_at, value, provider_as_of, metadata, ingestion_run_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (series_id, observed_at) DO UPDATE SET
           value = EXCLUDED.value,
           provider_as_of = EXCLUDED.provider_as_of,
           metadata = EXCLUDED.metadata,
           ingestion_run_id = EXCLUDED.ingestion_run_id,
           ingested_at = NOW()
         WHERE observations.value IS DISTINCT FROM EXCLUDED.value
            OR observations.provider_as_of IS DISTINCT FROM EXCLUDED.provider_as_of
            OR observations.metadata IS DISTINCT FROM EXCLUDED.metadata`,
        [series.id, observation.observedAt, observation.value, observation.providerAsOf ?? null, JSON.stringify(observation.metadata ?? {}), ingestionRunId],
      );
      written += result.rowCount;
    }
    await client.query('COMMIT');
    return written;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function startIngestionRun(jobName) {
  if (!pool) return null;
  const result = await pool.query(
    `INSERT INTO ingestion_runs (job_name, status) VALUES ($1, 'running') RETURNING id`,
    [jobName],
  );
  return result.rows[0].id;
}

export async function finishIngestionRun(id, status, observationsWritten, details = {}, errorMessage = null) {
  if (!pool || id === null) return;
  await pool.query(
    `UPDATE ingestion_runs
     SET status = $2, finished_at = NOW(), observations_written = $3, details = $4::jsonb, error_message = $5
     WHERE id = $1`,
    [id, status, observationsWritten, JSON.stringify(details), errorMessage],
  );
}

export async function persistModelOutput(modelId, model, inputLineage = [], ingestionRunId = null) {
  if (!pool || !model) return;
  await pool.query(
    `INSERT INTO model_outputs (model_id, version, calculated_at, effective_at, output, input_lineage, ingestion_run_id)
     VALUES ($1, $2, NOW(), $3, $4::jsonb, $5::jsonb, $6)`,
    [modelId, model.version, model.asOf, JSON.stringify(model), JSON.stringify(inputLineage), ingestionRunId],
  );
}

export async function getRecentModelOutputs(modelId, limit = 2) {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT version, effective_at, output FROM model_outputs
     WHERE model_id = $1
     ORDER BY effective_at DESC, id DESC
     LIMIT $2`,
    [modelId, limit],
  );
  return result.rows.map((row) => ({ version: row.version, effectiveAt: row.effective_at, output: row.output }));
}

export async function reserveProviderCredits(provider, credits, dailyLimit, interactiveLimit, usage, usageDate) {
  if (!pool) return { persisted: false, allowed: true };
  const interactiveCredits = usage === 'interactive' ? credits : 0;
  if (credits > dailyLimit || interactiveCredits > interactiveLimit) return { persisted: true, allowed: false };
  const result = await pool.query(
    `INSERT INTO provider_credit_usage (provider, usage_date, total_credits, interactive_credits)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, usage_date) DO UPDATE SET
       total_credits = provider_credit_usage.total_credits + EXCLUDED.total_credits,
       interactive_credits = provider_credit_usage.interactive_credits + EXCLUDED.interactive_credits,
       updated_at = NOW()
     WHERE provider_credit_usage.total_credits + EXCLUDED.total_credits <= $5
       AND provider_credit_usage.interactive_credits + EXCLUDED.interactive_credits <= $6
     RETURNING total_credits, interactive_credits`,
    [provider, usageDate, credits, interactiveCredits, dailyLimit, interactiveLimit],
  );
  return {
    persisted: true,
    allowed: result.rowCount === 1,
    totalCredits: result.rows[0]?.total_credits ?? null,
    interactiveCredits: result.rows[0]?.interactive_credits ?? null,
  };
}

export async function acquireIngestionLock(jobName) {
  if (!pool) return { acquired: false, release: async () => {} };
  const client = await pool.connect();
  const result = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [`tradegate:${jobName}`]);
  if (!result.rows[0].acquired) {
    client.release();
    return { acquired: false, release: async () => {} };
  }
  return {
    acquired: true,
    release: async () => {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`tradegate:${jobName}`]);
      } finally {
        client.release();
      }
    },
  };
}

export async function getIngestionStatus() {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT DISTINCT ON (job_name)
       job_name, status, started_at, finished_at, observations_written, details, error_message
     FROM ingestion_runs
     ORDER BY job_name, started_at DESC`,
  );
  return result.rows;
}

export async function hasIngestedMarketHistoriesSince(since, minimumTwelveSymbols) {
  if (!pool) return false;
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM ingestion_runs
       WHERE job_name = 'market-history'
         AND status IN ('completed', 'partial')
         AND finished_at >= $1
         AND COALESCE((details->>'twelveSymbolsReceived')::integer, 0) >= $2
     ) AS ingested`,
    [since, minimumTwelveSymbols],
  );
  return result.rows[0].ingested;
}

export async function getStoredMarketSnapshot() {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT DISTINCT ON (series.id)
       series.provider_series_id AS key,
       series.provider_series_id AS symbol,
       series.name,
       series.asset_class AS kind,
       series.provider,
       observations.value AS price,
       observations.observed_at,
       observations.metadata
     FROM data_series AS series
     JOIN observations ON observations.series_id = series.id
     WHERE series.id LIKE 'market:%:quote:usd'
     ORDER BY series.id, observations.observed_at DESC`,
  );
  return result.rows.map((row) => ({
    key: row.key,
    symbol: row.symbol,
    name: row.name,
    kind: row.kind,
    price: Number(row.price),
    changePercent: row.metadata?.changePercent ?? null,
    asOf: row.observed_at,
    source: `${row.provider} (stored)`,
    stored: true,
    stale: row.key === 'BTC' ? Date.now() - new Date(row.observed_at).getTime() > 5 * 60_000 : isDailyCloseStale(row.observed_at),
  }));
}

export async function getStoredFredSeries() {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT
       series.provider_series_id AS id,
       series.name,
       series.unit,
       series.metadata AS series_metadata,
       observations.observed_at,
       observations.value,
       observations.provider_as_of,
       observations.metadata AS observation_metadata
     FROM data_series AS series
     JOIN observations ON observations.series_id = series.id
     WHERE series.provider = 'FRED'
     ORDER BY series.provider_series_id, observations.observed_at ASC`,
  );
  const grouped = new Map();
  for (const row of result.rows) {
    if (!grouped.has(row.id)) {
      grouped.set(row.id, {
        id: row.id,
        key: row.series_metadata.key,
        name: row.name,
        unit: row.unit,
        multiplier: row.series_metadata.multiplier ?? 1,
        history: [],
        stored: true,
      });
    }
    grouped.get(row.id).history.push({
      date: row.observed_at.toISOString().slice(0, 10),
      value: Number(row.value),
      realtimeStart: row.provider_as_of?.toISOString().slice(0, 10) ?? null,
      realtimeEnd: row.observation_metadata?.realtimeEnd ?? null,
    });
  }
  return [...grouped.values()].map((series) => ({
    ...series,
    value: series.history.at(-1)?.value ?? null,
    date: series.history.at(-1)?.date ?? null,
    stale: isFredSeriesStale(series.id, series.history.at(-1)?.date),
  }));
}

const HISTORY_DAYS = {
  '1D': 1,
  '5D': 5,
  '1M': 31,
  '6M': 183,
  '1Y': 366,
};

export async function getStoredMarketHistory(symbol, range) {
  if (!pool || range === 'All' || range === '1D' || range === '5D') return [];
  const now = new Date();
  const start = range === 'YTD'
    ? new Date(Date.UTC(now.getUTCFullYear(), 0, 1))
    : new Date(now.getTime() - ((HISTORY_DAYS[range] ?? HISTORY_DAYS['1M']) * 86_400_000));
  const result = await pool.query(
    `SELECT observed_at, value
     FROM observations
     WHERE series_id = $1
       AND observed_at >= $2
     ORDER BY observed_at ASC`,
    [`market:${symbol}:close:usd`, start.toISOString()],
  );
  return result.rows.map((row) => ({ timestamp: row.observed_at.toISOString(), value: Number(row.value) }));
}

export async function getStoredSeriesCoverage(symbols) {
  if (!pool || !symbols.length) return [];
  const seriesIds = symbols.map((symbol) => `market:${symbol}:close:usd`);
  const result = await pool.query(
    `SELECT
       series.provider_series_id AS symbol,
       COUNT(observations.observed_at)::integer AS observations,
       MIN(observations.observed_at) AS starts_at,
       MAX(observations.observed_at) AS ends_at
     FROM data_series AS series
     JOIN observations ON observations.series_id = series.id
     WHERE series.id = ANY($1::text[])
     GROUP BY series.provider_series_id`,
    [seriesIds],
  );
  return result.rows.map((row) => ({
    symbol: row.symbol,
    observations: row.observations,
    startsAt: row.starts_at?.toISOString() ?? null,
    endsAt: row.ends_at?.toISOString() ?? null,
  }));
}

export async function getStoredMarketHistories(symbols, days = 400) {
  if (!pool || !symbols.length) return new Map();
  const seriesIds = symbols.map((symbol) => `market:${symbol}:close:usd`);
  const start = new Date(Date.now() - (days * 86_400_000)).toISOString();
  const result = await pool.query(
    `SELECT series.provider_series_id AS symbol, observations.observed_at, observations.value
     FROM data_series AS series
     JOIN observations ON observations.series_id = series.id
     WHERE series.id = ANY($1::text[])
       AND observations.observed_at >= $2
     ORDER BY series.provider_series_id, observations.observed_at ASC`,
    [seriesIds, start],
  );
  const histories = new Map(symbols.map((symbol) => [symbol, []]));
  for (const row of result.rows) {
    histories.get(row.symbol)?.push({ timestamp: row.observed_at.toISOString(), value: Number(row.value) });
  }
  return histories;
}
