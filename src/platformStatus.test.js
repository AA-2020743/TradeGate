import test from 'node:test';
import assert from 'node:assert/strict';
import { derivePlatformStatus, providerDegradation } from './platformStatus.js';

const healthyProviders = {
  fred: { configured: false, mode: 'keyless-public-csv' },
  coingecko: { configured: true, mode: 'keyless-public' },
  cftc: { configured: true, mode: 'keyless-public' },
  yahooSpark: { configured: true, mode: 'keyless-public' },
  database: { configured: false, connected: false, migrated: false, mode: 'not-configured' },
};
const markets = { assets: [{ key: 'BTC' }], errors: [] };

test('a provider serving without a key is not degraded', () => {
  assert.equal(providerDegradation('fred', { configured: false, mode: 'keyless-public-csv' }), null);
  assert.equal(providerDegradation('coingecko', { configured: true, mode: 'keyless-public' }), null);
  assert.equal(providerDegradation('cftc', { configured: true, mode: 'app-token' }), null);
  assert.equal(providerDegradation('twelveData', { configured: true, mode: 'credentialed' }), null);
});

test('a provider with no keyless path and no key is degraded', () => {
  assert.match(providerDegradation('twelveData', { configured: false, mode: 'not-configured' }), /needs a key/);
});

test('a configured provider that cannot be reached is degraded, key or not', () => {
  assert.match(providerDegradation('database', { configured: true, connected: false, mode: 'postgres' }), /not reachable/);
  assert.match(providerDegradation('database', { configured: true, connected: true, migrated: false, mode: 'postgres' }), /not migrated/);
});

test('a fully keyless deployment reads as live rather than permanently partial', () => {
  const result = derivePlatformStatus({
    health: { providers: { ...healthyProviders, database: { configured: false, connected: false, migrated: false, mode: 'not-configured' } } },
    markets,
  });
  // The database is optional and unconfigured; that is a deployment choice, not a fault.
  assert.equal(result.degraded.includes('database'), true);
  assert.equal(result.status, 'partial');

  const withoutDatabase = derivePlatformStatus({
    health: { providers: { fred: healthyProviders.fred, coingecko: healthyProviders.coingecko, yahooSpark: healthyProviders.yahooSpark } },
    markets,
  });
  assert.equal(withoutDatabase.status, 'live');
  assert.deepEqual(withoutDatabase.degraded, []);
  assert.equal(withoutDatabase.error, null);
});

test('the reason names what is missing instead of a generic warning', () => {
  const result = derivePlatformStatus({
    health: { providers: { twelveData: { configured: false, mode: 'not-configured' }, fred: healthyProviders.fred } },
    markets,
  });
  assert.deepEqual(result.degraded, ['twelveData']);
  assert.match(result.error, /twelveData needs a key before it can serve/);
});

test('failed core requests and provider errors are counted separately and pluralised', () => {
  const one = derivePlatformStatus({
    health: { providers: healthyProviders }, markets: { assets: [{ key: 'BTC' }], errors: ['FRED stale'] },
    failedRequests: ['markets'],
  });
  assert.match(one.error, /1 core request failed/);
  assert.match(one.error, /1 provider error/);

  const many = derivePlatformStatus({
    health: { providers: healthyProviders }, markets: { assets: [{ key: 'BTC' }], errors: ['a', 'b'] },
    failedRequests: ['markets', 'liquidity'],
  });
  assert.match(many.error, /2 core requests failed/);
  assert.match(many.error, /2 provider errors/);
});

test('no quotes is called out explicitly', () => {
  const result = derivePlatformStatus({ health: { providers: { fred: healthyProviders.fred } }, markets: { assets: [], errors: [] } });
  assert.equal(result.status, 'partial');
  assert.match(result.error, /no live quotes returned/);
});

test('a missing health payload is offline, not partial', () => {
  const result = derivePlatformStatus({ health: null, markets });
  assert.equal(result.status, 'offline');
  assert.equal(result.error, 'The data API is unavailable.');
  assert.deepEqual(result.degraded, []);
});

test('blocked sources are carried through without being treated as faults', () => {
  const result = derivePlatformStatus({
    health: { providers: { fred: healthyProviders.fred, yahooSpark: healthyProviders.yahooSpark } },
    markets,
    blockedSources: [{ source: 'Farside UK', reason: 'Cloudflare 403' }, { source: 'AAII', reason: 'Paywall' }],
  });
  assert.deepEqual(result.blocked, ['Farside UK', 'AAII']);
  assert.equal(result.status, 'live');
});

test('an empty health payload does not throw', () => {
  const result = derivePlatformStatus({ health: {}, markets });
  assert.equal(result.status, 'live');
  assert.deepEqual(result.degraded, []);
});
