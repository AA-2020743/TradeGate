import test from 'node:test';
import assert from 'node:assert/strict';
import { alignedRatioSeries, calculateTwelveCreditSlot, heatmapSymbols, mergeFredSeries, mergeMarketSnapshot, parseRssItems, percentileOf, smaOf, supportsHistorySymbol } from './providers.js';
import { buildSocrataRequest } from './analytics.js';

test('simple moving average requires the full window', () => {
  assert.equal(smaOf([1, 2, 3], 3), 2);
  assert.equal(smaOf([1, 2], 3), null);
  assert.equal(smaOf([], 1), null);
});

test('percentile ranks a value within its history', () => {
  assert.equal(percentileOf([1, 2, 3, 4], 3), 75);
  assert.equal(percentileOf([], 3), null);
  assert.equal(percentileOf([1, 2], Number.NaN), null);
});

test('ratio series aligns unequal-length histories from the tail', () => {
  const left = [10, 20, 30, 40];
  const right = [2, 2];
  assert.deepEqual(alignedRatioSeries(left, right), [15, 20]);
});

test('RSS parser extracts titles, links, and timestamps', () => {
  const xml = '<rss><channel><item><title><![CDATA[Fed releases statement]]></title><link>https://federalreserve.gov/a</link><pubDate>Thu, 20 Aug 2026 18:00:00 GMT</pubDate></item><item><title>Plain title</title><link>https://example.com/b</link></item></channel></rss>';
  const items = parseRssItems(xml, 'Federal Reserve');
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Fed releases statement');
  assert.equal(items[0].source, 'Federal Reserve');
  assert.equal(items[0].publishedAt, '2026-08-20T18:00:00.000Z');
  assert.equal(items[1].publishedAt, null);
});

test('Twelve Data credit scheduling allows a bounded burst', () => {
  const reservations = [
    { at: 1_000, credits: 6 },
    { at: 1_000, credits: 1 },
  ];
  assert.equal(calculateTwelveCreditSlot(reservations, 1_000, 1, 8), 1_000);
});

test('Twelve Data credit scheduling waits for the rolling minute to clear', () => {
  const reservations = [
    { at: 1_000, credits: 6 },
    { at: 1_000, credits: 1 },
    { at: 1_000, credits: 1 },
  ];
  assert.equal(calculateTwelveCreditSlot(reservations, 1_000, 1, 8), 61_000);
});

test('partial market refresh retains only failed-provider cached assets', () => {
  const previous = {
    assets: [
      { key: 'BTC', symbol: 'BTC', source: 'CoinGecko', price: 100, asOf: '2026-08-21T10:00:00.000Z' },
      { key: 'SPY', symbol: 'SPY', source: 'Twelve Data', price: 500, asOf: '2026-08-21T10:00:00.000Z' },
    ],
  };
  const next = {
    assets: [{ key: 'BTC', symbol: 'BTC', source: 'CoinGecko', price: 101, asOf: '2026-08-21T10:05:00.000Z' }],
    errors: [{ provider: 'Twelve Data', message: 'Unavailable' }],
  };
  const merged = mergeMarketSnapshot(previous, next);
  assert.equal(merged.assets.find((asset) => asset.key === 'BTC').price, 101);
  assert.equal(merged.assets.find((asset) => asset.key === 'SPY').price, 500);
  assert.equal(merged.assets.find((asset) => asset.key === 'SPY').stale, true);
  assert.equal(merged.assets.find((asset) => asset.key === 'SPY').cached, true);
});

test('stale successful quote does not replace a fresher cached quote', () => {
  const previous = {
    assets: [{ key: 'SPY', symbol: 'SPY', source: 'Twelve Data', price: 500, asOf: '2026-08-20T00:00:00.000Z' }],
  };
  const next = {
    assets: [{ key: 'SPY', symbol: 'SPY', source: 'Twelve Data', price: 450, asOf: '2026-08-01T00:00:00.000Z', stale: true }],
    errors: [{ provider: 'Twelve Data', symbol: 'SPY', message: 'Quote timestamp is stale' }],
  };
  const merged = mergeMarketSnapshot(previous, next);
  assert.equal(merged.assets.length, 1);
  assert.equal(merged.assets[0].price, 500);
  assert.equal(merged.assets[0].cached, true);
});

test('stale live FRED response does not replace a fresh stored series', () => {
  const stored = { id: 'VIXCLS', key: 'vix', date: '2026-08-20', value: 15, stored: true, stale: false };
  const live = { id: 'VIXCLS', key: 'vix', date: '2026-08-01', value: 30, stored: false, stale: true };
  assert.equal(mergeFredSeries([live], [stored])[0], stored);
});

test('a Socrata request carries the app token, and stays usable without one', () => {
  // The token buys a private rate budget on a dataset Socrata already serves
  // anonymously. That is why a rejected token must fall back rather than fail:
  // pasting the Secret Token instead of the App Token turned a working keyless
  // feed into a 403 and took positioning down platform-wide.
  const withToken = buildSocrataRequest('publicreporting.cftc.gov', 'abcd-1234', { appToken: 'tok', params: { $limit: '5' } });
  assert.equal(withToken.authenticated, true);
  assert.deepEqual(withToken.headers, { 'X-App-Token': 'tok' });

  const anonymous = buildSocrataRequest('publicreporting.cftc.gov', 'abcd-1234', { params: { $limit: '5' } });
  assert.equal(anonymous.authenticated, false);
  assert.equal(anonymous.headers, null);
  // Same URL either way: the credential never changes what is asked for.
  assert.equal(anonymous.url, withToken.url);

  // Whitespace around a pasted token must not make it look configured.
  assert.equal(buildSocrataRequest('h', 'd', { appToken: '   ' }).authenticated, false);
});

