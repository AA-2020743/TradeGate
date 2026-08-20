import 'dotenv/config';

function numberFromEnvironment(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function booleanFromEnvironment(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true';
}

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 8787),
  twelveDataApiKey: process.env.TWELVE_DATA_API_KEY ?? '',
  twelveMinIntervalMs: numberFromEnvironment('TWELVE_MIN_INTERVAL_MS', 8_000),
  fredApiKey: process.env.FRED_API_KEY ?? '',
  databaseUrl: process.env.DATABASE_URL ?? '',
  databaseSsl: booleanFromEnvironment('DATABASE_SSL'),
  ingestionEnabled: booleanFromEnvironment('INGESTION_ENABLED'),
  marketRefreshMs: numberFromEnvironment('MARKET_REFRESH_MS', 60_000),
  macroRefreshMs: numberFromEnvironment('MACRO_REFRESH_MS', 6 * 60 * 60_000),
  historyRefreshMs: numberFromEnvironment('HISTORY_REFRESH_MS', 24 * 60 * 60_000),
};
