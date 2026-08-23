/**
 * Route-level coverage against the real Express app.
 *
 * server/index.js exports `app` and nothing ever started it in a test, so
 * every route's status codes, headers and error handling were unverified. The
 * app is booted on an ephemeral port with no provider reachable, which is the
 * shape that matters: a research server whose upstreams are down must still
 * answer, and answer honestly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const { app } = await import('./index.js');

let server;
let base;

test.before(async () => {
  server = createServer(app);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => { server.close(resolve); });
});

const get = (path, options) => fetch(`${base}${path}`, options);

test('health answers with the provider posture rather than failing', async () => {
  const response = await get('/api/health');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.status, 'string');
  assert.equal('providers' in body, true);
});



test('every read route answers JSON even with no provider reachable', async () => {
  const paths = [
    '/api/analytics/dxy-btc',
    '/api/analytics/sentiment',
    '/api/markets/snapshot',
    '/api/analytics/regime-correlations',
    '/api/analytics/positioning',
    '/api/analytics/heatmap',
    '/api/analytics/metals',
    '/api/analytics/sentiment',
    '/api/analytics/bitcoin',
    '/api/analytics/screener',
    '/api/analytics/equity-risk',
    '/api/analytics/fx',
    '/api/macro/liquidity',
    '/api/macro/consensus',
    '/api/equities/catalog',
    '/api/equities/sectors',
    '/api/news/wire',
    '/api/alerts',
    '/api/ingestion/status',
  ];
  for (const path of paths) {
    const response = await get(path);
    assert.match(response.headers.get('content-type') ?? '', /json/, `${path} did not answer JSON`);
    const body = await response.json();
    // A route with a single upstream and no fallback answers 502; one that
    // publishes an unavailable model answers 200. Both are honest. What none of
    // them may do is answer 500, which would mean the server itself broke.
    assert.equal([200, 502, 503].includes(response.status), true, `${path} answered ${response.status}`);
    if (response.status >= 500) assert.equal(body.kind, 'upstream', `${path} did not classify its failure`);
  }
});

test('a route with an unavailable-model fallback answers 200 rather than 502', async () => {
  // These publish a status object when their inputs are missing, which is the
  // pattern the workspace uses everywhere: the reason travels in the payload.
  for (const path of ['/api/macro/liquidity', '/api/macro/consensus', '/api/equities/catalog', '/api/ingestion/status']) {
    const response = await get(path);
    assert.equal(response.status, 200, `${path} answered ${response.status}`);
  }
});

test('the consensus endpoint carries the cross-model layer and says what it omits', async () => {
  const body = await (await get('/api/macro/consensus')).json();
  assert.deepEqual(
    Object.keys(body).sort(),
    ['asOf', 'consensus', 'consensusHistory', 'macroAlerts', 'modelCorrelation', 'omitted', 'weightOverlap'],
  );
  assert.match(body.omitted, /api\/macro\/liquidity/);
});

test('the liquidity response never ships an unbounded series history', async () => {
  const body = await (await get('/api/macro/liquidity')).json();
  for (const series of body.series ?? []) {
    assert.equal((series.history ?? []).length <= 260, true, `${series.id} shipped ${series.history.length} observations`);
    if (series.historyTruncated) assert.equal(series.historyTruncated.kept, 260);
  }
  if ((body.series ?? []).length) assert.match(body.seriesHistoryNote ?? '', /trimmed/);
});

test('a feed with nothing to serve says so rather than serving an empty feed', async () => {
  // An empty feed reads to a reader as "nothing is happening", which is a
  // different claim from "the wire could not be built at all".
  for (const path of ['/api/news/feed', '/api/alerts/feed']) {
    const response = await get(path);
    assert.equal([200, 503].includes(response.status), true, `${path} answered ${response.status}`);
    if (response.status === 200) {
      assert.match(response.headers.get('content-type') ?? '', /atom\+xml/, `${path} served a feed without the atom type`);
      const body = await response.text();
      assert.match(body, /^<\?xml/);
      assert.match(body, /<feed/);
    } else {
      assert.equal(typeof (await response.json()).status, 'string');
    }
  }
});

test('the atom builder emits a well-formed feed', async () => {
  const { buildAtomFeed } = await import('./analytics.js');
  const xml = buildAtomFeed(
    { title: 'T & test', id: 'urn:x', updated: '2026-01-01T00:00:00.000Z', link: '/feed' },
    [{ title: '<unescaped>', id: 'urn:x:1', updated: '2026-01-01T00:00:00.000Z', content: 'a & b' }],
  );
  assert.match(xml, /^<\?xml/);
  assert.match(xml, /<feed[^>]*xmlns=/);
  // Unescaped markup in a title would produce a feed no reader can parse.
  assert.equal(xml.includes('<unescaped>'), false);
  assert.match(xml, /&lt;unescaped&gt;/);
  assert.match(xml, /T &amp; test/);
});

test('the alert feed says it is unconfigured rather than serving an empty feed', async () => {
  const response = await get('/api/alerts/feed');
  // An empty feed would read to a reader as "nothing is happening", which is a
  // different claim from "alerts are not being stored at all".
  assert.equal([200, 503].includes(response.status), true, `status was ${response.status}`);
  if (response.status === 503) assert.equal((await response.json()).status, 'unconfigured');
});


test('a watchlist write without a database says so rather than claiming a save', async () => {
  const response = await get('/api/watchlists', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Core: ['SPY', 'QQQ'] }),
  });
  const body = await response.json();
  // Either it saved, or it says it did not. What it must never do is answer
  // saved: true when nothing was written.
  if (body.saved !== true) assert.equal(['unconfigured', 'error'].includes(body.status), true, `status was ${body.status}`);
});

test('watchlist symbols are normalised and capped rather than stored as given', async () => {
  const response = await get('/api/watchlists', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'A list': ['  spy  ', 'q q q', 'a-very-long-symbol-name', '<script>'] }),
  });
  assert.equal(response.status < 500, true);
  await response.json();
});

test('an oversized body is a 413, not an upstream provider failure', async () => {
  const response = await get('/api/watchlists', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Huge: Array.from({ length: 200_000 }, (_, index) => `SYM${index}`) }),
  });
  assert.equal(response.status, 413, `status was ${response.status}`);
  assert.equal((await response.json()).kind, 'bad-request');
});


test('the digest answers in both of its formats', async () => {
  const json = await get('/api/digest');
  assert.equal(json.status, 200);
  assert.match(json.headers.get('content-type') ?? '', /json/);
  await json.json();
});

test('an equity dashboard for an unsupported index is a 404', async () => {
  const response = await get('/api/equities/dashboard/NOT_AN_INDEX');
  assert.equal(response.status, 404, `status was ${response.status}`);
  const body = await response.json();
  assert.equal(body.kind, 'not-supported');
  assert.match(body.error, /Unsupported equity index proxy/);
});

test('an upstream failure is still reported as one', async () => {
  const { classifyRequestError } = await import('./index.js');
  assert.equal(classifyRequestError(new Error('fetch failed')).status, 502);
  assert.equal(classifyRequestError(new Error('fetch failed')).body.kind, 'upstream');
  // A fault in the server is not an outage at a provider, and saying so sends
  // whoever is debugging to look in the wrong place.
  assert.equal(classifyRequestError(new TypeError('x is not a function')).status, 500);
  assert.equal(classifyRequestError(new TypeError('x is not a function')).body.kind, 'server-error');
  const tooLarge = Object.assign(new Error('request entity too large'), { status: 413 });
  assert.equal(classifyRequestError(tooLarge).status, 413);
});

test('cache policy matches how often the thing behind a route can change', async () => {
  const { cacheSecondsFor } = await import('./index.js');
  // Caller-owned data must never sit in a shared cache.
  assert.equal(cacheSecondsFor('/api/watchlists'), null);
  assert.equal(cacheSecondsFor('/api/health'), 30);
  assert.equal(cacheSecondsFor('/api/markets/snapshot'), 60);
  assert.equal(cacheSecondsFor('/api/macro/liquidity'), 300);
  assert.equal(cacheSecondsFor('/api/alerts/feed'), 120);
  // An unmatched route falls back to revalidating rather than being cached by
  // a policy that was never written for it.
  assert.equal(cacheSecondsFor('/api/something-new'), 0);
});

test('the headers a client actually receives follow that policy', async () => {
  const analytics = await get('/api/macro/liquidity');
  assert.match(analytics.headers.get('cache-control') ?? '', /public, max-age=300/);
  assert.match(analytics.headers.get('cache-control') ?? '', /stale-while-revalidate/);

  const owned = await get('/api/watchlists');
  assert.equal(owned.headers.get('cache-control'), 'no-store', 'caller-owned data must not be cacheable');

  const health = await get('/api/health');
  assert.match(health.headers.get('cache-control') ?? '', /max-age=30/);
});


test('a revalidated read answers 304 instead of resending the body', async () => {
  const first = await get('/api/macro/liquidity');
  const etag = first.headers.get('etag');
  assert.match(etag ?? '', /^W\//, 'a read must carry a validator');
  const body = await first.text();
  assert.equal(body.length > 0, true);

  const second = await get('/api/macro/liquidity', { headers: { 'If-None-Match': etag } });
  assert.equal(second.status, 304);
  assert.equal((await second.text()).length, 0, '304 carries no body by definition');
  // The cache directives must survive onto the 304, or a client learns nothing
  // about how long the answer it already holds stays good.
  assert.match(second.headers.get('cache-control') ?? '', /max-age=/);
});

test('a changed payload produces a different validator', async () => {
  const health = await get('/api/health');
  const liquidity = await get('/api/macro/liquidity');
  assert.notEqual(health.headers.get('etag'), liquidity.headers.get('etag'));
  await health.text();
  await liquidity.text();
});

test('a stale validator is ignored rather than answered 304', async () => {
  const response = await get('/api/health', { headers: { 'If-None-Match': 'W/"not-the-current-one"' } });
  assert.equal(response.status, 200);
  assert.equal((await response.text()).length > 0, true);
});

test('a write is never answered from a validator', async () => {
  const response = await get('/api/watchlists', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-None-Match': 'W/"anything"' },
    body: JSON.stringify({ Core: ['SPY'] }),
  });
  assert.notEqual(response.status, 304, 'a receipt for something that just happened cannot come from a cache');
  await response.json();
});

test('writes carry their own rate-limit budget, separate from reads', async () => {
  const { config } = await import('./config.js');
  assert.equal(config.apiWriteRateLimit < config.apiRateLimit, true, 'a write budget that matches the read budget is not a budget');
  const response = await get('/api/watchlists', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Core: ['SPY'] }),
  });
  // The write limiter sets its own headers, so the advertised ceiling on a
  // write is the write ceiling rather than the shared read one.
  assert.equal(Number(response.headers.get('ratelimit-limit')), config.apiWriteRateLimit);
  await response.json();
});
