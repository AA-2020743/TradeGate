import { config } from './config.js';
import { withCache } from './cache.js';

const TWELVE_SYMBOLS = [
  { symbol: 'SPY', key: 'SPY', name: 'S&P 500 proxy', kind: 'ETF' },
  { symbol: 'QQQ', key: 'QQQ', name: 'Nasdaq 100 proxy', kind: 'ETF' },
  { symbol: 'GLD', key: 'GLD', name: 'Gold proxy', kind: 'ETF' },
  { symbol: 'NVDA', key: 'NVDA', name: 'NVIDIA Corp.', kind: 'Equity' },
  { symbol: 'AAPL', key: 'AAPL', name: 'Apple Inc.', kind: 'Equity' },
];

const FRED_SERIES = [
  { id: 'WALCL', key: 'fedBalanceSheet', name: 'Fed balance sheet', unit: 'USD millions', multiplier: 1 },
  { id: 'WTREGEN', key: 'treasuryGeneralAccount', name: 'Treasury General Account', unit: 'USD millions', multiplier: 1 },
  { id: 'RRPONTSYD', key: 'reverseRepo', name: 'Overnight reverse repo', unit: 'USD billions', multiplier: 1000 },
  { id: 'M2SL', key: 'usM2', name: 'US M2', unit: 'USD billions', multiplier: 1000 },
  { id: 'DTWEXBGS', key: 'dxy', name: 'Broad dollar index', unit: 'Index', multiplier: 1 },
];

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'TradeGateResearch/0.1' },
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) throw new Error(`Upstream request failed with ${response.status}`);
  return response.json();
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

const HISTORY_SYMBOLS = new Set(['BTC', ...TWELVE_SYMBOLS.map((asset) => asset.symbol)]);

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTwelveQuote(payload, symbol) {
  const quote = payload[symbol] ?? payload.data?.[symbol] ?? payload.data?.find?.((item) => item.symbol === symbol);
  if (!quote || quote.code) return null;

  const price = asNumber(quote.close ?? quote.price);
  const changePercent = asNumber(quote.percent_change ?? quote.change_percent);
  if (price === null) return null;

  return { price, changePercent, asOf: quote.datetime ?? quote.timestamp ?? null };
}

async function getBitcoin() {
  const payload = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true');
  const bitcoin = payload.bitcoin;
  if (!bitcoin?.usd) throw new Error('CoinGecko did not return a Bitcoin quote');

  return {
    key: 'BTC',
    symbol: 'BTC',
    name: 'Bitcoin',
    kind: 'Crypto',
    price: bitcoin.usd,
    changePercent: bitcoin.usd_24h_change ?? null,
    asOf: bitcoin.last_updated_at ? new Date(bitcoin.last_updated_at * 1000).toISOString() : null,
    source: 'CoinGecko',
  };
}

async function getTwelveQuotes() {
  if (!config.twelveDataApiKey) return [];

  const symbols = TWELVE_SYMBOLS.map((asset) => asset.symbol).join(',');
  const url = new URL('https://api.twelvedata.com/quote');
  url.searchParams.set('symbol', symbols);
  url.searchParams.set('apikey', config.twelveDataApiKey);
  const payload = await fetchJson(url);

  return TWELVE_SYMBOLS.flatMap((asset) => {
    const quote = parseTwelveQuote(payload, asset.symbol);
    return quote ? [{ ...asset, ...quote, source: 'Twelve Data' }] : [];
  });
}

