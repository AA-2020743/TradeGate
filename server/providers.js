import { config } from './config.js';
import { withCache } from './cache.js';
import { settle, unwrap } from './settled.js';
import { calculateBreadthDivergence } from './equityAnalytics.js';
import { calculateBitcoinTechnicals, calculateMovingAverageStack } from './bitcoinTechnicals.js';
import { calculateRevisionBreadth, calculateThrustLog } from './equityAnalytics.js';
import { calculateBitcoinRangeModels } from './bitcoinOhlc.js';
import { buildCoingeckoRequest, buildHeatmapRow, buildSocrataRequest, buildLiquidityNarrative, buildLiquidityTransmission, buildWorkspaceNarrative, calculateBitcoinCyclePhase, calculateChangeCorrelations, calculateCryptoRotation, calculateDollarScenarios, calculateDollarTransmissionRead, calculateLeadLag, calculateLiquidityRunway, calculateOpenInterestQuadrant, calculatePositioningModel, calculateCrossMarketRelationship, calculateGlobalLiquidityModel, calculateHeatmapRisk, calculateMacroRegimeModel, calculateMetalsCostStructure, calculateRsi, calculateScreenerScores, calculateTechnicalSnapshot, calculateTrendQuality, classifyHeadlineSentiment, isPublished, calculateUsdStrengthModel, calculateUsLiquidityModel } from './analytics.js';
import { getStoredFredSeries, getStoredMarketHistory, getStoredMarketSnapshot, getRecentModelOutputs, isDatabaseConfigured, reserveProviderCredits } from './database.js';
import { getAllEquityHistorySymbols, getCoreEquityHistorySymbols } from './equityCatalog.js';
import { describeSeriesFreshness, isCryptoHistoryStale, isCotReportStale, isDailyCloseStale, isFredSeriesStale, isPbocObservationStale, monthsBetween } from './freshness.js';

const TWELVE_SYMBOLS = [
  { symbol: 'SPY', key: 'SPY', name: 'S&P 500 proxy', kind: 'ETF' },
  { symbol: 'QQQ', key: 'QQQ', name: 'Nasdaq 100 proxy', kind: 'ETF' },
  { symbol: 'GLD', key: 'GLD', name: 'Gold proxy', kind: 'ETF' },
  { symbol: 'DXY', key: 'DXY', name: 'U.S. Dollar Index', kind: 'Index' },
  { symbol: 'NVDA', key: 'NVDA', name: 'NVIDIA Corp.', kind: 'Equity' },
  { symbol: 'AAPL', key: 'AAPL', name: 'Apple Inc.', kind: 'Equity' },
];

const FRED_SERIES = [
  { id: 'WALCL', key: 'fedBalanceSheet', name: 'Fed balance sheet', unit: 'USD millions', multiplier: 1 },
  { id: 'WTREGEN', key: 'treasuryGeneralAccount', name: 'Treasury General Account', unit: 'USD millions', multiplier: 1 },
  { id: 'RRPONTSYD', key: 'reverseRepo', name: 'Overnight reverse repo', unit: 'USD billions', multiplier: 1000 },
  { id: 'M2SL', key: 'usM2', name: 'US M2', unit: 'USD billions', multiplier: 1000 },
  { id: 'DTWEXBGS', key: 'dxy', name: 'Broad dollar index', unit: 'Index', multiplier: 1 },
  { id: 'DGS2', key: 'us2yYield', name: '2-Year Treasury yield', unit: 'Percent', multiplier: 1 },
  { id: 'DFII10', key: 'realYield10y', name: '10-Year real Treasury yield', unit: 'Percent', multiplier: 1 },
  { id: 'NFCI', key: 'financialConditions', name: 'Chicago Fed financial conditions', unit: 'Index', multiplier: 1 },
  { id: 'BAMLH0A0HYM2', key: 'highYieldSpread', name: 'US high-yield option-adjusted spread', unit: 'Percent', multiplier: 1 },
  { id: 'VIXCLS', key: 'vix', name: 'CBOE VIX close', unit: 'Index', multiplier: 1 },
  { id: 'ECBASSETSW', key: 'ecbBalanceSheet', name: 'ECB balance sheet', unit: 'EUR millions', multiplier: 1 },
  { id: 'JPNASSETS', key: 'bojBalanceSheet', name: 'Bank of Japan total assets', unit: '100M yen', multiplier: 1 },
  { id: 'DEXUSEU', key: 'eurUsd', name: 'US dollars per euro', unit: 'USD per EUR', multiplier: 1 },
  { id: 'DEXJPUS', key: 'yenPerUsd', name: 'Yen per US dollar', unit: 'JPY per USD', multiplier: 1 },
  { id: 'DEXCHUS', key: 'yuanPerUsd', name: 'Yuan per US dollar', unit: 'CNY per USD', multiplier: 1 },
];

const PBOC_SERIES_CODE = 'M.CN.B.XDC.CNY.N';
const PBOC_SERIES_ID = 'BIS_WS_CBTA_CN';

async function getPbocAssets() {
  const url = new URL(`https://api.db.nomics.world/v22/series/BIS/WS_CBTA/${PBOC_SERIES_CODE}`);
  url.searchParams.set('observations', '1');
  const payload = await fetchJson(url);
  const doc = payload?.series?.docs?.[0];
  const periods = doc?.period ?? [];
  const values = doc?.value ?? [];
  if (!periods.length) throw new Error('DBnomics returned no observations for BIS WS_CBTA China');
  const history = periods
    .map((period, index) => ({ date: `${period}-01`, value: Number(values[index]), realtimeStart: null, realtimeEnd: null }))
    .filter((item) => Number.isFinite(item.value))
    .reverse();
  const observation = history[0];
  const value = observation?.value;
  if (!observation || !Number.isFinite(value)) throw new Error('DBnomics returned no usable observation for BIS WS_CBTA China');
  return {
    id: PBOC_SERIES_ID,
    key: 'pbocBalanceSheet',
    name: 'PBoC total assets',
    unit: 'CNY billions',
    multiplier: 1,
    provider: 'BIS',
    value,
    date: observation.date,
    stored: false,
    stale: isPbocObservationStale(observation.date),
    laggedMonths: monthsBetween(observation.date),
    history,
  };
}

let twelveLimiterQueue = Promise.resolve();
let twelveCreditReservations = [];
const inMemoryDailyUsage = new Map();

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchJson(url, attempt = 0, maxRetries = 2, extraHeaders = null) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'TradeGateResearch/0.1', ...(extraHeaders ?? {}) },
    signal: AbortSignal.timeout(12_000),
  });

  if (response.status === 429 && attempt < maxRetries) {
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
    await wait(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 30_000) : 5_000 * (attempt + 1));
    return fetchJson(url, attempt + 1, maxRetries, extraHeaders);
  }
  if (!response.ok) throw new Error(`Upstream request failed with ${response.status}`);
  return response.json();
}

async function fetchText(url, attempt = 0, maxRetries = 2, extraHeaders = null) {
  const response = await fetch(url, {
    headers: { Accept: 'text/html,text/csv,*/*', 'User-Agent': 'TradeGateResearch/0.1', ...(extraHeaders ?? {}) },
    signal: AbortSignal.timeout(12_000),
  });

  if (response.status === 429 && attempt < maxRetries) {
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
    await wait(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 30_000) : 5_000 * (attempt + 1));
    return fetchText(url, attempt + 1, maxRetries, extraHeaders);
  }
  if (!response.ok) throw new Error(`Upstream request failed with ${response.status}`);
  return response.text();
}

export function calculateTwelveCreditSlot(reservations, requestedAt, credits, limit) {
  let candidate = Math.max(requestedAt, reservations.at(-1)?.at ?? requestedAt);
  while (true) {
    const active = reservations.filter((reservation) => reservation.at > candidate - 60_000 && reservation.at <= candidate);
    const used = active.reduce((total, reservation) => total + reservation.credits, 0);
    if (used + credits <= limit) return candidate;
    candidate = Math.min(...active.map((reservation) => reservation.at)) + 60_000;
  }
}

async function reserveTwelveDailyCredits(credits, usage, usageDate) {
  const scheduledReserveEnabled = config.ingestionEnabled && isDatabaseConfigured();
  const interactiveLimit = scheduledReserveEnabled || config.twelveInteractiveLimitConfigured
    ? Math.min(config.twelveInteractiveDailyLimit, config.twelveDailyCreditLimit)
    : config.twelveDailyCreditLimit;
  const persistent = await reserveProviderCredits('twelve-data', credits, config.twelveDailyCreditLimit, interactiveLimit, usage, usageDate);
  if (persistent.persisted) return persistent.allowed;

  const current = inMemoryDailyUsage.get(usageDate) ?? { total: 0, interactive: 0 };
  const nextTotal = current.total + credits;
  const nextInteractive = current.interactive + (usage === 'interactive' ? credits : 0);
  if (nextTotal > config.twelveDailyCreditLimit || nextInteractive > interactiveLimit) return false;
  inMemoryDailyUsage.set(usageDate, { total: nextTotal, interactive: nextInteractive });
  return true;
}

function acquireTwelveCredits(credits, usage) {
  const requestedCredits = Math.max(1, Math.ceil(credits));
  const requestedUsage = usage === 'scheduled' ? 'scheduled' : 'interactive';
  const reservation = twelveLimiterQueue.then(async () => {
    if (requestedCredits > config.twelveMinuteCreditLimit) throw new Error('Twelve Data request exceeds the configured per-minute credit limit');
    const now = Date.now();
    twelveCreditReservations = twelveCreditReservations.filter((item) => item.at > now - 60_000);
    const slot = calculateTwelveCreditSlot(twelveCreditReservations, now, requestedCredits, config.twelveMinuteCreditLimit);
    const waitFor = Math.max(0, slot - now);
    if (requestedUsage === 'interactive' && waitFor > config.twelveMaxInteractiveWaitMs) {
      throw new Error('Twelve Data rate capacity is temporarily unavailable');
    }
    const usageDate = new Date(slot).toISOString().slice(0, 10);
    if (!await reserveTwelveDailyCredits(requestedCredits, requestedUsage, usageDate)) {
      throw new Error(`Twelve Data ${requestedUsage} daily credit budget is exhausted`);
    }
    const executionSlot = calculateTwelveCreditSlot(twelveCreditReservations, Math.max(slot, Date.now()), requestedCredits, config.twelveMinuteCreditLimit);
    if (new Date(executionSlot).toISOString().slice(0, 10) !== usageDate) {
      throw new Error('Twelve Data request crossed the UTC credit boundary; retry the request');
    }
    const entry = { at: executionSlot, credits: requestedCredits };
    twelveCreditReservations.push(entry);
    return executionSlot;
  });
  twelveLimiterQueue = reservation.catch(() => undefined);
  return reservation;
}

async function fetchTwelveJson(url, options = {}) {
  const usage = options.usage === 'scheduled' ? 'scheduled' : 'interactive';
  const slot = await acquireTwelveCredits(options.credits ?? 1, usage);
  const waitFor = Math.max(0, slot - Date.now());
  if (waitFor) await wait(waitFor);
  return fetchJson(url, 0, 0);
}

const HISTORY_RANGES = {
  '1D': { days: '1', interval: '5min', outputsize: '78' },
  '5D': { days: '5', interval: '30min', outputsize: '80' },
  '1M': { days: '30', interval: '1day', outputsize: '31' },
  '6M': { days: '180', interval: '1day', outputsize: '180' },
  YTD: { days: '365', interval: '1day', outputsize: '260' },
  '1Y': { days: '365', interval: '1day', outputsize: '365' },
  All: { days: 'max', interval: '1week', outputsize: '520' },
};

const HISTORY_SYMBOLS = new Set(['BTC', 'NVDA', 'AAPL', ...TWELVE_SYMBOLS.map((asset) => asset.symbol), ...getAllEquityHistorySymbols()]);
const INGESTION_HISTORY_SYMBOLS = new Set(['BTC', ...TWELVE_SYMBOLS.map((asset) => asset.symbol), ...getCoreEquityHistorySymbols()]);

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTimestamp(value) {
  if (!value) return null;
  if (/^\d+$/.test(String(value))) return new Date(Number(value) * 1000).toISOString();
  const text = String(value);
  const hasTimeZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(text);
  const normalized = text.includes('T') ? text : text.includes(' ') ? text.replace(' ', 'T') : `${text}T00:00:00`;
  const timestamp = new Date(hasTimeZone ? normalized : `${normalized}Z`);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function filterHistoryRange(points, range) {
  if (range !== 'YTD') return points;
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), 0, 1);
  return points.filter((point) => new Date(point.timestamp).getTime() >= start);
}

function parseTwelveQuote(payload, symbol) {
  const quote = payload[symbol] ?? payload.data?.[symbol] ?? payload.data?.find?.((item) => item.symbol === symbol);
  if (!quote || quote.code) return null;

  const price = asNumber(quote.close ?? quote.price);
  const changePercent = asNumber(quote.percent_change ?? quote.change_percent);
  if (price === null) return null;

  return { price, changePercent, asOf: normalizeTimestamp(quote.datetime ?? quote.timestamp) };
}

async function getBitcoin() {
  const priceRequest = coingecko('/simple/price', { ids: 'bitcoin', vs_currencies: 'usd', include_24hr_change: 'true', include_last_updated_at: 'true' });
  const payload = await fetchJson(priceRequest.url, 0, 2, priceRequest.headers);
  const bitcoin = payload.bitcoin;
  if (!bitcoin?.usd) throw new Error('CoinGecko did not return a Bitcoin quote');

  const asOf = bitcoin.last_updated_at ? new Date(bitcoin.last_updated_at * 1000).toISOString() : null;
  return {
    key: 'BTC',
    symbol: 'BTC',
    name: 'Bitcoin',
    kind: 'Crypto',
    price: bitcoin.usd,
    changePercent: bitcoin.usd_24h_change ?? null,
    asOf,
    source: 'CoinGecko',
    stale: !asOf || Date.now() - new Date(asOf).getTime() > 5 * 60_000,
  };
}

async function getTwelveQuotes(options = {}) {
  if (!config.twelveDataApiKey) return { assets: [], errors: [] };

  const symbols = TWELVE_SYMBOLS.map((asset) => asset.symbol).join(',');
  const url = new URL('https://api.twelvedata.com/quote');
  url.searchParams.set('symbol', symbols);
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('apikey', config.twelveDataApiKey);
  const payload = await fetchTwelveJson(url, { credits: TWELVE_SYMBOLS.length, usage: options.usage });
  if (payload.status === 'error' || payload.code) throw new Error(payload.message ?? 'Twelve Data quote request failed');

  const assets = [];
  const errors = [];
  for (const asset of TWELVE_SYMBOLS) {
    const rawQuote = payload[asset.symbol] ?? payload.data?.[asset.symbol];
    if (rawQuote?.status === 'error' || rawQuote?.code) {
      errors.push({ provider: 'Twelve Data', symbol: asset.symbol, message: rawQuote.message ?? 'Quote unavailable' });
      continue;
    }
    const quote = parseTwelveQuote(payload, asset.symbol);
    if (quote) {
      const stale = isDailyCloseStale(quote.asOf);
      assets.push({ ...asset, ...quote, source: 'Twelve Data', stale });
      if (stale) errors.push({ provider: 'Twelve Data', symbol: asset.symbol, message: 'Quote timestamp is stale' });
    }
    else errors.push({ provider: 'Twelve Data', symbol: asset.symbol, message: 'Quote missing from provider response' });
  }

  return { assets, errors };
}

