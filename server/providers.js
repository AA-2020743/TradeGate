import { config } from './config.js';
import { withCache } from './cache.js';
import { buildLiquidityNarrative, calculateChangeCorrelations, calculateCrossMarketRelationship, calculateGlobalLiquidityModel, calculateMacroRegimeModel, calculateTechnicalSnapshot, calculateUsdStrengthModel, calculateUsLiquidityModel } from './analytics.js';
import { getStoredFredSeries, getStoredMarketHistory, getStoredMarketSnapshot, getRecentModelOutputs, isDatabaseConfigured, reserveProviderCredits } from './database.js';
import { getAllEquityHistorySymbols, getCoreEquityHistorySymbols } from './equityCatalog.js';
import { isCryptoHistoryStale, isDailyCloseStale, isFredSeriesStale } from './freshness.js';

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
];

let twelveLimiterQueue = Promise.resolve();
let twelveCreditReservations = [];
const inMemoryDailyUsage = new Map();

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchJson(url, attempt = 0, maxRetries = 2) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'TradeGateResearch/0.1' },
    signal: AbortSignal.timeout(12_000),
  });

  if (response.status === 429 && attempt < maxRetries) {
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
    await wait(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 30_000) : 5_000 * (attempt + 1));
    return fetchJson(url, attempt + 1, maxRetries);
  }
  if (!response.ok) throw new Error(`Upstream request failed with ${response.status}`);
  return response.json();
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

const HISTORY_SYMBOLS = new Set(['BTC', ...TWELVE_SYMBOLS.map((asset) => asset.symbol), ...getAllEquityHistorySymbols()]);
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
  const payload = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true');
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
  return FRED_SERIES.flatMap((definition) => seriesByKey.has(definition.key) ? [seriesByKey.get(definition.key)] : []);
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
        coingecko: { configured: true, mode: 'public' },
        twelveData: { configured: Boolean(config.twelveDataApiKey), mode: config.twelveDataApiKey ? 'credentialed' : 'not-configured' },
      },
    };
  }, { force: options.refresh === true, merge: mergeMarketSnapshot });
}

async function getBitcoinHistory(range) {
  const settings = HISTORY_RANGES[range];
  const url = new URL('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart');
  url.searchParams.set('vs_currency', 'usd');
  url.searchParams.set('days', settings.days);
  const payload = await fetchJson(url);

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

export function getSupportedHistorySymbols() {
  return [...HISTORY_SYMBOLS];
}

export function getIngestionHistorySymbols() {
  return [...INGESTION_HISTORY_SYMBOLS];
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
    try {
      points = normalizedSymbol === 'BTC'
        ? await getBitcoinHistory(range)
        : await getTwelveHistory(normalizedSymbol, range, options.usage);
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
      source: providerError ? 'PostgreSQL (last known good)' : normalizedSymbol === 'BTC' ? 'CoinGecko' : 'Twelve Data',
      configured: normalizedSymbol === 'BTC' || Boolean(config.twelveDataApiKey),
      stored: Boolean(providerError),
      stale,
      points,
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
    const bitcoinPromise = getMarketHistory('BTC', '1Y');
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

    const bitcoin = await bitcoinPromise;
    const model = dollarPoints.length && !bitcoin.stale ? calculateCrossMarketRelationship(dollarPoints, bitcoin.points) : null;
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
      return {
        key: pair.key,
        left: pair.leftName,
        right: pair.rightName,
        note: pair.note,
        status: result ? 'calculated' : 'unavailable',
        correlations: result?.correlations ?? { '20D': null, '60D': null, '1Y': null },
        observations: result?.observations ?? 0,
        asOf: result?.asOf ?? null,
      };
    });
    const calculatedCount = pairs.filter((pair) => pair.status === 'calculated').length;

    return {
      version: 'regime-correlation-v1',
      asOf: new Date().toISOString(),
      status: calculatedCount ? 'calculated' : 'unavailable',
      coverage: Math.round((calculatedCount / pairs.length) * 100),
      calculatedCount,
      pairs,
      missingInputs: pairs.filter((pair) => pair.status === 'unavailable').map((pair) => `${pair.left} / ${pair.right}`),
    };
  });
}

