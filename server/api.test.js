import test from 'node:test';
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { app } from './index.js';

let server;
let origin;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const get = (path, options) => fetch(`${origin}${path}`, options);
const putJson = (path, body) => fetch(`${origin}${path}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('health reports the provider surface without leaking credentials', async () => {
  const response = await get('/api/health');
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(typeof payload.status, 'string');
  assert.equal(typeof payload.providers, 'object');
  assert.equal(JSON.stringify(payload).includes('apiKey'), false);
});

test('every API response carries the hardening headers and is never cached', async () => {
  const response = await get('/api/health');
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(response.headers.get('x-powered-by'), null);
});

test('API responses advertise the rate-limit window', async () => {
  const response = await get('/api/health');
  assert.equal(Number(response.headers.get('ratelimit-limit')) > 0, true);
  assert.equal(Number.isFinite(Number(response.headers.get('ratelimit-remaining'))), true);
  assert.equal(Number(response.headers.get('ratelimit-reset')) > 0, true);
});

test('an unknown API path answers JSON 404 rather than the SPA document', async () => {
  const response = await get('/api/nothing-here');
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('content-type')?.startsWith('application/json'), true);
  assert.deepEqual(await response.json(), { error: 'API endpoint not found.' });
});

test('an unsupported history symbol is a client error, not a provider failure', async () => {
  const response = await get('/api/markets/history/NOTATICKER');
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Unsupported history symbol/);
});

test('a malformed JSON body is rejected as a client error', async () => {
  const response = await putJson('/api/watchlists', '{"broken":');
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Request body is not valid JSON.' });
});

test('watchlist writes reject shapes that are not a map of lists', async () => {
  for (const body of [[], ['AAPL'], 'AAPL', 42]) {
    const response = await putJson('/api/watchlists', body);
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

test('watchlist writes reject too many lists and oversized lists', async () => {
  const tooManyLists = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`list-${index}`, []]));
  assert.equal((await putJson('/api/watchlists', tooManyLists)).status, 400);

  const oversized = { Core: Array.from({ length: 51 }, (_, index) => `SYM${index}`) };
  assert.equal((await putJson('/api/watchlists', oversized)).status, 400);

  const unnamed = { '   ': ['AAPL'] };
  assert.equal((await putJson('/api/watchlists', unnamed)).status, 400);
});

test('watchlist endpoints report unconfigured rather than failing without Postgres', async () => {
  const read = await get('/api/watchlists');
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { status: 'unconfigured', lists: [] });

  const write = await putJson('/api/watchlists', { Core: ['AAPL', 'msft'] });
  assert.equal(write.status, 200);
  assert.deepEqual(await write.json(), { status: 'unconfigured', saved: false });
});

test('alerts report unconfigured and the alert feed declines without Postgres', async () => {
  const alerts = await get('/api/alerts');
  assert.equal(alerts.status, 200);
  const payload = await alerts.json();
  assert.equal(payload.status, 'unconfigured');
  assert.deepEqual(payload.alerts, []);

  const feed = await get('/api/alerts/feed');
  assert.equal(feed.status, 503);
  assert.deepEqual(await feed.json(), { status: 'unconfigured' });
});

test('the SPA document is revalidated while hashed bundles are immutable', async () => {
  const document = await get('/');
  if (document.status === 404) return; // dist/ is only present after a build
  assert.equal(document.status, 200);
  assert.equal(document.headers.get('cache-control'), 'no-cache');

  const html = await document.text();
  const asset = html.match(/\/assets\/[A-Za-z0-9._-]+\.js/)?.[0];
  assert.ok(asset, 'built document should reference a hashed bundle');
  const bundle = await get(asset);
  assert.equal(bundle.status, 200);
  assert.equal(bundle.headers.get('cache-control'), 'public, max-age=31536000, immutable');
});

test('an unknown page falls through to the SPA document instead of 404', async () => {
  const response = await get('/screener');
  if (response.status === 404) return; // dist/ is only present after a build
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type')?.startsWith('text/html'), true);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
});