export function mergeMarketSnapshot(previous, next) {
  if (!next.errors.length) return next;
  const currentKeys = new Set(next.assets.filter((asset) => !asset.stale).map((asset) => asset.key));
  const cachedFallbacks = (previous.assets ?? []).filter((asset) => {
    if (currentKeys.has(asset.key)) return false;
    const providerFailed = next.errors.some((error) => error.symbol ? error.symbol === asset.symbol : asset.source?.includes(error.provider));
    if (!providerFailed) return false;
    const current = next.assets.find((candidate) => candidate.key === asset.key);
    if (!current) return true;
    const previousTime = new Date(asset.asOf).getTime();
    const currentTime = new Date(current.asOf).getTime();
    return !asset.stale || !Number.isFinite(currentTime) || Number.isFinite(previousTime) && previousTime >= currentTime;
  }).map((asset) => ({
    ...asset,
    cached: true,
    stale: true,
    source: asset.cached ? asset.source : `${asset.source} (cached last known good)`,
  }));
  if (!cachedFallbacks.length) return next;
  const fallbackKeys = new Set(cachedFallbacks.map((asset) => asset.key));
  const assets = [...next.assets.filter((asset) => !fallbackKeys.has(asset.key)), ...cachedFallbacks];
  const sourceTimes = assets.map((asset) => new Date(asset.asOf).getTime()).filter(Number.isFinite);
  return { ...next, assets, asOf: sourceTimes.length ? new Date(Math.max(...sourceTimes)).toISOString() : null };
}

export function mergeFredSeries(liveSeries, storedSeries) {
  const seriesByKey = new Map(storedSeries.map((series) => [series.key, series]));
  for (const live of liveSeries) {
    const stored = seriesByKey.get(live.key);
    const liveTime = new Date(`${live.date}T00:00:00.000Z`).getTime();
    const storedTime = new Date(`${stored?.date}T00:00:00.000Z`).getTime();
    if (!live.stale || !stored || (stored.stale && (!Number.isFinite(storedTime) || liveTime >= storedTime))) seriesByKey.set(live.key, live);
  }
  const allowedDefinitions = [...FRED_SERIES, { id: PBOC_SERIES_ID, key: 'pbocBalanceSheet', name: 'PBoC total assets', unit: 'CNY billions', multiplier: 1 }];
  return allowedDefinitions.flatMap((definition) => seriesByKey.has(definition.key) ? [seriesByKey.get(definition.key)] : []);
}

export async function getMarketSnapshot(options = {}) {
  return withCache('market-snapshot', config.twelveQuoteRefreshMs, async () => {
    const results = await Promise.allSettled([getBitcoin(), getTwelveQuotes(options)]);
    const assets = [];
    const errors = [];

    if (results[0].status === 'fulfilled') {
      assets.push(results[0].value);
      if (results[0].value.stale) errors.push({ provider: 'CoinGecko', symbol: 'BTC', message: 'Quote timestamp is stale' });
    }
    else errors.push({ provider: 'CoinGecko', message: results[0].reason.message });

    if (results[1].status === 'fulfilled') {
      assets.push(...results[1].value.assets);
      errors.push(...results[1].value.errors);
    }
    else errors.push({ provider: 'Twelve Data', message: results[1].reason.message });

    const storedAssets = await getStoredMarketSnapshot().catch(() => []);
    for (const storedAsset of storedAssets) {
      const liveIndex = assets.findIndex((asset) => asset.key === storedAsset.key);
      if (liveIndex === -1) assets.push(storedAsset);
      else if (assets[liveIndex].stale && !storedAsset.stale) assets[liveIndex] = storedAsset;
    }

    const sourceTimes = assets.map((asset) => new Date(asset.asOf).getTime()).filter(Number.isFinite);
    return {
      generatedAt: new Date().toISOString(),
      asOf: sourceTimes.length ? new Date(Math.max(...sourceTimes)).toISOString() : null,
      assets,
      errors,
      providers: {
        coingecko: { configured: true, mode: config.coingeckoApiKey ? `credentialed-${config.coingeckoPlan}` : 'public' },
        twelveData: { configured: Boolean(config.twelveDataApiKey), mode: config.twelveDataApiKey ? 'credentialed' : 'not-configured' },
      },
    };
  }, { force: options.refresh === true, merge: mergeMarketSnapshot });
}

async function getBitcoinHistory(range) {
  const settings = HISTORY_RANGES[range];
  const historyRequest = coingecko('/coins/bitcoin/market_chart', { vs_currency: 'usd', days: settings.days });
  const payload = await fetchJson(historyRequest.url, 0, 2, historyRequest.headers);

  return (payload.prices ?? []).map(([timestamp, price]) => ({
    timestamp: new Date(timestamp).toISOString(),
    value: price,
  }));
}

async function getTwelveHistory(symbol, range, usage) {
  if (!config.twelveDataApiKey) return [];

  const settings = HISTORY_RANGES[range];
  const url = new URL('https://api.twelvedata.com/time_series');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', settings.interval);
  url.searchParams.set('outputsize', settings.outputsize);
  url.searchParams.set('order', 'ASC');
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('apikey', config.twelveDataApiKey);
  const payload = await fetchTwelveJson(url, { usage });

  if (payload.status === 'error') throw new Error(payload.message ?? 'Twelve Data history request failed');
  return (payload.values ?? []).flatMap((item) => {
    const value = asNumber(item.close);
    const isoTimestamp = item.datetime.includes(' ')
      ? `${item.datetime.replace(' ', 'T')}Z`
      : `${item.datetime}T00:00:00Z`;
    return value === null ? [] : [{ timestamp: new Date(isoTimestamp).toISOString(), value }];
  });
}

async function getYahooHistory(symbol, yahooRange = '1y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(yahooRange)}&interval=1d`;
  const payload = await fetchJson(url);
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  return timestamps.flatMap((seconds, index) => {
    const rawClose = closes[index];
    if (rawClose === null || rawClose === undefined) return [];
    const value = asNumber(rawClose);
    if (value === null || !Number.isFinite(seconds)) return [];
    return [{ timestamp: new Date(seconds * 1000).toISOString(), value }];
  });
}

/**
 * The same Yahoo chart endpoint the close-only loader uses, but keeping the
 * high, low and volume it already returns. A bar missing any of open, high,
 * low or close is dropped rather than back-filled, because the range models
 * downstream are only as honest as their worst bar.
 */
async function getYahooOhlcHistory(symbol, yahooRange = '2y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(yahooRange)}&interval=1d`;
  const payload = await fetchJson(url);
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0] ?? {};
  return timestamps.flatMap((seconds, index) => {
    if (!Number.isFinite(seconds)) return [];
    const open = asNumber(quote.open?.[index]);
    const high = asNumber(quote.high?.[index]);
    const low = asNumber(quote.low?.[index]);
    const close = asNumber(quote.close?.[index]);
    if ([open, high, low, close].some((value) => value === null)) return [];
    return [{
      date: new Date(seconds * 1000).toISOString().slice(0, 10),
      open,
      high,
      low,
      close,
      volume: asNumber(quote.volume?.[index]),
    }];
  });
}

export function getSupportedHistorySymbols() {
  return [...HISTORY_SYMBOLS];
}

export function getIngestionHistorySymbols() {
  return [...INGESTION_HISTORY_SYMBOLS];
}

/**
 * A multi-year daily close history, for models that rank today against their
 * own past rather than describing the last few months. `getMarketHistory` tops
 * out at a year, and a drawdown ranked against one year of sessions is barely
 * ranked at all.
 */
export async function getEquityLongHistory(symbol, { years = 5 } = {}) {
  const normalizedSymbol = symbol.toUpperCase();
  return withCache(`history-long:${normalizedSymbol}:${years}`, 6 * 60 * 60_000, async () => {
    const points = await getYahooHistory(normalizedSymbol, `${years}y`);
    return { symbol: normalizedSymbol, years, source: 'Yahoo Finance', asOf: points.at(-1)?.timestamp ?? null, points };
  });
}

export async function getMarketHistory(symbol, requestedRange, options = {}) {
  const normalizedSymbol = symbol.toUpperCase();
  const range = HISTORY_RANGES[requestedRange] ? requestedRange : '1M';
  if (!HISTORY_SYMBOLS.has(normalizedSymbol)) throw new Error(`Unsupported history symbol: ${normalizedSymbol}`);

  const cacheMode = options.preferStored === false ? 'provider' : 'default';
  const historyIsStale = (timestamp) => normalizedSymbol === 'BTC' ? isCryptoHistoryStale(timestamp) : isDailyCloseStale(timestamp);
  return withCache(`history:${normalizedSymbol}:${range}:${cacheMode}`, 60_000, async () => {
    let storedPoints = [];
    if (options.preferStored !== false) {
      storedPoints = await getStoredMarketHistory(normalizedSymbol, range).catch(() => []);
      const latestStoredTime = new Date(storedPoints.at(-1)?.timestamp).getTime();
      const storedHistoryIsFresh = Number.isFinite(latestStoredTime) && !historyIsStale(latestStoredTime);
      if (storedPoints.length >= 2 && storedHistoryIsFresh) {
        return {
          symbol: normalizedSymbol,
          range,
          asOf: storedPoints.at(-1).timestamp,
          source: 'PostgreSQL (stored provider history)',
          configured: true,
          stored: true,
          points: storedPoints,
        };
      }
    }

    let points;
    let providerError = null;
    let sourceLabel = normalizedSymbol === 'BTC' ? 'CoinGecko' : config.twelveDataApiKey ? 'Twelve Data' : 'Yahoo Finance';
    try {
      if (normalizedSymbol === 'BTC') {
        points = await getBitcoinHistory(range);
      } else {
        try {
          points = await getTwelveHistory(normalizedSymbol, range, options.usage);
        } catch (twelveError) {
          if (options.preferStored === false && config.twelveDataApiKey) throw twelveError;
          points = [];
        }
        if (!points.length) {
          points = await getYahooHistory(normalizedSymbol);
          sourceLabel = 'Yahoo Finance';
        }
      }
      points = filterHistoryRange(points, range);
    } catch (error) {
      if (options.preferStored === false) throw error;
      providerError = error;
      points = storedPoints.length ? storedPoints : await getStoredMarketHistory(normalizedSymbol, range).catch(() => []);
    }

    if (!points.length && providerError) throw providerError;

    const asOf = points.at(-1)?.timestamp ?? null;
    const stale = Boolean(providerError) || Boolean(points.length && historyIsStale(asOf));
    return {
      symbol: normalizedSymbol,
      range,
      asOf,
      source: providerError ? 'PostgreSQL (last known good)' : sourceLabel,
      configured: normalizedSymbol === 'BTC' || Boolean(config.twelveDataApiKey) || sourceLabel === 'Yahoo Finance',
      stored: Boolean(providerError),
      stale,
      points,
    };
  });
}

const HEATMAP_UNIVERSE = [
  { symbol: 'BTC', name: 'Bitcoin', group: 'Crypto' },
  { symbol: 'SPY', name: 'S&P 500', group: 'US indices' },
  { symbol: 'QQQ', name: 'Nasdaq 100', group: 'US indices' },
  { symbol: 'DIA', name: 'Dow Jones', group: 'US indices' },
  { symbol: 'IWM', name: 'Russell 2000', group: 'US indices' },
  { symbol: 'FEZ', name: 'Euro Stoxx 50', group: 'Europe' },
  { symbol: 'EWG', name: 'Germany', group: 'Europe' },
  { symbol: 'EWU', name: 'United Kingdom', group: 'Europe' },
  { symbol: 'EWQ', name: 'France', group: 'Europe' },
  { symbol: 'EWJ', name: 'Japan', group: 'Japan' },
  { symbol: 'ASHR', name: 'China A-shares', group: 'China' },
  { symbol: 'EWH', name: 'Hong Kong', group: 'China' },
  { symbol: 'KWEB', name: 'China Internet', group: 'China' },
  { symbol: 'EWZ', name: 'Brazil', group: 'LatAm' },
  { symbol: 'EWW', name: 'Mexico', group: 'LatAm' },
  { symbol: 'EEM', name: 'Emerging Markets', group: 'EM' },
  { symbol: 'GLD', name: 'Gold', group: 'Metals' },
  { symbol: 'SLV', name: 'Silver', group: 'Metals' },
  { symbol: 'GDX', name: 'Gold Miners', group: 'Metals' },
];
const HEATMAP_CROWDING_KEYS = { SPY: 'sp500', QQQ: 'nasdaq100', GLD: 'gold', SLV: 'gold', GDX: 'gold' };

export async function getMarketHeatmap() {
  return withCache('analytics:market-heatmap', 15 * 60_000, async () => {
    const [positioningResult, liquidityResult] = await Promise.allSettled([getMarketPositioning(), getLiquiditySnapshot()]);
    const positioning = positioningResult.status === 'fulfilled' ? positioningResult.value.model : null;
    const globalLiquidityRaw = liquidityResult.status === 'fulfilled' ? liquidityResult.value.globalLiquidity : null;
    const globalLiquidity = isPublished(globalLiquidityRaw) ? globalLiquidityRaw : null;
    const toPoints = (points) => (points ?? []).filter((point) => Number.isFinite(point.value)).map((point) => ({ timestamp: point.timestamp ?? `${point.date}T00:00:00.000Z`, value: point.value }));
    const spyHistory = await getMarketHistory('SPY', '1Y').catch(() => null);
    const spyPoints = toPoints(spyHistory?.stale ? [] : spyHistory?.points);
    const results = await Promise.allSettled(HEATMAP_UNIVERSE.map(async (entry) => {
      const history = await getMarketHistory(entry.symbol, '1Y');
      const points = history.stale ? [] : toPoints(history.points);
      const technical = calculateTechnicalSnapshot(points, { annualizationDays: entry.symbol === 'BTC' ? 365 : 252 });
      const alignment = entry.symbol === 'SPY' ? 1 : calculateChangeCorrelations(spyPoints, points)?.correlations?.['60D'] ?? null;
      const crowdContract = positioning?.contracts?.find((contract) => contract.key === HEATMAP_CROWDING_KEYS[entry.symbol]);
      return buildHeatmapRow({ symbol: entry.symbol, name: entry.name, group: entry.group, technical, alignment, crowdingPercentile: crowdContract?.percentile ?? null });
    }));
    const assets = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const calculated = assets.filter((asset) => asset.status === 'calculated');
    return {
      asOf: new Date().toISOString(),
      version: 'market-heatmap-v1',
      status: calculated.length ? 'calculated' : 'unavailable',
      calculatedCount: calculated.length,
      universeSize: HEATMAP_UNIVERSE.length,
      liquidityBackdrop: globalLiquidity ? { score: globalLiquidity.score, regime: globalLiquidity.regime } : null,
      risk: calculateHeatmapRisk(assets),
      assets,
      methodology: 'Scores from technical-v1 on stored close histories; alignment is the 60-day change correlation versus SPY; crowding uses CFTC COT three-year percentile where a matching contract exists; volatility is 20-day annualized realized volatility.',
    };
  });
}

const METALS_SPOT = [
  { symbol: 'XAU', name: 'Gold', yahooSymbol: 'GC=F' },
  { symbol: 'XAG', name: 'Silver', yahooSymbol: 'SI=F' },
  { symbol: 'XPT', name: 'Platinum', yahooSymbol: 'PL=F' },
  { symbol: 'XPD', name: 'Palladium', yahooSymbol: 'PA=F' },
];
const METALS_MINERS = [
  { symbol: 'GDX', name: 'Gold Miners' },
  { symbol: 'GDXJ', name: 'Junior Gold Miners' },
  { symbol: 'SIL', name: 'Silver Miners' },
  { symbol: 'SILJ', name: 'Junior Silver Miners' },
];

function summarizeMetalHistory(name, points) {
  const technical = calculateTechnicalSnapshot(points, { annualizationDays: 252 });
  if (!technical) return null;
  const latest = points.at(-1)?.value ?? null;
  const prior = points.length > 20 ? points[points.length - 21]?.value : null;
  const change20d = Number.isFinite(latest) && Number.isFinite(prior) && prior !== 0 ? Number(((latest / prior - 1) * 100).toFixed(2)) : null;
  return {
    name,
    price: Number.isFinite(latest) ? Number(latest.toFixed(2)) : null,
    change20d,
    score: technical.score,
    regime: technical.regime,
    momentum20d: technical.indicators.momentum20d,
    rsi14: technical.indicators.rsi14,
    sma50: technical.indicators.sma50,
    sma200: technical.indicators.sma200,
    annualizedVolatility: technical.indicators.annualizedVolatility20d,
    asOf: technical.asOf,
    observations: technical.observations,
    sparkline: points.slice(-40).map((point) => Number(point.value.toFixed(2))),
  };
}

const COT_DISAGGREGATED_DATASET = '72hh-3qpy';