async function getFredSeries(series) {
  const url = new URL('https://api.stlouisfed.org/fred/series/observations');
  url.searchParams.set('series_id', series.id);
  url.searchParams.set('api_key', config.fredApiKey);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('sort_order', 'desc');
  url.searchParams.set('limit', '400');
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
    history: observations.map((item) => ({
      date: item.date,
      value: Number(item.value),
      realtimeStart: item.realtime_start ?? null,
      realtimeEnd: item.realtime_end ?? null,
    })).reverse(),
  };
}

export async function getLiquiditySnapshot(options = {}) {
  return withCache('liquidity-snapshot', 15 * 60_000, async () => {
    const storedSeries = await getStoredFredSeries().catch(() => []);
    const results = config.fredApiKey ? await Promise.allSettled(FRED_SERIES.map(getFredSeries)) : [];
    const liveSeries = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const series = mergeFredSeries(liveSeries, storedSeries);
    const modelSeries = series.filter((item) => !item.stale);
    const staleSeries = series.filter((item) => item.stale);
    const staleLiveSeries = liveSeries.filter((item) => item.stale);
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason.message] : []);
    if (!config.fredApiKey && !storedSeries.length) errors.push('FRED_API_KEY is not configured and no stored observations are available');
    if (staleLiveSeries.length) errors.push(`Latest FRED responses are stale: ${staleLiveSeries.map((item) => item.id).join(', ')}`);
    if (staleSeries.length) errors.push(`FRED series are stale and excluded from models: ${staleSeries.map((item) => item.id).join(', ')}`);
    const values = Object.fromEntries(modelSeries.map((item) => [item.key, item.value * item.multiplier]));
    const hasNetLiquidityInputs = ['fedBalanceSheet', 'treasuryGeneralAccount', 'reverseRepo'].every((key) => values[key] !== undefined);
    const model = calculateUsLiquidityModel(modelSeries);
    const globalLiquidity = calculateGlobalLiquidityModel(modelSeries);
    const usdStrength = calculateUsdStrengthModel(modelSeries, model);
    const macroRegime = calculateMacroRegimeModel(modelSeries, model, usdStrength);
    let narrative = null;
    if (isDatabaseConfigured()) {
      try {
        const [usOutputs, globalOutputs] = await Promise.all([
          getRecentModelOutputs('us-liquidity', 2),
          getRecentModelOutputs('global-liquidity', 2),
        ]);
        narrative = buildLiquidityNarrative(usOutputs, globalOutputs);
      } catch {
        narrative = null;
      }
    }

    return {
      asOf: new Date().toISOString(),
      provider: { configured: Boolean(config.fredApiKey), name: 'FRED', storedFallbacks: series.filter((item) => item.stored).length, staleSeries: staleSeries.length },
      series,
      netLiquidity: hasNetLiquidityInputs ? values.fedBalanceSheet - values.treasuryGeneralAccount - values.reverseRepo : null,
      model,
      globalLiquidity,
      usdStrength,
      macroRegime,
      narrative,
      errors,
    };
  }, { force: options.refresh === true });
}

export function getProviderHealth() {
  return {
    coingecko: { configured: true, mode: 'public', purpose: 'Crypto spot data' },
    twelveData: {
      configured: Boolean(config.twelveDataApiKey),
      mode: config.twelveDataApiKey ? 'credentialed' : 'not-configured',
      purpose: 'Equities, ETFs, FX, and metals proxies',
      limits: { creditsPerMinute: config.twelveMinuteCreditLimit, creditsPerDay: config.twelveDailyCreditLimit },
    },
    fred: { configured: Boolean(config.fredApiKey), mode: config.fredApiKey ? 'credentialed' : 'not-configured', purpose: 'Official U.S. macro and liquidity series' },
  };
}