export async function getMarketSnapshot() {
  return withCache('market-snapshot', 30_000, async () => {
    const results = await Promise.allSettled([getBitcoin(), getTwelveQuotes()]);
    const assets = [];
    const errors = [];

    if (results[0].status === 'fulfilled') assets.push(results[0].value);
    else errors.push({ provider: 'CoinGecko', message: results[0].reason.message });

    if (results[1].status === 'fulfilled') assets.push(...results[1].value);
    else errors.push({ provider: 'Twelve Data', message: results[1].reason.message });

    return {
      asOf: new Date().toISOString(),
      assets,
      errors,
      providers: {
        coingecko: { configured: true, mode: 'public' },
        twelveData: { configured: Boolean(config.twelveDataApiKey), mode: config.twelveDataApiKey ? 'credentialed' : 'not-configured' },
      },
    };
  });
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

async function getTwelveHistory(symbol, range) {
  if (!config.twelveDataApiKey) return [];

  const settings = HISTORY_RANGES[range];
  const url = new URL('https://api.twelvedata.com/time_series');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', settings.interval);
  url.searchParams.set('outputsize', settings.outputsize);
  url.searchParams.set('order', 'ASC');
  url.searchParams.set('apikey', config.twelveDataApiKey);
  const payload = await fetchJson(url);

  if (payload.status === 'error') throw new Error(payload.message ?? 'Twelve Data history request failed');
  return (payload.values ?? []).flatMap((item) => {
    const value = asNumber(item.close);
    const isoTimestamp = item.datetime.includes(' ')
      ? `${item.datetime.replace(' ', 'T')}Z`
      : `${item.datetime}T00:00:00Z`;
    return value === null ? [] : [{ timestamp: new Date(isoTimestamp).toISOString(), value }];
  });
}

export async function getMarketHistory(symbol, requestedRange) {
  const normalizedSymbol = symbol.toUpperCase();
  const range = HISTORY_RANGES[requestedRange] ? requestedRange : '1M';
  if (!HISTORY_SYMBOLS.has(normalizedSymbol)) throw new Error(`Unsupported history symbol: ${normalizedSymbol}`);

  return withCache(`history:${normalizedSymbol}:${range}`, 60_000, async () => {
    const points = normalizedSymbol === 'BTC'
      ? await getBitcoinHistory(range)
      : await getTwelveHistory(normalizedSymbol, range);

    return {
      symbol: normalizedSymbol,
      range,
      asOf: new Date().toISOString(),
      source: normalizedSymbol === 'BTC' ? 'CoinGecko' : 'Twelve Data',
      configured: normalizedSymbol === 'BTC' || Boolean(config.twelveDataApiKey),
      points,
    };
  });
}

async function getFredSeries(series) {
  const url = new URL('https://api.stlouisfed.org/fred/series/observations');
  url.searchParams.set('series_id', series.id);
  url.searchParams.set('api_key', config.fredApiKey);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('sort_order', 'desc');
  url.searchParams.set('limit', '12');
  const payload = await fetchJson(url);
  const observation = payload.observations?.find((item) => item.value !== '.');
  const value = asNumber(observation?.value);

  if (!observation || value === null) throw new Error(`FRED returned no usable observation for ${series.id}`);
  return { ...series, value, date: observation.date };
}

export async function getLiquiditySnapshot() {
  if (!config.fredApiKey) {
    return {
      asOf: new Date().toISOString(),
      provider: { configured: false, name: 'FRED' },
      series: [],
      netLiquidity: null,
    };
  }

  return withCache('liquidity-snapshot', 15 * 60_000, async () => {
    const results = await Promise.allSettled(FRED_SERIES.map(getFredSeries));
    const series = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason.message] : []);
    const values = Object.fromEntries(series.map((item) => [item.key, item.value * item.multiplier]));
    const hasNetLiquidityInputs = ['fedBalanceSheet', 'treasuryGeneralAccount', 'reverseRepo'].every((key) => values[key] !== undefined);

    return {
      asOf: new Date().toISOString(),
      provider: { configured: true, name: 'FRED' },
      series,
      netLiquidity: hasNetLiquidityInputs ? values.fedBalanceSheet - values.treasuryGeneralAccount - values.reverseRepo : null,
      errors,
    };
  });
}

export function getProviderHealth() {
  return {
    coingecko: { configured: true, mode: 'public', purpose: 'Crypto spot data' },
    twelveData: { configured: Boolean(config.twelveDataApiKey), mode: config.twelveDataApiKey ? 'credentialed' : 'not-configured', purpose: 'Equities, ETFs, FX, and metals proxies' },
    fred: { configured: Boolean(config.fredApiKey), mode: config.fredApiKey ? 'credentialed' : 'not-configured', purpose: 'Official U.S. macro and liquidity series' },
  };
}