async function getCotDisaggregatedGold() {
  const request = cftcRequest(COT_DISAGGREGATED_DATASET, {
    $select: 'report_date_as_yyyy_mm_dd,m_money_positions_long_all,m_money_positions_short_all,prod_merc_positions_long,prod_merc_positions_short,swap_positions_long_all,swap__positions_short_all',
    $where: "cftc_contract_market_code='088691'",
    $order: 'report_date_as_yyyy_mm_dd DESC',
    $limit: '160',
  });
  const rows = await fetchJson(request.url, 0, 2, request.headers);
  const history = (Array.isArray(rows) ? rows : []).map((row) => {
    const long = asNumber(row.m_money_positions_long_all);
    const short = asNumber(row.m_money_positions_short_all);
    const prodLong = asNumber(row.prod_merc_positions_long);
    const prodShort = asNumber(row.prod_merc_positions_short);
    const swapLong = asNumber(row.swap_positions_long_all);
    const swapShort = asNumber(row.swap__positions_short_all);
    return {
      date: String(row.report_date_as_yyyy_mm_dd ?? '').slice(0, 10),
      managedMoneyNet: Number.isFinite(long) && Number.isFinite(short) ? long - short : null,
      producerNet: Number.isFinite(prodLong) && Number.isFinite(prodShort) ? prodLong - prodShort : null,
      swapNet: Number.isFinite(swapLong) && Number.isFinite(swapShort) ? swapLong - swapShort : null,
    };
  }).filter((row) => row.date && Number.isFinite(row.managedMoneyNet));
  if (!history.length) throw new Error('CFTC disaggregated report returned no usable gold rows');
  const buildLeg = (field) => {
    const series = history.map((row) => row[field]);
    const latest = series[0];
    const weekAgo = series[1];
    return {
      net: latest,
      weeklyChange: Number.isFinite(weekAgo) ? latest - weekAgo : null,
      percentile: percentileOf(series, latest),
    };
  };
  return {
    asOf: history[0].date,
    stale: isCotReportStale(history[0].date),
    managedMoney: buildLeg('managedMoneyNet'),
    producers: buildLeg('producerNet'),
    swapDealers: buildLeg('swapNet'),
  };
}

const CNN_FEAR_GREED_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://edition.cnn.com/markets/fear-and-greed',
};

export async function getSentimentSnapshot() {
  return withCache('analytics:sentiment-snapshot', 30 * 60_000, async () => {
    const payload = await fetchJson('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', 0, 2, CNN_FEAR_GREED_HEADERS);
    const current = payload?.fear_and_greed;
    const score = asNumber(current?.score);
    if (!Number.isFinite(score)) throw new Error('CNN Fear & Greed payload missing current score');
    const historical = Array.isArray(payload?.fear_and_greed_historical) ? payload.fear_and_greed_historical : [];
    const historicalScores = historical.map((entry) => asNumber(entry?.y)).filter((value) => Number.isFinite(value));
    const oneYearAgoCutoff = Date.now() - 365 * 86_400_000;
    const yearScores = historicalScores.filter((value, index) => Number(historical[index]?.x ?? 0) >= oneYearAgoCutoff);
    const pool = yearScores.length > 60 ? yearScores : historicalScores;
    const ratingLabel = typeof current?.rating === 'string' ? current.rating : score >= 75 ? 'Extreme Greed' : score >= 55 ? 'Greed' : score > 45 ? 'Neutral' : score > 25 ? 'Fear' : 'Extreme Fear';
    return {
      asOf: new Date().toISOString(),
      version: 'sentiment-snapshot-v1',
      status: 'calculated',
      fearGreed: {
        score: Math.round(score * 10) / 10,
        rating: ratingLabel,
        previousClose: asNumber(current?.previous_close),
        oneWeekAgo: asNumber(current?.previous_1_week),
        oneMonthAgo: asNumber(current?.previous_1_month),
        oneYearAgo: asNumber(current?.previous_1_year),
        percentile1y: pool.length > 30 ? percentileOf(pool, score) : null,
        observations: pool.length,
      },
      methodology: 'CNN Fear & Greed composite (unofficial JSON endpoint; seven equity-sentiment inputs). Percentile ranks the current reading within the trailing-year published history.',
    };
  });
}

export function smaOf(values, window) {
  if (!Array.isArray(values) || values.length < window) return null;
  const slice = values.slice(-window);
  return slice.reduce((sum, value) => sum + value, 0) / window;
}

export function percentileOf(values, value) {
  if (!Array.isArray(values) || !values.length || !Number.isFinite(value)) return null;
  return Math.round((values.filter((item) => item <= value).length / values.length) * 100);
}

async function getBinanceFundingLeg() {
  const [current, bybit, history] = await Promise.all([
    fetchJson('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT'),
    fetchJson('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT'),
    fetchJson('https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1000'),
  ]);
  const binanceRate = asNumber(current?.lastFundingRate);
  const bybitRate = asNumber(bybit?.result?.list?.[0]?.fundingRate);
  const rates = [binanceRate, bybitRate].filter((value) => Number.isFinite(value));
  if (!rates.length) throw new Error('No funding-rate venue responded');
  const aggregate = rates.reduce((sum, value) => sum + value, 0) / rates.length;
  const historicalRates = (Array.isArray(history) ? history : []).map((row) => asNumber(row?.fundingRate)).filter((value) => Number.isFinite(value));
  return {
    binanceRate,
    bybitRate,
    venues: rates.length,
    aggregate8h: aggregate,
    annualizedPercent: Math.round(aggregate * 3 * 365 * 10000) / 100,
    percentile: historicalRates.length > 60 ? percentileOf(historicalRates, aggregate) : null,
    observations: historicalRates.length,
    windowDays: Math.round(historicalRates.length / 3),
  };
}

async function getBinancePositioningLeg() {
  const rows = await fetchJson('https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=1d&limit=30');
  if (!Array.isArray(rows) || rows.length < 9) throw new Error('Binance open-interest history unavailable');
  const quadrant = calculateOpenInterestQuadrant(rows.map((row) => ({
    openInterest: asNumber(row.sumOpenInterest),
    openInterestValue: asNumber(row.sumOpenInterestValue),
  })));
  if (quadrant.status !== 'calculated') throw new Error(quadrant.reason);
  return quadrant;
}

let bitcoinOnchainMemo = null;
let bitcoinDerivativesMemo = null;

