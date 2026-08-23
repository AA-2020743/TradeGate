import 'dotenv/config';

function numberFromEnvironment(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumberFromEnvironment(name, fallback) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === '') return fallback;
  const value = Number(rawValue);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
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
  twelveMinuteCreditLimit: nonNegativeNumberFromEnvironment('TWELVE_MINUTE_CREDIT_LIMIT', 8),
  twelveDailyCreditLimit: nonNegativeNumberFromEnvironment('TWELVE_DAILY_CREDIT_LIMIT', 760),
  twelveInteractiveDailyLimit: nonNegativeNumberFromEnvironment('TWELVE_INTERACTIVE_DAILY_LIMIT', 140),
  twelveInteractiveLimitConfigured: process.env.TWELVE_INTERACTIVE_DAILY_LIMIT !== undefined,
  twelveMaxInteractiveWaitMs: nonNegativeNumberFromEnvironment('TWELVE_MAX_INTERACTIVE_WAIT_MS', 10_000),
  twelveQuoteRefreshMs: numberFromEnvironment('TWELVE_QUOTE_REFRESH_MS', 15 * 60_000),
  fredApiKey: process.env.FRED_API_KEY ?? '',
  cftcAppToken: process.env.CFTC_APP_TOKEN ?? '',
  coingeckoApiKey: process.env.COINGECKO_API_KEY ?? '',
  coingeckoPlan: (process.env.COINGECKO_API_PLAN ?? 'demo').toLowerCase() === 'pro' ? 'pro' : 'demo',
  databaseUrl: process.env.DATABASE_URL ?? '',
  databaseSsl: booleanFromEnvironment('DATABASE_SSL'),
  ingestionEnabled: booleanFromEnvironment('INGESTION_ENABLED'),
  marketRefreshMs: numberFromEnvironment('MARKET_REFRESH_MS', 15 * 60_000),
  macroRefreshMs: numberFromEnvironment('MACRO_REFRESH_MS', 6 * 60 * 60_000),
  historyRefreshMs: numberFromEnvironment('HISTORY_REFRESH_MS', 24 * 60 * 60_000),
  // Opt-in webhook for high-severity alert transitions. Off unless set.
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL ?? '',
  alertWebhookSeverities: (process.env.ALERT_WEBHOOK_SEVERITIES ?? 'high').split(',').map((entry) => entry.trim()).filter(Boolean),
  apiRateLimit: numberFromEnvironment('API_RATE_LIMIT', 120),
  // Writes are rarer and heavier than reads and share the same window.
  apiWriteRateLimit: numberFromEnvironment('API_WRITE_RATE_LIMIT', 20),
  apiRateWindowMs: numberFromEnvironment('API_RATE_WINDOW_MS', 60_000),
};