test('every market the heatmap scores can be loaded by the history loader', () => {
  // SLV sat in the heatmap universe without being loadable, so its row
  // failed on every request and the cross-check could never reach it.
  const unsupported = heatmapSymbols().filter((symbol) => !supportsHistorySymbol(symbol));
  assert.deepEqual(unsupported, []);
});

test('every market the heatmap scores is stored by the daily history job', async () => {
  // Unstored symbols are fetched live on each 15-minute heatmap refresh and
  // drain the interactive Twelve Data budget.
  const { getIngestionHistorySymbols } = await import('./providers.js');
  const stored = new Set(getIngestionHistorySymbols());
  assert.deepEqual(heatmapSymbols().filter((symbol) => !stored.has(symbol)), []);
});

test('a symbol spark returns short or not at all is fetched by date range from the chart endpoint', async () => {
  const { getLongDailyHistories } = await import('./providers.js');
  const stamps = (count) => Array.from({ length: count }, (_unused, index) => Math.floor(Date.UTC(2016, 0, 4) / 1000) + index * 86_400);
  const original = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    const text = String(url);
    requested.push(text);
    const body = text.includes('/spark')
      // AAA comes back with a year of closes, BBB not at all.
      ? { spark: { result: [{ symbol: 'AAA', response: [{ timestamp: stamps(300), indicators: { quote: [{ close: stamps(300).map(() => 10) }] } }] }] } }
      : { chart: { result: [{ timestamp: stamps(2600), indicators: { quote: [{ close: stamps(2600).map(() => 20) }] } }] } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const histories = await getLongDailyHistories(['AAA', 'BBB'], 10);
    assert.equal(histories.get('AAA').length, 2600);
    assert.equal(histories.get('BBB').length, 2600);
    assert.deepEqual(histories.fetchedByDateRange, ['AAA', 'BBB']);
    assert.ok(requested.some((url) => url.includes('/v8/finance/chart/AAA?period1=')));
  } finally {
    globalThis.fetch = original;
  }
});

test('every chart range the app asks for is served as itself', async () => {
  const { normalizeHistoryRange } = await import('./providers.js');
  // Watchlist rows ask for '3M'; it used to be read as '1M', so their
  // three-month change was a one-month change.
  for (const range of ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', 'All']) assert.equal(normalizeHistoryRange(range), range);
  assert.equal(normalizeHistoryRange('10Y'), '1M');
  assert.equal(normalizeHistoryRange(undefined), '1M');
});

test('every external host the server calls is listed, named, as a provider', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { getProviderHealth } = await import('./providers.js');
  const providers = getProviderHealth();
  for (const [key, provider] of Object.entries(providers)) {
    assert.ok(provider.name && provider.purpose && provider.mode, `${key} needs a name, purpose and mode`);
  }
  // The list once covered eleven of eighteen hosts. A new source has to be
  // added here and to the provider list, or this fails.
  const owner = {
    'query1.finance.yahoo.com': 'yahooSpark', 'publicreporting.cftc.gov': 'cftc', 'api.coingecko.com': 'coingecko',
    'pro-api.coingecko.com': 'coingecko', 'stablecoins.llama.fi': 'defiLlama', 'fapi.binance.com': 'binanceBybit',
    'www.okx.com': 'binanceBybit', 'api.bybit.com': 'binanceBybit', 'shillerdata.com': 'shiller', 'bitcoin-data.com': 'bitcoinData',
    'api.twelvedata.com': 'twelveData', 'api.stlouisfed.org': 'fred', 'fred.stlouisfed.org': 'fred', 'www.multpl.com': 'multpl',
    'www.federalreserve.gov': 'rssWires', 'search.cnbc.com': 'rssWires', 'feeds.content.dowjones.io': 'rssWires',
    'www.deribit.com': 'deribit', 'stats.bis.org': 'bis', 'api.db.nomics.world': 'bis', 'production.dataviz.cnn.io': 'cnnFearGreed',
    'edition.cnn.com': 'cnnFearGreed', 'mba.tuck.dartmouth.edu': 'frenchLibrary', 'en.wikipedia.org': 'wikipedia',
    'api.fiscaldata.treasury.gov': 'treasuryFiscal',
  };
  const ignored = new Set(['example.com', 'evil.example', 'research.example.com', 'fonts.googleapis.com', 'fonts.gstatic.com']);
  const directory = new URL('.', import.meta.url);
  const hosts = new Set();
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))) {
    for (const match of readFileSync(new URL(file, directory), 'utf8').matchAll(/https:\/\/([a-zA-Z0-9.-]+)/g)) hosts.add(match[1]);
  }
  for (const host of hosts) {
    if (ignored.has(host)) continue;
    assert.ok(owner[host], `${host} is called but not attributed to a provider`);
    assert.ok(providers[owner[host]], `${host} belongs to ${owner[host]}, which the provider list does not have`);
  }
});