export function parseRssItems(xml, source) {
  const items = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  for (const block of blocks.slice(0, 15)) {
    const extract = (tag) => {
      const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      if (!match) return null;
      return match[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim();
    };
    const title = extract('title');
    const link = extract('link');
    const pubDate = extract('pubDate');
    if (!title) continue;
    const timestamp = pubDate ? new Date(pubDate).getTime() : null;
    items.push({ source, title, link, publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null });
  }
  return items;
}

export async function getNewsWire() {
  return withCache('analytics:news-wire', 15 * 60_000, async () => {
    const feeds = [
      { url: 'https://www.federalreserve.gov/feeds/press_all.xml', source: 'Federal Reserve' },
      { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', source: 'CNBC' },
      { url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', source: 'MarketWatch' },
    ];
    const settled = await Promise.allSettled(feeds.map((feed) => fetchText(feed.url).then((xml) => parseRssItems(xml, feed.source))));
    const items = [];
    const sources = [];
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        items.push(...result.value);
        sources.push(feeds[index].source);
      }
    });
    const dated = items.filter((item) => item.publishedAt !== null).sort((left, right) => new Date(right.publishedAt) - new Date(left.publishedAt));
    const tagged = dated.map((item) => ({ ...item, ...classifyHeadlineSentiment(item.title) }));
    const toneCounts = {
      positive: tagged.filter((item) => item.tone === 'positive').length,
      negative: tagged.filter((item) => item.tone === 'negative').length,
      neutral: tagged.filter((item) => item.tone === 'neutral').length,
    };
    return {
      asOf: new Date().toISOString(),
      version: 'news-wire-v1',
      status: dated.length ? 'calculated' : 'unavailable',
      calculatedCount: dated.length,
      sources,
      items: tagged.slice(0, 14),
      toneCounts,
      methodology: 'Aggregated official and outlet RSS wires: Federal Reserve press releases, CNBC top news, and MarketWatch top stories, sorted by publish time. Each headline is keyword-classified as positive, negative, or neutral by a transparent lexicon; unmatched headlines stay neutral.',
    };
  });
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json, text/html, */*',
};

const SECTOR_SPDRS = [
  { symbol: 'XLK', name: 'Technology' },
  { symbol: 'XLC', name: 'Communication Services' },
  { symbol: 'XLY', name: 'Consumer Discretionary' },
  { symbol: 'XLP', name: 'Consumer Staples' },
  { symbol: 'XLE', name: 'Energy' },
  { symbol: 'XLF', name: 'Financials' },
  { symbol: 'XLV', name: 'Health Care' },
  { symbol: 'XLI', name: 'Industrials' },
  { symbol: 'XLB', name: 'Materials' },
  { symbol: 'XLRE', name: 'Real Estate' },
  { symbol: 'XLU', name: 'Utilities' },
];

const GICS_SECTORS = ['Information Technology', 'Health Care', 'Financials', 'Consumer Discretionary', 'Communication Services', 'Industrials', 'Consumer Staples', 'Energy', 'Utilities', 'Real Estate', 'Materials'];

function getSpxUniverse() {
  return withCache('equity:spx-universe', 7 * 86_400_000, async () => {
    const html = await fetchText('https://en.wikipedia.org/wiki/List_of_S%26P_500_companies', 0, 2, BROWSER_HEADERS);
    const symbols = [];
    const sectors = new Map();
    for (const row of html.split('<tr').slice(1)) {
      const match = row.match(/nasdaq\.com\/market-activity\/stocks\/([a-z.\-]+)/) ?? row.match(/nyse\.com\/quote\/(?:XNYS|XASE|ARCX):([A-Z.\-]+)/);
      if (!match) continue;
      const symbol = match[1].toUpperCase();
      if (sectors.has(symbol)) continue;
      const sector = GICS_SECTORS.find((name) => row.includes(name));
      if (!sector) continue;
      symbols.push(symbol);
      sectors.set(symbol, sector);
    }
    if (symbols.length < 400) throw new Error(`Wikipedia constituent list incomplete (${symbols.length} symbols)`);
    return { symbols, sectors };
  });
}

function getSpxConstituents() {
  return getSpxUniverse().then((universe) => universe.symbols);
}

async function getSparkBatch(symbols, { range = '1y', interval = '1d' } = {}) {
  const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(symbols.join(','))}&range=${range}&interval=${interval}`;
  const payload = await fetchJson(url, 0, 2, BROWSER_HEADERS);
  const rows = payload?.spark?.result ?? [];
  const out = new Map();
  for (const row of rows) {
    const response = row?.response?.[0];
    const rawCloses = response?.indicators?.quote?.[0]?.close ?? [];
    const values = rawCloses.map((close) => asNumber(close)).filter((value) => value !== null);
    if (interval === '1d' ? values.length >= 210 : values.length >= 60) {
      out.set(row.symbol, interval === '1d' ? values : { closes: values, timestamps: response?.timestamp ?? [] });
    }
  }
  return out;
}

async function getIntradayCloses(symbols, range = '5d', interval = '30m') {
  const settled = await Promise.allSettled(symbols.map((symbol) => getSparkBatch([symbol], { range, interval })));
  const aligned = new Map();
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const [symbol, payload] of result.value) {
      const byTimestamp = new Map();
      payload.timestamps.forEach((timestamp, index) => {
        const close = payload.closes[index];
        if (Number.isFinite(timestamp) && Number.isFinite(close)) byTimestamp.set(timestamp, close);
      });
      aligned.set(symbol, byTimestamp);
    }
  }
  if (!aligned.size) throw new Error('No intraday spark histories responded');
  return aligned;
}

async function getSparkCloses(symbols) {
  const normalized = [...new Set(symbols.map((symbol) => symbol.replace(/\./g, '-')))];
  const batches = [];
  for (let index = 0; index < normalized.length; index += 20) batches.push(normalized.slice(index, index + 20));
  const merged = new Map();
  let failures = 0;
  for (let waveStart = 0; waveStart < batches.length; waveStart += 4) {
    const wave = batches.slice(waveStart, waveStart + 4);
    const settled = await Promise.allSettled(wave.map((batch) => getSparkBatch(batch)));
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        for (const [key, value] of result.value) merged.set(key, value);
      } else {
        failures += 1;
      }
    }
    if (waveStart + 4 < batches.length) await wait(500);
  }
  if (!merged.size) throw new Error(`All ${batches.length} spark batches failed (${failures} failures)`);
  return merged;
}

export function alignedRatioSeries(left, right) {
  const n = Math.min(left.length, right.length);
  const offsetLeft = left.length - n;
  const offsetRight = right.length - n;
  const ratios = [];
  for (let index = 0; index < n; index += 1) {
    const denominator = right[offsetRight + index];
    if (denominator > 0) ratios.push(left[offsetLeft + index] / denominator);
  }
  return ratios;
}


// Sessions of advance/decline history compared against the index when asking
// whether participation confirms the tape.
const BREADTH_DIVERGENCE_WINDOW = 60;
// A thrust needs 20 sessions of setup and up to 60 more before its outcome is
// known, so the log runs on a full year of spark closes rather than the
// 60-session window the divergence read uses.
const BREADTH_THRUST_WINDOW = 250;

// A bounded universe: the whole S&P 500 would be 500 single-symbol requests,
// which is neither polite nor fast enough to sit behind a dashboard. The
// published model reports how much of the index this actually covers.
const REVISION_UNIVERSE_SIZE = 60;
const REVISION_CONCURRENCY = 6;

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]).catch(() => null);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Analyst EPS-revision counts per name, from Yahoo's earningsTrend module.
 *
 * This endpoint is frequently gated behind a crumb/cookie handshake that this
 * deployment cannot complete. When it is, the loader returns no rows and the
 * model above it reports unavailable naming the reason - it does not fall back
 * to price momentum dressed up as a fundamental reading.
 */
export async function getEarningsRevisionBreadth() {
  return withCache('analytics:revision-breadth', 12 * 3_600_000, async () => {
    let universe = [];
    try {
      universe = (await getSpxConstituents()).slice(0, REVISION_UNIVERSE_SIZE);
    } catch (error) {
      return {
        model: calculateRevisionBreadth([], { requested: 0 }),
        universeRequested: 0,
        reason: `The S&P 500 constituent list is required before revisions can be counted: ${error.message}`,
        source: null,
      };
    }

    const rows = await mapWithConcurrency(universe, REVISION_CONCURRENCY, async (symbol) => {
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=earningsTrend`;
      const payload = await fetchJson(url, 0, 1, BROWSER_HEADERS);
      const trends = payload?.quoteSummary?.result?.[0]?.earningsTrend?.trend ?? [];
      // The current-year estimate is the one with a meaningful revision count;
      // the next-quarter row is too thinly covered to read across a universe.
      const currentYear = trends.find((trend) => trend?.period === '0y') ?? trends[0];
      const revisions = currentYear?.epsRevisions ?? {};
      const up = asNumber(revisions.upLast30days?.raw ?? revisions.upLast30days);
      const down = asNumber(revisions.downLast30days?.raw ?? revisions.downLast30days);
      return up === null && down === null ? null : { symbol, up: up ?? 0, down: down ?? 0 };
    });

    const covered = rows.filter(Boolean);
    return {
      model: calculateRevisionBreadth(covered, { requested: universe.length }),
      universeRequested: universe.length,
      reason: covered.length ? null : 'Yahoo\'s earningsTrend module returned no revision counts, which is what a crumb-gated response looks like from this deployment.',
      source: covered.length ? 'Yahoo Finance earningsTrend, current-year EPS revisions over 30 days' : null,
    };
  });
}

export async function getEquityRiskAppetite() {
  return withCache('analytics:equity-risk', 6 * 3_600_000, async () => {
    const [constituentsResult, fredResult, vixResult] = await Promise.allSettled([
      getSpxConstituents(),
      Promise.all([
        getFredCsvSeries({ id: 'BAMLH0A0HYM2', key: 'highYieldSpread', name: 'US high-yield OAS' }),
        getFredCsvSeries({ id: 'DFII10', key: 'realYield10y', name: '10-year real yield' }),
        getFredCsvSeries({ id: 'T10Y2Y', key: 'yieldCurve10y2y', name: '10Y-2Y treasury spread' }),
      ]),
      getSparkBatch(['^VIX', '^VIX9D', '^VIX3M']),
    ]);

    let vixTermStructure = { status: 'unavailable', reason: `Yahoo VIX index histories are required: ${vixResult.reason?.message ?? vixResult.reason}` };
    if (vixResult.status === 'fulfilled') {
      const vix = vixResult.value.get('^VIX');
      const vix9d = vixResult.value.get('^VIX9D');
      const vix3m = vixResult.value.get('^VIX3M');
      const ratios = alignedRatioSeries(vix ?? [], vix3m ?? []);
      const ratio = ratios.at(-1) ?? null;
      vixTermStructure = Number.isFinite(ratio) ? {
        status: 'calculated',
        vix: Math.round(vix.at(-1) * 100) / 100,
        vix9d: vix9d ? Math.round(vix9d.at(-1) * 100) / 100 : null,
        vix3m: Math.round(vix3m.at(-1) * 100) / 100,
        vixVix3m: Math.round(ratio * 100) / 100,
        percentile: percentileOf(ratios, ratio),
        state: ratio >= 1 ? 'Backwardation — stress pricing' : ratio >= 0.92 ? 'Flat curve' : 'Contango — calm regime',
        observations: ratios.length,
      } : { status: 'unavailable', reason: 'VIX index histories were incomplete.' };
    }

    let spxBreadth = { status: 'unavailable', reason: `Constituent list unavailable: ${constituentsResult.reason?.message ?? constituentsResult.reason}` };
    let equalWeight = { status: 'unavailable', reason: 'RSP/SPY histories are required.' };
    let sectorRotation = { status: 'unavailable', reason: 'Sector SPDR histories are required.' };

    if (constituentsResult.status === 'fulfilled') {
      try {
        const symbols = constituentsResult.value;
        const closesBySymbol = await getSparkCloses([...symbols, 'RSP', 'SPY', ...SECTOR_SPDRS.map((sector) => sector.symbol)]);

        let above200 = 0;
        let above50 = 0;
        let advancing = 0;
        let newHighs = 0;
        let newLows = 0;
        let counted = 0;
        const thrustValues = [];
        // Net advancers per session over the divergence window, accumulated
        // below into an advance/decline line. The closes are already loaded,
        // so this costs one pass rather than another provider round trip.
        const netAdvances = new Array(BREADTH_DIVERGENCE_WINDOW).fill(0);
        // Advances and observed names per session over the longer thrust window,
        // accumulated in the same pass as everything else.
        const thrustAdvances = new Array(BREADTH_THRUST_WINDOW).fill(0);
        const thrustObserved = new Array(BREADTH_THRUST_WINDOW).fill(0);
        for (const symbol of symbols) {
          const closes = closesBySymbol.get(symbol);
          if (!closes || closes.length < 200) continue;
          counted += 1;
          const window = closes.slice(-(BREADTH_DIVERGENCE_WINDOW + 1));
          for (let index = 1; index < window.length; index += 1) {
            const slot = BREADTH_DIVERGENCE_WINDOW - (window.length - index);
            if (slot >= 0 && window[index - 1] > 0) netAdvances[slot] += window[index] > window[index - 1] ? 1 : -1;
          }
          const thrustWindow = closes.slice(-(BREADTH_THRUST_WINDOW + 1));
          for (let index = 1; index < thrustWindow.length; index += 1) {
            const slot = BREADTH_THRUST_WINDOW - (thrustWindow.length - index);
            if (slot < 0 || !(thrustWindow[index - 1] > 0)) continue;
            thrustObserved[slot] += 1;
            if (thrustWindow[index] > thrustWindow[index - 1]) thrustAdvances[slot] += 1;
          }
          const latest = closes.at(-1);
          if (latest > smaOf(closes, 200)) above200 += 1;
          if (closes.length >= 50 && latest > smaOf(closes, 50)) above50 += 1;
          const past20 = closes.at(-21);
          if (Number.isFinite(past20) && past20 > 0 && ((latest / past20) - 1) > 0) advancing += 1;
          const window60 = closes.slice(-60);
          if (latest >= Math.max(...window60) * 0.98) newHighs += 1;
          if (latest <= Math.min(...window60) * 1.02) newLows += 1;
          const sma50Past = closes.length >= 70 ? closes.slice(-70, -20).reduce((sum, value) => sum + value, 0) / 50 : null;
          const sma50Now = smaOf(closes, 50);
          if (Number.isFinite(sma50Past) && sma50Past > 0 && Number.isFinite(sma50Now)) thrustValues.push(((sma50Now / sma50Past) - 1) * 100);
        }
        if (counted >= symbols.length * 0.8) {
          let runningLine = 0;
          const advanceDeclineLine = netAdvances.map((net) => (runningLine += net));
          const benchmarkCloses = closesBySymbol.get('SPY') ?? [];
          const divergence = calculateBreadthDivergence(advanceDeclineLine, benchmarkCloses.slice(-BREADTH_DIVERGENCE_WINDOW), { lookback: BREADTH_DIVERGENCE_WINDOW });
          const advanceRatios = thrustObserved.map((observed, index) => (observed ? thrustAdvances[index] / observed : null));
          const thrustEvents = calculateThrustLog(advanceRatios, benchmarkCloses.slice(-BREADTH_THRUST_WINDOW));
          const pctAbove200 = Math.round((above200 / counted) * 100);
          const pctAbove50 = Math.round((above50 / counted) * 100);
          const participation = (pctAbove50 * 0.6) + (pctAbove200 * 0.4);
          const thrust20 = thrustValues.length ? Number((thrustValues.reduce((total, value) => total + value, 0) / thrustValues.length).toFixed(2)) : null;
          spxBreadth = {
            status: 'calculated',
            version: 'spx-constituent-breadth-v1',
            source: 'S&P 500 constituent participation via Yahoo spark closes',
            universeSize: symbols.length,
            counted,
            pctAbove200,
            pctAbove50,
            advancersPct: Math.round((advancing / counted) * 100),
            newHighs,
            newLows,
            thrust20,
            topRisk: Math.round(100 - participation),
            bottomScore: Math.round(((100 - participation) * 0.7) + (Math.max(thrust20 ?? 0, 0) * 3)),
            read: pctAbove200 >= 60 ? 'Broad participation' : pctAbove200 <= 40 ? 'Narrow market' : 'Mixed breadth',
            divergence,
            thrustEvents,
            thrustWindowSessions: BREADTH_THRUST_WINDOW,
          };
        } else {
          spxBreadth = { status: 'unavailable', reason: `Only ${counted} of ${symbols.length} constituents returned usable history.` };
        }

        const rsp = closesBySymbol.get('RSP');
        const spy = closesBySymbol.get('SPY');
        if (rsp && spy) {
          const ratio = alignedRatioSeries(rsp, spy);
          const slope50 = ratio.length > 55 ? Math.round(((ratio.at(-1) / ratio.at(-51)) - 1) * 10000) / 100 : null;
          equalWeight = {
            status: slope50 !== null ? 'calculated' : 'unavailable',
            ratio: Math.round(ratio.at(-1) * 1000) / 1000,
            slope50,
            read: slope50 === null ? 'Insufficient history' : slope50 > 0.5 ? 'Equal-weight leading — broad tape' : slope50 < -0.5 ? 'Cap-weight leading — narrowing tape' : 'Balanced',
            reason: slope50 === null ? 'RSP/SPY history shorter than the 50-session window.' : undefined,
          };
        }

        const sectorRows = [];
        for (const sector of SECTOR_SPDRS) {
          const closes = closesBySymbol.get(sector.symbol);
          if (!closes || !spy || closes.length < 70) continue;
          const rs = alignedRatioSeries(closes, spy);
          if (rs.length < 65) continue;
          const momentum3m = Math.round(((rs.at(-1) / rs.at(-64)) - 1) * 10000) / 100;
          const momentum20d = Math.round(((rs.at(-1) / rs.at(-21)) - 1) * 10000) / 100;
          sectorRows.push({ symbol: sector.symbol, name: sector.name, momentum3m, momentum20d });
        }
        if (sectorRows.length >= 8) {
          sectorRows.sort((left, right) => right.momentum3m - left.momentum3m);
          sectorRotation = { status: 'calculated', leaders: sectorRows.slice(0, 3).map((row) => row.name).join(', '), laggards: sectorRows.slice(-2).map((row) => row.name).join(', '), rows: sectorRows };
        } else {
          sectorRotation = { status: 'unavailable', reason: `Only ${sectorRows.length} sector SPDRs returned usable history.` };
        }
      } catch (error) {
        spxBreadth = { status: 'unavailable', reason: `Breadth calculation failed: ${error.message}` };
      }
    }

    let creditStress = { status: 'unavailable', reason: 'FRED high-yield spread is required.' };
    let riskPremium = { status: 'unavailable', reason: 'Earnings-yield and real-yield inputs are required.' };
    let yieldCurve = { status: 'unavailable', reason: 'FRED T10Y2Y is required.' };
    if (fredResult.status === 'fulfilled') {
      const [hySeries, realSeries, curveSeries] = fredResult.value;
      const hyValue = hySeries?.value;
      const hy20dAgo = hySeries?.history?.at(-21)?.value;
      creditStress = Number.isFinite(hyValue) ? {
        status: 'calculated',
        level: hyValue,
        change20d: Number.isFinite(hy20dAgo) ? Math.round((hyValue - hy20dAgo) * 100) / 100 : null,
        read: hyValue < 3.2 ? 'Complacent' : hyValue < 4.5 ? 'Neutral' : hyValue < 6 ? 'Stress building' : 'Distress',
        date: hySeries.date,
      } : { status: 'unavailable', reason: 'FRED returned no usable high-yield observation.' };

      const curveValue = curveSeries?.value;
      const curve20dAgo = curveSeries?.history?.at(-21)?.value;
      yieldCurve = Number.isFinite(curveValue) ? {
        status: 'calculated',
        spread: curveValue,
        change20d: Number.isFinite(curve20dAgo) ? Math.round((curveValue - curve20dAgo) * 100) / 100 : null,
        state: curveValue < 0 ? 'Inverted — late-cycle signal' : curveValue < 0.5 ? 'Flat — dis-inversion watch' : 'Positively sloped — early/mid cycle',
        date: curveSeries.date,
      } : { status: 'unavailable', reason: 'FRED returned no usable curve observation.' };

      const realYield = realSeries?.value;
      try {
        const html = await fetchText('https://www.multpl.com/s-p-500-earnings-yield', 0, 2, BROWSER_HEADERS);
        const match = html.match(/Current S&amp;P 500 Earnings Yield[:<>/a-z\s]*(-?[\d.]+)/) ?? html.match(/Current S&P 500 Earnings Yield[:<>/a-z\s]*(-?[\d.]+)/);
        const earningsYield = match ? asNumber(match[1]) : null;
        riskPremium = earningsYield !== null && Number.isFinite(realYield) ? {
          status: 'calculated',
          earningsYield,
          realYield10y: realYield,
          spread: Math.round((earningsYield - realYield) * 100) / 100,
          basis: 'Trailing earnings yield (multpl.com) minus 10-year TIPS real yield',
          read: earningsYield - realYield > 2 ? 'Equities cheap vs bonds' : earningsYield - realYield > 0 ? 'Modest equity premium' : 'Bonds favored',
          date: realSeries.date,
        } : { status: 'unavailable', reason: 'multpl.com earnings yield or FRED real yield was unusable.' };
      } catch (error) {
        riskPremium = { status: 'unavailable', reason: `multpl.com unreachable: ${error.message}` };
      }
    } else {
      creditStress = { status: 'unavailable', reason: `FRED CSV unreachable: ${fredResult.reason?.message ?? fredResult.reason}` };
    }

    const legs = [spxBreadth, equalWeight, creditStress, riskPremium, sectorRotation, vixTermStructure, yieldCurve];
    const calculatedCount = legs.filter((leg) => leg.status === 'calculated').length;
    return {
      asOf: new Date().toISOString(),
      version: 'equity-risk-v1',
      status: calculatedCount ? 'calculated' : 'unavailable',
      calculatedCount,
      totalLegs: legs.length,
      spxBreadth,
      equalWeight,
      creditStress,
      riskPremium,
      sectorRotation,
      vixTermStructure,
      yieldCurve,
      methodology: 'Breadth computes 200-day and 50-day simple averages per constituent from Wikipedia\'s S&P 500 list and Yahoo batch spark closes. Equal-weight participation uses the RSP/SPY ratio 50-session slope. Credit stress reads FRED BAMLH0A0HYM2 with a 20-observation change, and the curve leg reads FRED T10Y2Y. The risk-premium proxy subtracts the 10-year TIPS real yield from the trailing earnings yield on multpl.com. Sector rotation ranks 11 SPDRs by 3-month relative strength versus SPY. The VIX term structure divides spot VIX by VIX3M from Yahoo index histories.',
    };
  });
}

export async function getEquityScreener() {
  return withCache('analytics:screener', 12 * 3_600_000, async () => {
    const universe = await getSpxUniverse();
    const symbols = universe.symbols;
    const closesByKey = await getSparkCloses([...symbols, 'SPY']);
    const benchmark = closesByKey.get('SPY');
    if (closesByKey.has('SPY')) closesByKey.delete('SPY');
    const benchmarkMom20 = benchmark && benchmark.length > 21 ? ((benchmark.at(-1) / benchmark.at(-21)) - 1) * 100 : null;
    const benchmarkMom60 = benchmark && benchmark.length > 61 ? ((benchmark.at(-1) / benchmark.at(-61)) - 1) * 100 : null;
    const round1 = (value) => Math.round(value * 10) / 10;
    const rows = [];
    for (const [symbol, closes] of closesByKey) {
      const last = closes.at(-1);
      if (!Number.isFinite(last)) continue;
      const sma200 = smaOf(closes, 200);
      const sma50 = smaOf(closes, 50);
      const sma200Then = smaOf(closes.slice(0, -20), 200);
      const yearHigh = closes.length > 200 ? Math.max(...closes.slice(-252)) : Math.max(...closes);
      const returns = [];
      for (let index = closes.length - 20; index < closes.length; index += 1) {
        if (closes[index - 1] > 0) returns.push((closes[index] / closes[index - 1]) - 1);
      }
      const meanReturn = returns.reduce((total, value) => total + value, 0) / (returns.length || 1);
      const variance = returns.reduce((total, value) => total + ((value - meanReturn) ** 2), 0) / (returns.length || 1);
      const trend = calculateTrendQuality(closes);
      rows.push({
        symbol,
        sector: universe.sectors.get(symbol) ?? null,
        last: Math.round(last * 100) / 100,
        mom20: closes.length > 21 ? round1(((last / closes.at(-21)) - 1) * 100) : null,
        mom60: closes.length > 61 ? round1(((last / closes.at(-61)) - 1) * 100) : null,
        vsSma200: Number.isFinite(sma200) ? round1(((last / sma200) - 1) * 100) : null,
        pctFrom52wHigh: yearHigh > 0 ? round1(((last / yearHigh) - 1) * 100) : null,
        above50: Number.isFinite(sma50) ? last > sma50 : null,
        breakout: Number.isFinite(sma200) && Number.isFinite(sma200Then) && last > sma200 && closes.at(-21) <= sma200Then,
        vol20: returns.length >= 10 ? round1(Math.sqrt(variance) * Math.sqrt(252) * 100) : null,
        rsi14: calculateRsi(closes),
        trendSlopePct: trend?.annualizedSlopePct ?? null,
        trendR2: trend?.r2 ?? null,
        trendQuality: trend?.quality ?? null,
      });
    }
    if (!rows.length) {
      return { asOf: new Date().toISOString(), version: 'screener-v1', status: 'unavailable', reason: 'No constituent histories were returned.', calculatedCount: 0, universeSize: symbols.length, rows: [], methodology: 'Requires Yahoo batch spark histories for the S&P 500 constituent list.' };
    }
    for (const row of rows) {
      row.vsIndexMom20 = benchmarkMom20 !== null && Number.isFinite(row.mom20) ? round1(row.mom20 - benchmarkMom20) : null;
      row.vsIndexMom60 = benchmarkMom60 !== null && Number.isFinite(row.mom60) ? round1(row.mom60 - benchmarkMom60) : null;
    }
    const scored = calculateScreenerScores(rows);
    const sectorBuckets = new Map();
    for (const row of scored) {
      const sector = universe.sectors.get(row.symbol);
      if (!sector) continue;
      const bucket = sectorBuckets.get(sector) ?? { sector, constituents: 0, counted: 0, advancers: 0, momentumSum: 0, leader: null };
      bucket.constituents += 1;
      if (Number.isFinite(row.mom20)) {
        bucket.counted += 1;
        bucket.momentumSum += row.mom20;
        if (row.mom20 > 0) bucket.advancers += 1;
        if (!bucket.leader || row.mom20 > bucket.leader.mom20) bucket.leader = { symbol: row.symbol, mom20: row.mom20 };
      }
      sectorBuckets.set(sector, bucket);
    }
    const sectorLeadership = [...sectorBuckets.values()]
      .map((bucket) => ({
        sector: bucket.sector,
        constituents: bucket.constituents,
        advancersPct: bucket.counted ? Math.round((bucket.advancers / bucket.counted) * 100) : null,
        avgMomentum20d: bucket.counted ? Math.round((bucket.momentumSum / bucket.counted) * 10) / 10 : null,
        leader: bucket.leader,
      }))
      .sort((a, b) => (b.avgMomentum20d ?? -999) - (a.avgMomentum20d ?? -999));
    const sectorScoreGroups = new Map();
    for (const row of scored) {
      const sector = universe.sectors.get(row.symbol);
      if (!sector || !Number.isFinite(row.score)) continue;
      if (!sectorScoreGroups.has(sector)) sectorScoreGroups.set(sector, []);
      sectorScoreGroups.get(sector).push(row);
    }
    for (const [, group] of sectorScoreGroups) {
      group.sort((a, b) => b.score - a.score);
      group.forEach((row, index) => { row.sectorRank = index + 1; row.sectorCount = group.length; });
    }
    const calculated = scored.length;
    const near52wHighCount = scored.filter((row) => Number.isFinite(row.pctFrom52wHigh) && row.pctFrom52wHigh >= -5).length;
    const above50Count = scored.filter((row) => row.above50 === true).length;
    const persistentTrendCount = scored.filter((row) => Number.isFinite(row.trendQuality) && row.trendQuality > 0 && row.trendR2 >= 0.5).length;
    const qualityCovered = scored.filter((row) => Number.isFinite(row.trendQuality)).length;
    return {
      asOf: new Date().toISOString(),
      version: 'screener-v1',
      status: 'calculated',
      calculatedCount: scored.length,
      universeSize: symbols.length,
      rows: scored,
      breadth: {
        calculated,
        near52wHighCount,
        near52wHighPct: calculated ? Math.round((near52wHighCount / calculated) * 100) : null,
        above50Pct: calculated ? Math.round((above50Count / calculated) * 100) : null,
        persistentTrendCount,
        persistentTrendPct: qualityCovered ? Math.round((persistentTrendCount / qualityCovered) * 100) : null,
        qualityCovered,
      },
      sectorLeadership,
      methodology: 'Universe is Wikipedia\'s S&P 500 constituent list with GICS sector attribution from the same table; metrics come from Yahoo batch spark one-year daily closes. The composite score cross-sectionally ranks 20-session momentum (45%), distance above the 200-day average (35%), and the inverse of 20-day annualized volatility (20%). RSI-14 uses standard Wilder smoothing on the same closes. Momentum is also expressed as excess return versus SPY over identical windows. Sector leadership aggregates each GICS sector\'s share of 20-session advancers and its average momentum. Distance from the 52-week high uses the trailing 252-session peak. Trend quality fits an ordinary least-squares line to the last 90 log closes: the annualized slope is the fitted daily drift compounded over 252 sessions, and the quality reading multiplies that slope by the fit\'s R-squared so that only trends the price actually respects rank highly.',
    };
  });
}

export async function getBitcoinCycleWorkspace() {
  return withCache('analytics:bitcoin-cycle', 30 * 60_000, async () => {
    const onchainLoader = async () => {
      await wait(1_500);
      const mvrvZ = await fetchJson('https://bitcoin-data.com/v1/mvrv-zscore');
      await wait(1_500);
      const sth = await fetchJson('https://bitcoin-data.com/v1/sth-realized-price');
      bitcoinOnchainMemo = { mvrvZ, sth };
      return { mvrvZ, sth, memoized: false };
    };
    const derivativesLoader = async () => {
      const funding = await getBinanceFundingLeg();
      const positioning = await getBinancePositioningLeg();
      bitcoinDerivativesMemo = { funding, positioning };
      return { funding, positioning, memoized: false };
    };
    const [priceResult, barsResult, onchainResult, derivativesResult, stablecoinsResult] = await Promise.allSettled([
      getYahooHistory('BTC-USD', '10y'),
      getYahooOhlcHistory('BTC-USD', '5y'),
      onchainLoader(),
      derivativesLoader(),
      fetchJson('https://stablecoins.llama.fi/stablecoincharts/all'),
    ]);
    const onchainData = onchainResult.status === 'fulfilled' ? onchainResult.value : bitcoinOnchainMemo;
    const derivativesData = derivativesResult.status === 'fulfilled' ? derivativesResult.value : bitcoinDerivativesMemo;
    const mvrvRaw = onchainData?.mvrvZ ?? [];
    const sthRaw = onchainData?.sth ?? [];

    const priceHistory = priceResult.status === 'fulfilled' ? priceResult.value : [];
    const closes = priceHistory.map((point) => point.value);
    const spot = closes.at(-1) ?? null;
    const sma200d = smaOf(closes, 200);
    // The 200-week average is a mean of weekly closes, not of 1,400 daily ones.
    // The stack model resamples properly, so the cycle phase reads the same
    // number a weekly chart shows rather than a day-count approximation.
    const stack = calculateMovingAverageStack(priceHistory);
    const sma200w = stack.averages?.find((entry) => entry.key === 'sma200w')?.value ?? null;

    const trend = spot !== null && sma200d !== null ? {
      status: 'calculated',
      price: spot,
      sma200d: Math.round(sma200d),
      sma200w: sma200w !== null ? Math.round(sma200w) : null,
      pctVsSma200d: Math.round(((spot / sma200d) - 1) * 1000) / 10,
      pctVsSma200w: sma200w !== null ? Math.round(((spot / sma200w) - 1) * 1000) / 10 : null,
      observations: closes.length,
    } : { status: 'unavailable', reason: 'Yahoo BTC-USD 10-year history is required for the 200-day and 200-week averages.' };

    const drawdown = spot !== null && priceHistory.length > 250 ? (() => {
      let ath = -Infinity;
      let athTimestamp = null;
      for (const point of priceHistory) {
        if (point.value > ath) {
          ath = point.value;
          athTimestamp = point.timestamp;
        }
      }
      const daysSinceAth = athTimestamp ? Math.round((new Date(priceHistory.at(-1).timestamp) - new Date(athTimestamp)) / 86_400_000) : null;
      const drawdownPct = Math.round(((spot / ath) - 1) * 1000) / 10;
      return {
        status: 'calculated',
        allTimeHigh: Math.round(ath),
        drawdownPct,
        daysSinceAth,
        read: drawdownPct > -20 ? 'Near highs' : drawdownPct > -45 ? 'Drawdown' : drawdownPct > -70 ? 'Deep bear' : 'Capitulation zone',
        observations: priceHistory.length,
      };
    })() : { status: 'unavailable', reason: 'Yahoo BTC-USD 10-year history is required for the drawdown read.' };

    const realizedVolatility = (() => {
      if (closes.length < 60) return { status: 'unavailable', reason: 'At least 60 daily closes are required for realized volatility.' };
      const windowVol = (start, end) => {
        const returns = [];
        for (let index = Math.max(1, start); index < end; index += 1) {
          if (closes[index - 1] > 0) returns.push(Math.log(closes[index] / closes[index - 1]));
        }
        if (returns.length < 2) return null;
        const meanReturn = returns.reduce((total, value) => total + value, 0) / returns.length;
        const variance = returns.reduce((total, value) => total + ((value - meanReturn) ** 2), 0) / (returns.length - 1);
        return Math.sqrt(variance) * Math.sqrt(365) * 100;
      };
      const current = windowVol(closes.length - 31, closes.length);
      if (current === null) return { status: 'unavailable', reason: 'Volatility window incomplete.' };
      const rolling = [];
      for (let end = 31; end <= closes.length; end += 1) {
        const value = windowVol(end - 31, end);
        if (value !== null) rolling.push(value);
      }
      const percentile = percentileOf(rolling, current);
      return {
        status: 'calculated',
        realizedVol30dPct: Math.round(current * 10) / 10,
        percentile: rolling.length > 60 ? percentile : null,
        read: percentile >= 80 ? 'Elevated' : percentile <= 20 ? 'Compressed' : 'Normal',
        observations: rolling.length,
      };
    })();

    const mvrvSeries = Array.isArray(mvrvRaw) ? mvrvRaw : [];
    const mvrvLatest = mvrvSeries.at(-1);
    const mvrvScore = asNumber(mvrvLatest?.mvrvZscore);
    const valuation = mvrvScore !== null ? {
      status: 'calculated',
      mvrvZ: mvrvScore,
      band: mvrvScore <= 0 ? 'Historic value zone' : mvrvScore <= 2 ? 'Early cycle' : mvrvScore <= 5 ? 'Mid cycle' : 'Late cycle',
      percentile: percentileOf(mvrvSeries.map((row) => asNumber(row.mvrvZscore)).filter((value) => Number.isFinite(value)), mvrvScore),
      asOf: mvrvLatest.d,
      observations: mvrvSeries.length,
    } : { status: 'unavailable', reason: `bitcoin-data.com MVRV Z-score feed is required: ${onchainResult.reason?.message ?? onchainResult.reason ?? 'payload missing'}` };

    const sthSeries = Array.isArray(sthRaw) ? sthRaw : [];
    const sthLatest = sthSeries.at(-1);
    const sthPrice = asNumber(sthLatest?.sthRealizedPrice);
    const shortTermHolder = sthPrice !== null && spot !== null ? {
      status: 'calculated',
      sthRealizedPrice: Math.round(sthPrice),
      premiumPercent: Math.round(((spot / sthPrice) - 1) * 1000) / 10,
      state: spot >= sthPrice ? 'Recent buyers in profit' : 'Recent buyers underwater',
      asOf: sthLatest.d,
    } : { status: 'unavailable', reason: `bitcoin-data.com STH realized-price feed is required: ${onchainResult.reason?.message ?? onchainResult.reason ?? 'payload missing'}` };

    const fundingResult = derivativesResult.status === 'fulfilled' ? { status: 'fulfilled', value: derivativesResult.value.funding } : derivativesResult;
    const positioningResult = derivativesResult.status === 'fulfilled' ? { status: 'fulfilled', value: derivativesResult.value.positioning } : derivativesResult;

    const leverage = fundingResult.status === 'fulfilled' ? {
      status: 'calculated',
      ...fundingResult.value,
      note: `Aggregate of ${fundingResult.value.venues} venues; percentile over ~${fundingResult.value.windowDays}-day Binance history.`,
    } : { status: 'unavailable', reason: `Perpetual funding endpoints are unreachable: ${fundingResult.reason?.message ?? fundingResult.reason}` };

    const positioning = positioningResult.status === 'fulfilled' ? { status: 'calculated', ...positioningResult.value } : { status: 'unavailable', reason: `Binance open-interest history is unreachable: ${positioningResult.reason?.message ?? positioningResult.reason}` };

    const etfFlows = { status: 'unavailable', reason: 'Farside is Cloudflare-blocked from this environment; no keyless ETF-flow source is available.' };

    const stableRows = stablecoinsResult.status === 'fulfilled' && Array.isArray(stablecoinsResult.value) ? stablecoinsResult.value : [];
    const supplyNow = asNumber(stableRows.at(-1)?.totalCirculating?.peggedUSD);
    const supply30dAgo = asNumber(stableRows.at(-31)?.totalCirculating?.peggedUSD);
    const stablecoins = supplyNow !== null && supply30dAgo !== null ? {
      status: 'calculated',
      supplyUsdBillions: Math.round(supplyNow / 100_000_000) / 10,
      change30dUsdBillions: Math.round((supplyNow - supply30dAgo) / 100_000_000) / 10,
      change30dPercent: Math.round(((supplyNow / supply30dAgo) - 1) * 1000) / 10,
      state: supplyNow >= supply30dAgo ? 'Dry powder building' : 'Supply contracting',
    } : { status: 'unavailable', reason: 'DefiLlama stablecoin history is required.' };

    const technicals = calculateBitcoinTechnicals(priceHistory);
    const priceBars = barsResult.status === 'fulfilled' ? barsResult.value : [];
    const rangeModels = priceBars.length
      ? calculateBitcoinRangeModels(priceBars, { onBalanceVolume: { source: 'Yahoo BTC-USD daily bars' } })
      : { version: 'bitcoin-range-models-v1', status: 'unavailable', reason: `Yahoo BTC-USD daily bars are required for true ranges, channels, the DeMark countdown and volume: ${barsResult.reason?.message ?? barsResult.reason ?? 'payload missing'}`, observations: 0, unavailableModules: ['atr', 'donchian', 'tdCountdown', 'onBalanceVolume'], provisionalModules: [], modules: {} };

    const legs = [trend, valuation, shortTermHolder, leverage, positioning, etfFlows, stablecoins, drawdown, realizedVolatility];
    const calculatedCount = legs.filter((leg) => leg.status === 'calculated').length;
    const phase = calculateBitcoinCyclePhase({ trend, valuation, drawdown, leverage, stablecoins, shortTermHolder, realizedVolatility });
    return {
      asOf: new Date().toISOString(),
      version: 'bitcoin-cycle-v1',
      status: calculatedCount ? 'calculated' : 'unavailable',
      calculatedCount,
      totalLegs: legs.length,
      phase,
      technicals,
      rangeModels,
      trend,
      valuation,
      shortTermHolder,
      leverage,
      positioning,
      etfFlows,
      stablecoins,
      drawdown,
      realizedVolatility,
      methodology: 'Trend uses Yahoo BTC-USD daily closes for the 200-day average and weekly closes for the 200-week average. The technicals block adds stochastic RSI, the four RSI divergence types on confirmed pivots, the full moving-average stack with the 50/200 cross and a Z-score of the stretch from the 200-day average, Bollinger compression, range percentile, the TD setup count, momentum slope and volatility-adjusted momentum - all from the same close series. The range block adds what needs the daily high, low and volume: Wilder ATR expansion, Donchian channels measured against the channel as it stood before the current bar, the DeMark countdown with its bar-13 qualifier, setup perfection and the TDST line, and on-balance volume against price. Valuation and short-term-holder cost basis come from bitcoin-data.com on-chain series. Funding aggregates Binance and Bybit perpetual rates with a Binance-history percentile; the OI/price quadrant uses 7-day changes in Binance futures open interest versus price. Stablecoin supply is DefiLlama aggregate circulating value. Drawdown is measured from the ten-year high; realized volatility is the 30-day annualized standard deviation of log returns percentile-ranked over the same window. Spot ETF flows remain unavailable without a licensed source.',
    };
  });
}

export async function getMetalsWorkspace() {
  return withCache('analytics:metals-workspace', 15 * 60_000, async () => {
    const [positioningResult, liquidityResult, cotDetailResult] = await Promise.allSettled([getMarketPositioning(), getLiquiditySnapshot(), getCotDisaggregatedGold()]);
    const positioning = positioningResult.status === 'fulfilled' ? positioningResult.value.model : null;
    const liquidity = liquidityResult.status === 'fulfilled' ? liquidityResult.value : null;
    const cotDetail = cotDetailResult.status === 'fulfilled' ? cotDetailResult.value : null;
    const goldContract = positioning?.contracts?.find((contract) => contract.key === 'gold') ?? null;
    const fetchSeries = async (yahooSymbol) => {
      const points = await getYahooHistory(yahooSymbol);
      return points.map((point) => ({ timestamp: point.timestamp, value: point.value }));
    };
    const spotResults = await Promise.allSettled(METALS_SPOT.map(async (entry) => ({ entry, summary: summarizeMetalHistory(entry.name, await fetchSeries(entry.yahooSymbol)) })));
    const minerResults = await Promise.allSettled(METALS_MINERS.map(async (entry) => ({ entry, summary: summarizeMetalHistory(entry.name, await fetchSeries(entry.symbol)) })));
    const assets = spotResults.flatMap((result) => result.status === 'fulfilled' && result.value.summary ? [{ symbol: result.value.entry.symbol, ...result.value.summary }] : []);
    const miners = minerResults.flatMap((result) => result.status === 'fulfilled' && result.value.summary ? [{ symbol: result.value.entry.symbol, ...result.value.summary }] : []);

    const ratioResults = await Promise.allSettled([getYahooHistory('GC=F'), getYahooHistory('SI=F'), getYahooHistory('HG=F')]);
    // Producer economics: energy is the fast-moving input cost, and GDX over GLD
    // is the market's own running verdict on whether the metal outpaces it.
    const [crudeResult, gasResult, minerResult, metalResult] = await Promise.allSettled([
      getYahooHistory('CL=F'),
      getYahooHistory('NG=F'),
      getYahooHistory('GDX'),
      getYahooHistory('GLD'),
    ]);
    const valuesOf = (result) => (result.status === 'fulfilled' ? (result.value ?? []).map((point) => point.value).filter(Number.isFinite) : []);
    const minerValues = valuesOf(minerResult);
    const metalValues = valuesOf(metalResult);
    const costStructure = calculateMetalsCostStructure({
      crude: valuesOf(crudeResult),
      naturalGas: valuesOf(gasResult),
      minerToMetalRatio: minerValues.length && metalValues.length ? alignedRatioSeries(minerValues, metalValues) : [],
    });
    const buildRatioLeg = (goldPoints, otherPoints, format, readFor) => {
      if (!Array.isArray(goldPoints) || !Array.isArray(otherPoints)) return { status: 'unavailable', reason: 'Futures history is required.' };
      const ratios = alignedRatioSeries(goldPoints.map((point) => point.value), otherPoints.map((point) => point.value));
      const ratio = ratios.at(-1);
      if (!Number.isFinite(ratio)) return { status: 'unavailable', reason: 'Ratio series was incomplete.' };
      return {
        status: 'calculated',
        ratio: Math.round(ratio * format) / format,
        percentile: percentileOf(ratios, ratio),
        change20d: ratios.length > 25 ? Math.round(((ratio / ratios.at(-21)) - 1) * 10000) / 100 : null,
        observations: ratios.length,
        ...readFor(ratio, ratios.length > 30 ? percentileOf(ratios, ratio) : null),
      };
    };
    const goldSilverRatio = buildRatioLeg(ratioResults[0].status === 'fulfilled' ? ratioResults[0].value : null, ratioResults[1].status === 'fulfilled' ? ratioResults[1].value : null, 10, (ratio, percentile) => ({
      read: percentile === null ? 'Building history' : percentile >= 80 ? 'Gold favored — monetary bid' : percentile <= 20 ? 'Silver favored — industrial bid' : 'Balanced',
    }));
    const goldCopperRatio = buildRatioLeg(ratioResults[0].status === 'fulfilled' ? ratioResults[0].value : null, ratioResults[2].status === 'fulfilled' ? ratioResults[2].value : null, 1000, (value, percentile) => ({
      read: percentile === null ? 'Building history' : percentile >= 60 ? 'Risk-off tilt — gold outpacing copper' : percentile <= 40 ? 'Risk-on tilt — copper keeping pace' : 'Balanced',
    }));
    return {
      asOf: new Date().toISOString(),
      version: 'metals-workspace-v1',
      status: assets.length ? 'calculated' : 'unavailable',
      calculatedCount: assets.length + miners.length,
      universeSize: METALS_SPOT.length + METALS_MINERS.length,
      assets,
      miners,
      cot: goldContract ? { percentile: goldContract.percentile, netNoncomm: goldContract.netNoncomm, weeklyChange: goldContract.weeklyChange, crowd: goldContract.crowd, stance: goldContract.stance, asOf: goldContract.asOf } : null,
      cotDetail,
      ratios: { goldSilver: goldSilverRatio, goldCopper: goldCopperRatio },
      costStructure,
      macro: isPublished(liquidity?.usdStrength) && isPublished(liquidity?.globalLiquidity) ? { dollar: { score: liquidity.usdStrength.score, regime: liquidity.usdStrength.regime }, globalLiquidity: { score: liquidity.globalLiquidity.score, regime: liquidity.globalLiquidity.regime } } : null,
      methodology: 'Spot metals use front CME/COMEX futures (GC, SI, PL, PA) and miners use ETF close histories from Yahoo Finance; scores are technical-v1 with 20-day annualized volatility and 20-session momentum. COT figures reuse the platform gold contract percentile. Cross-ratios divide aligned GC/SI and GC/HG futures closes, percentile-ranked over the shared one-year window.',
    };
  });
}

export async function getEthereumRotation() {
  return withCache('analytics:eth-rotation', 30 * 60_000, async () => {
    const [ethResult, btcResult] = await Promise.allSettled([getYahooHistory('ETH-USD'), getYahooHistory('BTC-USD')]);
    if (ethResult.status !== 'fulfilled') return { asOf: new Date().toISOString(), version: 'eth-rotation-v1', status: 'unavailable', reason: `Yahoo ETH-USD history is required: ${ethResult.reason?.message ?? ethResult.reason}` };
    const ethCloses = ethResult.value.map((point) => point.value);
    const latest = ethCloses.at(-1);
    if (!Number.isFinite(latest)) return { asOf: new Date().toISOString(), version: 'eth-rotation-v1', status: 'unavailable', reason: 'ETH history was empty.' };
    const sma200 = smaOf(ethCloses, 200);
    let rotation = null;
    if (btcResult.status === 'fulfilled') {
      const btcCloses = btcResult.value.map((point) => point.value);
      const ratios = alignedRatioSeries(btcCloses, ethCloses);
      const ratio = ratios.at(-1);
      if (Number.isFinite(ratio)) {
        const percentile = percentileOf(ratios, ratio);
        rotation = {
          ratio: Math.round(ratio * 100) / 100,
          percentile,
          change20d: ratios.length > 21 ? Math.round(((ratio / ratios.at(-21)) - 1) * 1000) / 10 : null,
          read: percentile >= 70 ? 'Bitcoin leading — flight to size' : percentile <= 30 ? 'Alts leading — risk-on rotation' : 'Balanced',
          observations: ratios.length,
        };
      }
    }
    return {
      asOf: new Date().toISOString(),
      version: 'eth-rotation-v1',
      status: 'calculated',
      price: latest,
      pctVsSma200: Number.isFinite(sma200) ? Math.round(((latest / sma200) - 1) * 1000) / 10 : null,
      momentum20d: ethCloses.length > 21 ? Math.round(((latest / ethCloses.at(-21)) - 1) * 1000) / 10 : null,
      btcEthRatio: rotation,
      methodology: 'Ethereum trend uses Yahoo ETH-USD daily closes versus its 200-day average; the BTC/ETH ratio is percentile-ranked over the aligned one-year window to read large-cap rotation inside crypto.',
    };
  });
}

export async function getTechnicalSnapshot(symbol) {
  const history = await getMarketHistory(symbol, '1Y');
  const model = calculateTechnicalSnapshot(history.points, { annualizationDays: history.symbol === 'BTC' ? 365 : 252 });
  return {
    symbol: history.symbol,
    source: history.source,
    configured: history.configured,
    stored: history.stored ?? false,
    stale: history.stale ?? false,
    asOf: model?.asOf ?? history.asOf,
    model: history.stale ? null : model,
  };
}

export async function getDxyBitcoinRelationship() {
  return withCache('analytics:dxy-btc', 15 * 60_000, async () => {
    // Settled up front: the dollar branch below can throw, and an abandoned
    // in-flight history would otherwise reject with no handler attached.
    const bitcoinPromise = settle(getMarketHistory('BTC', '1Y'));
    let dollarPoints = [];
    let dollarSource = null;

    if (config.twelveDataApiKey) {
      try {
        const dxy = await getMarketHistory('DXY', '1Y');
        dollarPoints = dxy.stale ? [] : dxy.points;
        dollarSource = dollarPoints.length ? `DXY · ${dxy.source}` : null;
      } catch {
        dollarPoints = [];
      }
    }
    if (!dollarPoints.length) {
      const liquidity = await getLiquiditySnapshot();
      const dollarSeries = liquidity.series.find((series) => series.key === 'dxy');
      dollarPoints = dollarSeries?.stale ? [] : dollarSeries?.history ?? [];
      dollarSource = dollarPoints.length ? 'FRED DTWEXBGS broad-dollar proxy' : null;
    }

    const bitcoin = unwrap(await bitcoinPromise);
    const model = dollarPoints.length && !bitcoin.stale ? calculateCrossMarketRelationship(dollarPoints, bitcoin.points) : null;
    if (model?.leadLag) {
      const leader = model.leadLag.leads === 'left' ? 'The dollar' : model.leadLag.leads === 'right' ? 'Bitcoin' : null;
      const follower = model.leadLag.leads === 'left' ? 'bitcoin' : model.leadLag.leads === 'right' ? 'the dollar' : null;
      model.leadLag.leader = leader;
      model.leadLag.follower = follower;
      model.leadLag.read = leader
        ? `${leader} moves first, with ${follower} following about ${model.leadLag.leadDays} days later`
        : 'Neither side leads: the relationship peaks at zero lag';
    }
    return {
      source: { left: dollarSource, right: bitcoin.source },
      asOf: model?.asOf ?? null,
      model,
      staleInputs: [!dollarPoints.length ? 'Dollar history' : null, bitcoin.stale ? 'Bitcoin history' : null].filter(Boolean),
    };
  });
}

export const REGIME_CORRELATION_PAIRS = [
  { key: 'creditEquities', leftKey: 'highYieldSpread', leftName: 'Credit spreads', rightSymbol: 'SPY', rightName: 'Equities (SPY)', note: 'Primary stress-transmission signal; widening against equity strength is a classic warning.' },
  { key: 'volatilityEquities', leftKey: 'vix', leftName: 'VIX', rightName: 'Equities (SPY)', rightSymbol: 'SPY', note: 'Volatility drag on equity appetite; persistent positive correlation marks stress regimes.' },
  { key: 'dollarBitcoin', leftKey: 'dxy', leftName: 'Broad dollar', rightSymbol: 'BTC', rightName: 'Bitcoin', note: 'Dollar headwind for crypto; inverse linkage typically tightens in liquidity contractions.' },
  { key: 'conditionsEquities', leftKey: 'financialConditions', leftName: 'Financial conditions (NFCI)', rightSymbol: 'SPY', rightName: 'Equities (SPY)', note: 'Weekly NFCI impulse versus equities; tightening alongside falling equities confirms restriction.' },
  { key: 'realYieldsGold', leftKey: 'realYield10y', leftName: '10Y real yields', rightSymbol: 'GLD', rightName: 'Gold proxy (GLD)', note: 'Opportunity-cost channel; strong inverse readings mark duration-hedge behavior.' },
  { key: 'dollarGold', leftKey: 'dxy', leftName: 'Broad dollar', rightSymbol: 'GLD', rightName: 'Gold proxy (GLD)', note: 'Inverse dollar linkage; a break signals a structural repricing.' },
];

export async function getRegimeCorrelations() {
  return withCache('analytics:regime-correlations', 15 * 60_000, async () => {
    const liquidity = await getLiquiditySnapshot();
    const fredHistoryByKey = Object.fromEntries(liquidity.series
      .filter((series) => !series.stale && series.history?.length)
      .map((series) => [series.key, series.history]));
    const symbols = [...new Set(REGIME_CORRELATION_PAIRS.map((pair) => pair.rightSymbol))];
    const marketResults = await Promise.allSettled(symbols.map((symbol) => getMarketHistory(symbol, '1Y')));
    const marketPointsBySymbol = {};
    marketResults.forEach((result, index) => {
      if (result.status === 'fulfilled' && !result.value.stale) marketPointsBySymbol[symbols[index]] = result.value.points ?? [];
    });

    const pairs = REGIME_CORRELATION_PAIRS.map((pair) => {
      const leftPoints = fredHistoryByKey[pair.leftKey] ?? [];
      const rightPoints = marketPointsBySymbol[pair.rightSymbol] ?? [];
      const result = leftPoints.length && rightPoints.length ? calculateChangeCorrelations(leftPoints, rightPoints) : null;
      const leadLag = result?.leadLag ?? null;
      const leader = leadLag?.leads === 'left' ? pair.leftName : leadLag?.leads === 'right' ? pair.rightName : null;
      const follower = leadLag?.leads === 'left' ? pair.rightName : leadLag?.leads === 'right' ? pair.leftName : null;
      return {
        key: pair.key,
        left: pair.leftName,
        right: pair.rightName,
        note: pair.note,
        status: result ? 'calculated' : 'unavailable',
        correlations: result?.correlations ?? { '20D': null, '60D': null, '1Y': null },
        observations: result?.observations ?? 0,
        asOf: result?.asOf ?? null,
        leadLag: leadLag ? {
          ...leadLag,
          leader,
          follower,
          read: leader ? `${leader} leads ${follower} by about ${leadLag.leadDays} days` : 'Moves together',
        } : null,
      };
    });
    const calculatedCount = pairs.filter((pair) => pair.status === 'calculated').length;
    const transmissionAssets = [
      { name: 'US equities (SPY)', symbol: 'SPY' },
      { name: 'Bitcoin', symbol: 'BTC' },
      { name: 'Gold (GLD)', symbol: 'GLD' },
    ];
    const liquidityTransmission = transmissionAssets.map((asset) => buildLiquidityTransmission(liquidity.model?.history ?? [], marketPointsBySymbol[asset.symbol] ?? [], asset.name));
    const leadSignals = pairs
      .filter((pair) => pair.leadLag?.leader)
      .sort((left, right) => Math.abs(right.leadLag.corrAtBest) - Math.abs(left.leadLag.corrAtBest))
      .map((pair) => ({
        key: pair.key,
        leader: pair.leadLag.leader,
        follower: pair.leadLag.follower,
        leadDays: pair.leadLag.leadDays,
        corrAtBest: pair.leadLag.corrAtBest,
        synchronousCorr: pair.leadLag.synchronousCorr,
        edge: pair.leadLag.edge,
        read: pair.leadLag.read,
      }));

    return {
      version: 'regime-correlation-v1',
      asOf: new Date().toISOString(),
      status: calculatedCount ? 'calculated' : 'unavailable',
      coverage: Math.round((calculatedCount / pairs.length) * 100),
      calculatedCount,
      pairs,
      leadSignals,
      liquidityTransmission,
      liquidityTransmissionMethodology: 'Four-week net-liquidity changes (us-liquidity-v1 history) are cross-correlated against same-window changes of each asset aligned to liquidity dates, at lags of up to eight weeks. A positive lag means liquidity moves first; the peak is ranked by absolute correlation and a lead is only claimed at |r| >= 0.20.',
      leadLagMethodology: 'Each pair\'s aligned daily changes are cross-correlated across a lag window of ten observations in both directions, ranked by absolute correlation so a genuinely inverse pair is not misread. A lead is only claimed when the peak beats the synchronous reading by 0.05 and the lag is measured in calendar days from the pair\'s own observation cadence, so a weekly series reports weeks rather than sessions.',
      missingInputs: pairs.filter((pair) => pair.status === 'unavailable').map((pair) => `${pair.left} / ${pair.right}`),
    };
  });
}

const COT_DATASET = '6dca-aqww';
const COT_CONTRACTS = [
  { code: '13874A', key: 'sp500', name: 'E-mini S&P 500' },
  { code: '209742', key: 'nasdaq100', name: 'E-mini Nasdaq-100' },
  { code: '088691', key: 'gold', name: 'COMEX Gold' },
  { code: '1170E1', key: 'vix', name: 'VIX Futures' },
  { code: '098662', key: 'usdIndex', name: 'US Dollar Index' },
  { code: '099741', key: 'fxeur', name: 'Euro FX' },
  { code: '097741', key: 'fxjpy', name: 'Japanese Yen' },
  { code: '096742', key: 'fxgbp', name: 'British Pound' },
  { code: '090741', key: 'fxcad', name: 'Canadian Dollar' },
  { code: '232741', key: 'fxaud', name: 'Australian Dollar' },
  { code: '092741', key: 'fxchf', name: 'Swiss Franc' },
];

// Both CFTC datasets route through here so the optional app token is applied
// identically and the query stays in one shape.
function cftcRequest(dataset, params) {
  return buildSocrataRequest('publicreporting.cftc.gov', dataset, { appToken: config.cftcAppToken, params });
}


async function getCotContract(contract) {
  const request = cftcRequest(COT_DATASET, {
    $select: 'report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all,comm_positions_long_all,comm_positions_short_all,open_interest_all',
    $where: `cftc_contract_market_code='${contract.code}'`,
    $order: 'report_date_as_yyyy_mm_dd DESC',
    $limit: '160',
  });
  const rows = await fetchJson(request.url, 0, 2, request.headers);
  const history = (Array.isArray(rows) ? rows : []).map((row) => {
    const long = Number(row.noncomm_positions_long_all);
    const short = Number(row.noncomm_positions_short_all);
    const commLong = Number(row.comm_positions_long_all);
    const commShort = Number(row.comm_positions_short_all);
    return {
      date: String(row.report_date_as_yyyy_mm_dd ?? '').slice(0, 10),
      netNoncomm: Number.isFinite(long) && Number.isFinite(short) ? long - short : null,
      commNet: Number.isFinite(commLong) && Number.isFinite(commShort) ? commLong - commShort : null,
      openInterest: Number(row.open_interest_all),
    };
  }).filter((point) => point.date && Number.isFinite(point.netNoncomm));
  if (!history.length) throw new Error(`CFTC returned no usable rows for ${contract.code}`);
  return { key: contract.key, name: contract.name, code: contract.code, latestDate: history[0].date, stale: isCotReportStale(history[0].date), history };
}

export async function getMarketPositioning() {
  return withCache('analytics:cot-positioning', 24 * 60 * 60_000, async () => {
    const results = await Promise.allSettled(COT_CONTRACTS.map(getCotContract));
    const reports = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason.message] : []);
    const model = calculatePositioningModel(reports);
    return {
      asOf: new Date().toISOString(),
      provider: { name: 'CFTC public reporting (Socrata)', configured: true },
      model,
      staleContracts: reports.filter((report) => report.stale).map((report) => report.name),
      errors,
    };
  });
}

const FX_PAIRS = [
  { key: 'eur', name: 'Euro', yahooSymbol: 'EURUSD=X', inverted: false },
  { key: 'jpy', name: 'Japanese Yen', yahooSymbol: 'JPY=X', inverted: true },
  { key: 'gbp', name: 'British Pound', yahooSymbol: 'GBPUSD=X', inverted: false },
  { key: 'cad', name: 'Canadian Dollar', yahooSymbol: 'CAD=X', inverted: true },
  { key: 'aud', name: 'Australian Dollar', yahooSymbol: 'AUD=X', inverted: true },
  { key: 'chf', name: 'Swiss Franc', yahooSymbol: 'CHF=X', inverted: true },
];
const FX_LINKS = [
  { currency: 'CAD', pairKey: 'cad', market: 'WTI Crude', yahooSymbol: 'CL=F' },
  { currency: 'AUD', pairKey: 'aud', market: 'Copper', yahooSymbol: 'HG=F' },
  { currency: 'AUD', pairKey: 'aud', market: 'Gold', yahooSymbol: 'GC=F' },
  { currency: 'CHF', pairKey: 'chf', market: 'S&P 500', yahooSymbol: 'SPY' },
];

function momentumPercent(points, sessions = 20) {
  if (points.length <= sessions) return null;
  const latest = points.at(-1)?.value;
  const prior = points[points.length - 1 - sessions]?.value;
  return Number.isFinite(latest) && Number.isFinite(prior) && prior !== 0 ? Number(((latest / prior - 1) * 100).toFixed(2)) : null;
}

export async function getFxWorkspace() {
  return withCache('analytics:fx-workspace', 15 * 60_000, async () => {
    const positioningResult = await Promise.allSettled([getMarketPositioning()]);
    const positioning = positioningResult[0].status === 'fulfilled' ? positioningResult[0].value.model : null;
    const toPoints = (points) => (points ?? []).filter((point) => Number.isFinite(point.value)).map((point) => ({ timestamp: point.timestamp, value: point.value }));
    const symbols = [...new Set([...FX_PAIRS.map((pair) => pair.yahooSymbol), ...FX_LINKS.map((link) => link.yahooSymbol), 'EEM'])];
    const seriesMap = new Map();
    await Promise.allSettled(symbols.map(async (symbol) => {
      seriesMap.set(symbol, toPoints(await getYahooHistory(symbol)));
    }));
    const pairs = FX_PAIRS.flatMap((pair) => {
      let points = seriesMap.get(pair.yahooSymbol) ?? [];
      if (!points.length) return [];
      if (pair.inverted) points = points.map((point) => ({ timestamp: point.timestamp, value: 1 / point.value }));
      const technical = calculateTechnicalSnapshot(points, { annualizationDays: 252 });
      if (!technical) return [];
      const contract = positioning?.contracts?.find((item) => item.key === `fx${pair.key}`) ?? null;
      return [{
        key: pair.key,
        name: pair.name,
        quote: pair.inverted ? `USD per ${pair.name.split(' ').pop()}` : `${pair.name} per USD`,
        score: technical.score,
        regime: technical.regime,
        momentum20d: momentumPercent(points),
        momentum60d: momentumPercent(points, 60),
        rsi14: technical.indicators.rsi14,
        asOf: technical.asOf,
        observations: technical.observations,
        cot: contract ? { netNoncomm: contract.netNoncomm, weeklyChange: contract.weeklyChange, percentile: contract.percentile, crowd: contract.crowd, stance: contract.stance, asOf: contract.asOf } : null,
      }];
    });
    const pairByKey = new Map(pairs.map((pair) => [pair.key, pair]));
    const links = FX_LINKS.flatMap((link) => {
      const currencyPoints = (() => {
        const raw = seriesMap.get(FX_PAIRS.find((pair) => pair.key === link.pairKey)?.yahooSymbol) ?? [];
        const inverted = FX_PAIRS.find((pair) => pair.key === link.pairKey)?.inverted ?? false;
        const points = raw.map((point) => ({ timestamp: point.timestamp, value: inverted ? 1 / point.value : point.value }));
        return points;
      })();
      const marketPoints = seriesMap.get(link.yahooSymbol) ?? [];
      if (currencyPoints.length < 23 || marketPoints.length < 23) return [];
      const changes = calculateChangeCorrelations(currencyPoints, marketPoints);
      const correlation = changes?.correlations?.['60D'] ?? null;
      const leadLag = changes?.leadLag ?? null;
      const leader = leadLag?.leads === 'left' ? link.currency : leadLag?.leads === 'right' ? link.market : null;
      const follower = leadLag?.leads === 'left' ? link.market : leadLag?.leads === 'right' ? link.currency : null;
      return [{
        currency: link.currency,
        currencyMomentum20d: momentumPercent(currencyPoints),
        market: link.market,
        marketMomentum20d: momentumPercent(marketPoints),
        correlation60d: Number.isFinite(correlation) ? Number(correlation.toFixed(2)) : null,
        state: !Number.isFinite(correlation) ? 'Unavailable' : correlation >= 0.3 ? 'Aligned' : correlation <= -0.3 ? 'Inverse' : 'Mixed',
        observations: Math.min(currencyPoints.length, marketPoints.length),
        leadLag: leadLag ? { ...leadLag, leader, follower, read: leader ? `${leader} · ${leadLag.leadDays}d` : 'Neither' } : null,
      }];
    });
    const spyPoints = seriesMap.get('SPY') ?? [];
    const eemPoints = seriesMap.get('EEM') ?? [];
    const commodityFxMomentum = ['cad', 'aud'].map((key) => pairByKey.get(key)?.momentum20d).filter(Number.isFinite);
    const avgCommodityFx = commodityFxMomentum.length ? Number((commodityFxMomentum.reduce((total, value) => total + value, 0) / commodityFxMomentum.length).toFixed(2)) : null;
    const wtiMomentum = momentumPercent(seriesMap.get('CL=F') ?? []);
    const usdMomentum = pairs.length ? Number((-(pairs.reduce((total, pair) => total + (pair.momentum20d ?? 0), 0) / pairs.length)).toFixed(2)) : null;
    const eemMomentum = momentumPercent(eemPoints);
    const jpyPair = pairByKey.get('jpy');
    const spyMomentum = momentumPercent(spyPoints);
    const rotationSignals = [
      {
        signal: 'Commodity FX vs crude',
        detail: 'AUD/CAD average momentum against WTI',
        left: avgCommodityFx,
        right: wtiMomentum,
        status: avgCommodityFx === null || wtiMomentum === null ? 'Unavailable' : Math.sign(avgCommodityFx) === Math.sign(wtiMomentum) ? 'Confirmed' : 'Diverged',
      },
      {
        signal: 'Dollar vs EM equities',
        detail: 'Broad USD momentum against EEM',
        left: usdMomentum,
        right: eemMomentum,
        status: usdMomentum === null || eemMomentum === null ? 'Unavailable' : Math.sign(usdMomentum) !== Math.sign(eemMomentum) ? 'Confirmed' : 'Diverged',
      },
      {
        signal: 'Yen safe haven vs S&P 500',
        detail: 'JPY strength against SPY momentum',
        left: jpyPair?.momentum20d ?? null,
        right: spyMomentum,
        status: jpyPair?.momentum20d == null || spyMomentum === null ? 'Unavailable' : Math.sign(jpyPair.momentum20d) !== Math.sign(spyMomentum) ? 'Confirmed' : 'Diverged',
      },
    ];
    const riskRegime = spyMomentum === null ? 'Unavailable' : spyMomentum >= 0 ? 'Risk-on' : 'Risk-off';
    const usdStrong20d = pairs.filter((pair) => Number.isFinite(pair.momentum20d) && pair.momentum20d < 0).length;
    const usdStrong60d = pairs.filter((pair) => Number.isFinite(pair.momentum60d) && pair.momentum60d < 0).length;
    const usdMomentumPairs = pairs.filter((pair) => Number.isFinite(pair.momentum20d)).length;
    const usdBreadthPct20d = usdMomentumPairs ? Math.round((usdStrong20d / usdMomentumPairs) * 100) : null;
    const usdBreadth = usdMomentumPairs ? {
      total: usdMomentumPairs,
      strong20d: usdStrong20d,
      strong60d: usdStrong60d,
      pct20d: usdBreadthPct20d,
      read: usdBreadthPct20d >= 70 ? 'Broad USD advance' : usdBreadthPct20d <= 30 ? 'Broad USD retreat' : 'Mixed dollar',
    } : null;
    const usdContract = positioning?.contracts?.find((item) => item.key === 'usdIndex') ?? null;
    return {
      asOf: new Date().toISOString(),
      version: 'fx-workspace-v1',
      status: pairs.length ? 'calculated' : 'unavailable',
      calculatedCount: pairs.length + links.length + rotationSignals.filter((signal) => signal.status !== 'Unavailable').length,
      usdCot: usdContract ? { name: 'US Dollar Index', venue: 'ICE Futures U.S.', netNoncomm: usdContract.netNoncomm, weeklyChange: usdContract.weeklyChange, percentile: usdContract.percentile, crowd: usdContract.crowd, stance: usdContract.stance, asOf: usdContract.asOf } : null,
      pairs,
      links,
      rotationSignals,
      riskRegime,
      usdBreadth,
      methodology: 'Currency strength uses Yahoo FX crosses oriented so positive momentum means currency strength; COT figures reuse the platform CFTC contracts for EUR, JPY, GBP, CAD, AUD, CHF, and the ICE US Dollar Index (098662). Commodity links correlate 60-day daily changes; rotation signals compare 20-session momenta with sign-based confirmation. Dollar breadth counts crosses where the 20- and 60-session momentum is negative, i.e. the dollar strengthened against that currency.',
    };
  });
}

async function getFredSeries(series) {
  const url = new URL('https://api.stlouisfed.org/fred/series/observations');
  url.searchParams.set('series_id', series.id);
  url.searchParams.set('api_key', config.fredApiKey);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('sort_order', 'desc');
  url.searchParams.set('limit', '2500');
  const payload = await fetchJson(url);
  const observations = (payload.observations ?? []).filter((item) => item.value !== '.');
  const observation = observations[0];
  const value = asNumber(observation?.value);

  if (!observation || value === null) throw new Error(`FRED returned no usable observation for ${series.id}`);
  return {
    ...series,
    value,
    date: observation.date,
    stored: false,
    stale: isFredSeriesStale(series.id, observation.date),
    freshness: describeSeriesFreshness(series.id, observation.date),
    history: observations.map((item) => ({
      date: item.date,
      value: Number(item.value),
      realtimeStart: item.realtime_start ?? null,
      realtimeEnd: item.realtime_end ?? null,
    })).reverse(),
  };
}

async function getFredCsvSeries(series) {
  const url = new URL('https://fred.stlouisfed.org/graph/fredgraph.csv');
  url.searchParams.set('id', series.id);
  const csv = await fetchText(url);
  const history = csv.trim().split(/\r?\n/).slice(1)
    .map((line) => {
      const [date, raw] = line.split(',');
      return { date, value: Number(raw), realtimeStart: null, realtimeEnd: null };
    })
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date ?? '') && Number.isFinite(item.value))
    .sort((left, right) => new Date(left.date) - new Date(right.date));
  const observation = history.at(-1);
  const value = observation?.value;
  if (!observation || !Number.isFinite(value)) throw new Error(`FRED CSV returned no usable observation for ${series.id}`);
  return {
    ...series,
    value,
    date: observation.date,
    stored: false,
    stale: isFredSeriesStale(series.id, observation.date),
    freshness: describeSeriesFreshness(series.id, observation.date),
    history,
  };
}

export function getIntradayRotation(range = '5d') {
  const normalizedRange = ['1d', '5d'].includes(range) ? range : '5d';
  const interval = normalizedRange === '1d' ? '5m' : '30m';
  const barMinutes = normalizedRange === '1d' ? 5 : 30;
  return withCache(`analytics:intraday-rotation:${normalizedRange}`, 15 * 60_000, async () => {
    const symbols = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
    const names = { 'BTC-USD': 'Bitcoin', 'ETH-USD': 'Ethereum', 'SOL-USD': 'Solana' };
    const aligned = await getIntradayCloses(symbols, normalizedRange, interval);
    const reference = aligned.get('BTC-USD');
    if (!reference || reference.size < 40) throw new Error('Intraday bitcoin history unavailable');
    const sharedTimestamps = [...reference.keys()].filter((timestamp) => symbols.every((symbol) => aligned.get(symbol)?.has(timestamp)));
    if (sharedTimestamps.length < 40) throw new Error('Aligned intraday histories are too short');
    const returnsBySymbol = new Map();
    for (const symbol of symbols) {
      const series = sharedTimestamps.map((timestamp) => aligned.get(symbol).get(timestamp));
      const returns = [];
      for (let index = 1; index < series.length; index += 1) returns.push((series[index] / series[index - 1]) - 1);
      returnsBySymbol.set(symbol, returns);
    }
    const pairs = [];
    for (const [leader, follower] of [['BTC-USD', 'ETH-USD'], ['BTC-USD', 'SOL-USD'], ['ETH-USD', 'SOL-USD']]) {
      const result = calculateLeadLag(returnsBySymbol.get(leader), returnsBySymbol.get(follower));
      if (!result) continue;
      pairs.push({
        pair: `${names[leader]} → ${names[follower]}`,
        bestLagBars: result.bestLag,
        corrAtBest: result.corrAtBest,
        synchronousCorr: result.synchronousCorr,
        observations: result.observations,
        read: Math.abs(result.bestLag) <= 1 ? 'Synchronous' : result.bestLag > 0 ? `${names[leader]} leads by ${Math.abs(result.bestLag) * barMinutes}m` : `${names[follower]} leads by ${Math.abs(result.bestLag) * barMinutes}m`,
      });
    }
    return {
      asOf: new Date().toISOString(),
      version: 'intraday-rotation-v1',
      status: pairs.length ? 'calculated' : 'unavailable',
      intervalMinutes: barMinutes,
      range: normalizedRange,
      windowDays: normalizedRange === '1d' ? 1 : 5,
      bars: sharedTimestamps.length - 1,
      pairs,
      methodology: `Yahoo spark closes over ${normalizedRange === '1d' ? 'one day at five-minute resolution (~140 bars)' : 'five days at thirty-minute resolution'} for BTC, ETH, and SOL are aligned on shared timestamps and converted to bar returns. Cross-correlation is scanned across ±4 bars; the peak identifies whether altcoins follow bitcoin or lead it on rotation days.`,
    };
  });
}

export async function getStablecoinIssuance() {
  return withCache('analytics:stablecoin-issuance', 6 * 3_600_000, async () => {
    const chart = await fetchJson('https://stablecoins.llama.fi/stablecoincharts/all');
    if (!Array.isArray(chart) || chart.length < 40) throw new Error('DefiLlama stablecoin history unavailable');
    const totalAt = (index) => asNumber(chart.at(index)?.totalCirculatingUSD?.peggedUSD);
    const latest = totalAt(-1);
    if (!Number.isFinite(latest)) throw new Error('DefiLlama stablecoin totals unavailable');
    const changeOver = (days) => {
      const then = totalAt(-1 - days);
      return Number.isFinite(then) && then > 0 ? ((latest / then) - 1) * 100 : null;
    };
    const change30dPct = changeOver(30);
    return {
      asOf: new Date().toISOString(),
      version: 'stablecoin-issuance-v1',
      status: 'calculated',
      totalUsd: latest,
      change1dPct: changeOver(1),
      change7dPct: changeOver(7),
      change30dPct,
      state: !Number.isFinite(change30dPct) ? null : change30dPct >= 0.5 ? 'Expanding' : change30dPct <= -0.5 ? 'Contracting' : 'Flat',
      observations: chart.length,
      methodology: 'Aggregate circulating supply of all tracked stablecoins from DefiLlama; net issuance growth is read as a real-time dollar-liquidity proxy.',
    };
  });
}

export async function getStablecoinLeadLag() {
  return withCache('analytics:stablecoin-btc-lead', 60 * 60_000, async () => {
    const [chartResult, btcResult] = await Promise.allSettled([
      fetchJson('https://stablecoins.llama.fi/stablecoincharts/all'),
      getYahooHistory('BTC-USD'),
    ]);
    const chart = chartResult.status === 'fulfilled' && Array.isArray(chartResult.value) ? chartResult.value : [];
    const btcPoints = btcResult.status === 'fulfilled' ? btcResult.value : [];
    if (chart.length < 90 || btcPoints.length < 90) {
      return {
        asOf: new Date().toISOString(),
        version: 'stablecoin-btc-lead-v1',
        status: 'unavailable',
        reason: `Aligned stablecoin and BTC histories are required (stablecoin rows: ${chart.length}, BTC points: ${btcPoints.length}).`,
      };
    }
    const supplyByDate = new Map();
    for (const row of chart) {
      const value = asNumber(row?.totalCirculating?.peggedUSD);
      if (!Number.isFinite(value) || !row.date) continue;
      const dateKey = /^\d+$/.test(String(row.date)) ? new Date(Number(row.date) * 1000).toISOString().slice(0, 10) : String(row.date).slice(0, 10);
      supplyByDate.set(dateKey, value);
    }
    const btcByDate = new Map();
    for (const point of btcPoints) btcByDate.set(String(point.timestamp).slice(0, 10), point.value);
    const dates = [...supplyByDate.keys()].sort().slice(-365);
    const supply = [];
    const btc = [];
    let lastBtc = null;
    for (const date of dates) {
      const btcValue = btcByDate.get(date) ?? lastBtc;
      if (Number.isFinite(btcValue)) {
        supply.push(supplyByDate.get(date));
        btc.push(btcValue);
      }
      lastBtc = Number.isFinite(btcByDate.get(date)) ? btcByDate.get(date) : lastBtc;
    }
    const weeklyChange = (series) => series.map((value, index) => (index >= 7 && series[index - 7] > 0 ? (value / series[index - 7] - 1) * 100 : null)).slice(7);
    const stableChanges = weeklyChange(supply);
    const btcChanges = weeklyChange(btc);
    const leadLag = calculateLeadLag(stableChanges, btcChanges, 7, 60, { rankBy: 'magnitude' });
    if (!leadLag) {
      return { asOf: new Date().toISOString(), version: 'stablecoin-btc-lead-v1', status: 'unavailable', reason: 'Not enough overlapping daily observations to estimate a lead.' };
    }
    const decisive = leadLag.corrAtBest >= 0.15;
    return {
      asOf: new Date().toISOString(),
      version: 'stablecoin-btc-lead-v1',
      status: 'calculated',
      synchronousCorr: leadLag.synchronousCorr,
      bestLagDays: leadLag.bestLag,
      corrAtBest: leadLag.corrAtBest,
      observations: leadLag.observations,
      read: !decisive ? 'No decisive lead' : leadLag.bestLag >= 2 ? 'Stablecoin supply leads price' : leadLag.bestLag <= -2 ? 'Price leads stablecoin supply' : 'Contemporaneous link',
      methodology: 'DefiLlama aggregate stablecoin supply against Yahoo BTC-USD closes, aligned by date over the trailing year. Seven-day percent changes are correlated at daily lags from -7 to +7; a positive lag means stablecoin supply moves first.',
    };
  });
}

// Every CoinGecko call routes through here so the host/header pairing and the
// optional key are applied identically.
function coingecko(path, params = {}) {
  return buildCoingeckoRequest(path, { apiKey: config.coingeckoApiKey, plan: config.coingeckoPlan, params });
}


export async function getCryptoGlobal() {
  return withCache('analytics:crypto-global', 30 * 60_000, async () => {
    const request = coingecko('/global');
    const [globalResult, quoteResult] = await Promise.allSettled([
      fetchJson(request.url, 0, 2, request.headers),
      getBitcoin(),
    ]);
    if (globalResult.status === 'rejected') throw globalResult.reason;
    const payload = globalResult.value;
    const bitcoinChange24hPct = quoteResult.status === 'fulfilled' ? asNumber(quoteResult.value?.changePercent) : null;
    const data = payload?.data ?? {};
    const dominance = data.market_cap_percentage ?? {};
    const totalMcap = asNumber(data.total_market_cap?.usd);
    if (!Number.isFinite(totalMcap)) throw new Error('CoinGecko global market data unavailable');
    return {
      asOf: new Date().toISOString(),
      version: 'crypto-global-v1',
      status: 'calculated',
      totalMcapUsd: totalMcap,
      mcapChange24hPct: asNumber(data.market_cap_change_percentage_24h_usd),
      btcDominance: asNumber(dominance.btc),
      ethDominance: asNumber(dominance.eth),
      totalVolumeUsd: asNumber(data.total_volume?.usd),
      rotation: calculateCryptoRotation({
        bitcoinChange24hPct: bitcoinChange24hPct ?? null,
        totalMarketCapChange24hPct: asNumber(data.market_cap_change_percentage_24h_usd),
        btcDominancePct: asNumber(dominance.btc),
        ethDominancePct: asNumber(dominance.eth),
      }),
      methodology: 'CoinGecko global aggregates: total crypto market capitalization, its 24-hour change, and BTC/ETH dominance shares.',
    };
  });
}

// 60-session emerging-market return minus the U.S. one. Negative means the U.S.
// is leading, which is the leg that separates the two dollar-bid scenarios.
async function getGlobalGrowthSpread() {
  return withCache('analytics:growth-spread', 6 * 3_600_000, async () => {
    const [globalResult, usResult] = await Promise.allSettled([getYahooHistory('EEM'), getYahooHistory('SPY')]);
    const changeOver60 = (result) => {
      if (result.status !== 'fulfilled') return null;
      const values = (result.value ?? []).map((point) => point.value).filter(Number.isFinite);
      if (values.length < 61) return null;
      const base = values.at(-61);
      return base > 0 ? ((values.at(-1) / base) - 1) * 100 : null;
    };
    const globalChange = changeOver60(globalResult);
    const usChange = changeOver60(usResult);
    return Number.isFinite(globalChange) && Number.isFinite(usChange)
      ? Number((globalChange - usChange).toFixed(2))
      : null;
  }).catch(() => null);
}

export async function getLiquiditySnapshot(options = {}) {
  return withCache('liquidity-snapshot', 15 * 60_000, async () => {
    const storedSeries = await getStoredFredSeries().catch(() => []);
    const results = await Promise.allSettled([...FRED_SERIES.map((series) => config.fredApiKey ? getFredSeries(series) : getFredCsvSeries(series)), getPbocAssets()]);
    const liveSeries = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const series = mergeFredSeries(liveSeries, storedSeries);
    const modelSeries = series.filter((item) => !item.stale);
    const staleSeries = series.filter((item) => item.stale);
    const staleLiveSeries = liveSeries.filter((item) => item.stale);
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason.message] : []);
    if (!config.fredApiKey && !storedSeries.length && !series.length) errors.push('FRED is unreachable and no stored observations are available');
    if (staleLiveSeries.length) errors.push(`Latest FRED responses are stale: ${staleLiveSeries.map((item) => item.id).join(', ')}`);
    if (staleSeries.length) errors.push(`FRED series are stale and excluded from models: ${staleSeries.map((item) => item.id).join(', ')}`);
    const values = Object.fromEntries(modelSeries.map((item) => [item.key, item.value * item.multiplier]));
    const model = calculateUsLiquidityModel(modelSeries);
    const globalLiquidity = calculateGlobalLiquidityModel(modelSeries);
    const liquidityRunway = calculateLiquidityRunway(modelSeries);
    const publishable = (candidate) => (isPublished(candidate) ? candidate : null);
    const usdStrength = calculateUsdStrengthModel(modelSeries, publishable(model));
    const macroRegime = calculateMacroRegimeModel(modelSeries, publishable(model), publishable(usdStrength), publishable(globalLiquidity));
    const dollarScenarios = calculateDollarScenarios(modelSeries, { growthSpread60d: await getGlobalGrowthSpread() });
    const stablecoins = await getStablecoinIssuance().catch(() => null);
    let narrative = null;
    if (isDatabaseConfigured()) {
      try {
        const [usOutputs, globalOutputs, heatmapOutputs, metalsOutputs, fxOutputs, sentimentOutputs, bitcoinOutputs, riskOutputs] = await Promise.all([
          getRecentModelOutputs('us-liquidity', 2),
          getRecentModelOutputs('global-liquidity', 2),
          getRecentModelOutputs('market-heatmap', 2).catch(() => []),
          getRecentModelOutputs('metals-workspace', 2).catch(() => []),
          getRecentModelOutputs('fx-workspace', 2).catch(() => []),
          getRecentModelOutputs('sentiment-snapshot', 2).catch(() => []),
          getRecentModelOutputs('bitcoin-cycle', 2).catch(() => []),
          getRecentModelOutputs('equity-risk', 2).catch(() => []),
        ]);
        narrative = buildLiquidityNarrative(usOutputs, globalOutputs);
        const workspaceNarrative = buildWorkspaceNarrative({
          'market-heatmap': heatmapOutputs,
          'metals-workspace': metalsOutputs,
          'fx-workspace': fxOutputs,
          'sentiment-snapshot': sentimentOutputs,
          'bitcoin-cycle': bitcoinOutputs,
          'equity-risk': riskOutputs,
        });
        if (workspaceNarrative.entries.length) {
          narrative = {
            status: narrative?.status === 'updated' || workspaceNarrative.status === 'updated' ? 'updated' : narrative?.status ?? workspaceNarrative.status,
            entries: [...(narrative?.entries ?? []), ...workspaceNarrative.entries],
          };
        }
      } catch {
        narrative = null;
      }
    }

    return {
      asOf: new Date().toISOString(),
      provider: { configured: true, mode: config.fredApiKey ? 'api' : 'public-csv', name: 'FRED', storedFallbacks: series.filter((item) => item.stored).length, staleSeries: staleSeries.length },
      series,
      // One net-liquidity number, and it is the date-aligned one the model
      // publishes. Subtracting each series' own latest value gave a second,
      // different figure for the same quantity whenever the weekly Fed print
      // and the daily TGA/RRP prints landed on different days.
      netLiquidity: model?.netLiquidity ?? null,
      model,
      liquidityRunway,
      globalLiquidity,
      usdStrength,
      macroRegime,
      dollarScenarios,
      stablecoins,
      narrative,
      errors,
    };
  }, { force: options.refresh === true });
}

export function calculateDollarTransmission(liquidity, dxyBtc) {
  // An unavailable dollar model still carries its raw indicators. Reading
  // momentum off one that failed its own coverage threshold would let the
  // transmission publish a direction the model itself declined to publish.
  const usdStrength = isPublished(liquidity?.usdStrength) ? liquidity.usdStrength : null;
  const corr60 = dxyBtc?.model?.correlations?.['60D'];
  const read = calculateDollarTransmissionRead({
    usdMomentum: usdStrength?.indicators?.momentum20d ?? null,
    usdScore: usdStrength?.score ?? null,
    corr60: Number.isFinite(corr60) ? corr60 : null,
  });
  return {
    asOf: new Date().toISOString(),
    version: 'dollar-transmission-v1',
    status: read.status,
    tailwindLabel: read.label,
    tailwindScore: read.score,
    dollarWeakness: read.dollarWeakness,
    linkSign: read.linkSign,
    linkStrength: read.linkStrength,
    reason: read.reason,
    corr60: Number.isFinite(corr60) ? Math.round(corr60 * 100) / 100 : null,
    linkRegime: dxyBtc?.model?.regime ?? null,
  };
}

export function getProviderHealth() {
  return {
    fred: { configured: Boolean(config.fredApiKey), mode: config.fredApiKey ? 'credentialed' : 'keyless-public-csv', purpose: 'Official U.S. macro and liquidity series' },
    twelveData: {
      configured: Boolean(config.twelveDataApiKey),
      mode: config.twelveDataApiKey ? 'credentialed' : 'not-configured',
      purpose: 'Equities, ETFs, FX, and metals proxies',
      limits: { creditsPerMinute: config.twelveMinuteCreditLimit, creditsPerDay: config.twelveDailyCreditLimit },
    },
    yahooSpark: { configured: true, mode: 'keyless-public', purpose: 'Batch daily and intraday closes for the screener, breadth, sectors, crypto pairs, and VIX term structure' },
    wikipedia: { configured: true, mode: 'keyless-public', purpose: 'S&P 500 constituent universe' },
    coingecko: { configured: true, mode: config.coingeckoApiKey ? `credentialed-${config.coingeckoPlan}` : 'keyless-public', purpose: 'Bitcoin on-chain proxies and global market aggregates (dominance, total capitalization)' },
    defiLlama: { configured: true, mode: 'keyless-public', purpose: 'Aggregate stablecoin supply history for the issuance liquidity leg' },
    binanceBybit: { configured: true, mode: 'keyless-public', purpose: 'Perpetual funding rates, open-interest history, and BTC cycle derivatives legs' },
    bitcoinData: { configured: true, mode: 'keyless-public', serialized: true, purpose: 'MVRV Z-score and short-term holder realized price' },
    cftc: { configured: true, mode: config.cftcAppToken ? 'app-token' : 'keyless-public', purpose: 'Commitments of Traders positioning for equities, FX, and metals' },
    multpl: { configured: true, mode: 'keyless-public', purpose: 'Trailing S&P 500 earnings yield for the equity risk-premium proxy' },
    rssWires: { configured: true, mode: 'keyless-public', purpose: 'Federal Reserve, CNBC, and MarketWatch headlines for the news wire' },
  };
}

export function getBlockedSources() {
  return [
    { source: 'Farside UK', reason: 'Cloudflare 403', preview: 'Spot bitcoin ETF flows' },
    { source: 'CBOE / cdn.cboe.com', reason: 'Akamai 403', preview: 'Dealer gamma and options positioning' },
    { source: 'Coin Metrics community API', reason: '403', preview: 'Institutional on-chain series' },
    { source: 'AAII', reason: 'Paywall', preview: 'Sentiment survey' },
  ];
}
