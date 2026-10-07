import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Twelve Data carries no indices: asked for DXY it answers "symbol not
 * found", and the quote request still bills the credit. The dollar index is
 * read from Yahoo as DX-Y.NYB instead, and never sent to Twelve Data.
 */
process.env.TWELVE_DATA_API_KEY = 'test-key';
process.env.DATABASE_URL = '';

const DAY = 86_400_000;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const requests = [];

function yahooCloses(closes) {
  const now = Date.now();
  const timestamp = closes.map((_value, index) => Math.floor((now - ((closes.length - 1 - index) * DAY)) / 1000));
  return json({ chart: { result: [{ timestamp, indicators: { quote: [{ close: closes }] } }] } });
}

globalThis.fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  requests.push(url);
  if (url.hostname === 'api.twelvedata.com' && url.pathname === '/quote') {
    const symbols = url.searchParams.get('symbol').split(',');
    return json(Object.fromEntries(symbols.map((symbol) => [symbol, symbol === 'DXY'
      ? { code: 404, status: 'error', message: '**symbol** not found: DXY' }
      : { symbol, close: '100', percent_change: '0.5', datetime: new Date().toISOString().slice(0, 10) }])));
  }
  if (url.hostname === 'query1.finance.yahoo.com' && url.pathname.endsWith('/DX-Y.NYB')) {
    return yahooCloses(Array.from({ length: 300 }, (_value, index) => (index === 299 ? 101 : 100)));
  }
  if (url.hostname.includes('coingecko')) return json({ bitcoin: { usd: 60000, usd_24h_change: 1, last_updated_at: Math.floor(Date.now() / 1000) } });
  return new Response('blocked', { status: 503 });
};

const { getMarketHistory, getMarketSnapshot } = await import('./providers.js');

test('the quote board reads the dollar index from Yahoo and never asks Twelve Data for it', async () => {
  const snapshot = await getMarketSnapshot();
  const twelveQuote = requests.find((url) => url.hostname === 'api.twelvedata.com' && url.pathname === '/quote');
  assert.ok(twelveQuote, 'the other symbols still go to Twelve Data');
  assert.ok(!twelveQuote.searchParams.get('symbol').split(',').includes('DXY'), 'DXY is not sent to Twelve Data');
  const dollar = snapshot.assets.find((asset) => asset.key === 'DXY');
  assert.ok(dollar, `DXY is on the board; errors: ${JSON.stringify(snapshot.errors)}`);
  assert.equal(dollar.source, 'Yahoo Finance');
  assert.equal(dollar.price, 101);
  assert.equal(dollar.changePercent, 1);
  assert.ok(!snapshot.errors.some((error) => /not found: DXY/.test(error.message ?? '')));
});

test('dollar index history comes from Yahoo’s DX-Y.NYB, not a Twelve Data series', async () => {
  const before = requests.length;
  const history = await getMarketHistory('DXY', '1Y');
  assert.equal(history.source, 'Yahoo Finance');
  assert.ok(history.points.length > 200);
  const made = requests.slice(before);
  assert.ok(made.some((url) => url.pathname.endsWith('/DX-Y.NYB')));
  assert.ok(!made.some((url) => url.hostname === 'api.twelvedata.com'), 'no Twelve Data request for DXY history');
});
