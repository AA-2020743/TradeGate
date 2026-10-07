import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The bitcoin workspace as a US server sees it: Binance answers 451 and Bybit
 * 403, so only OKX speaks. The funding and positioning legs must both publish
 * from OKX, and name the venues that did not answer.
 */
const DAY = 86_400_000;
const NOW = Date.now();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function yahoo(days) {
  const timestamp = Array.from({ length: days }, (_, index) => Math.floor((NOW - ((days - index) * DAY)) / 1000));
  const close = timestamp.map((_, index) => 60000 + (index * 10));
  return json({ chart: { result: [{ timestamp, indicators: { quote: [{ open: close, high: close.map((value) => value * 1.01), low: close.map((value) => value * 0.99), close, volume: close.map(() => 1000) }] } }] } });
}

function okxRoute(url) {
  if (url.pathname.endsWith('/public/funding-rate')) return json({ code: '0', data: [{ fundingRate: '0.0001' }] });
  if (url.pathname.endsWith('/public/funding-rate-history')) {
    const after = Number(url.searchParams.get('after') ?? NOW);
    return json({ code: '0', data: Array.from({ length: 100 }, (_, index) => ({ fundingRate: String(0.00005 + ((index % 10) * 0.00001)), fundingTime: String(after - ((index + 1) * 8 * 3600_000)) })) });
  }
  if (url.pathname.endsWith('/rubik/stat/contracts/open-interest-volume')) {
    return json({ code: '0', data: Array.from({ length: 30 }, (_, index) => [String(Date.UTC(2026, 8, 1) + (index * DAY)), String(5e9 + (index * 1e8)), '0']) });
  }
  if (url.pathname.endsWith('/market/candles')) {
    return json({ code: '0', data: Array.from({ length: 30 }, (_, index) => [String(Date.UTC(2026, 8, 1) + (index * DAY)), '0', '0', '0', String(60000 + (index * 300))]) });
  }
  return json({ code: '51000', msg: 'unexpected', data: [] });
}

test('with Binance and Bybit refusing the server, OKX carries funding and positioning', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    if (url.hostname === 'fapi.binance.com') return json({ code: 0, msg: 'Service unavailable from a restricted location' }, 451);
    if (url.hostname === 'api.bybit.com') return new Response('<html>CloudFront</html>', { status: 403 });
    if (url.hostname === 'www.okx.com') return okxRoute(url);
    if (url.hostname === 'query1.finance.yahoo.com') return yahoo(url.searchParams.get('range') === '10y' ? 3000 : 1500);
    return new Response('blocked', { status: 503 });
  };
  try {
    const { getBitcoinCycleWorkspace } = await import('./providers.js');
    const workspace = await getBitcoinCycleWorkspace();
    const legs = Object.fromEntries((workspace.legs ?? []).map((leg) => [leg.key ?? leg.name, leg]));
    const leverage = workspace.leverage ?? Object.values(legs).find((leg) => 'aggregate8h' in (leg ?? {}));
    const positioning = workspace.positioning ?? Object.values(legs).find((leg) => 'quadrant' in (leg ?? {}));
    assert.ok(leverage, 'funding leg present');
    assert.equal(leverage.status, 'calculated');
    assert.equal(leverage.venues, 1);
    assert.equal(leverage.okxRate, 0.0001);
    assert.equal(leverage.historyVenue, 'OKX');
    assert.match(leverage.note, /Not answering: binance, bybit/);
    assert.doesNotMatch(leverage.note, /Binance history/);
    assert.ok(positioning, 'positioning leg present');
    assert.equal(positioning.status, 'calculated');
    assert.equal(positioning.venue, 'OKX');
    assert.match(positioning.fallbackReason, /451/);
  } finally {
    globalThis.fetch = original;
  }
});
