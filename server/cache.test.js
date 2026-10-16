import test from 'node:test';
import assert from 'node:assert/strict';
import { withCache } from './cache.js';

test('forced cache refresh replaces a still-fresh value', async () => {
  let loads = 0;
  const loader = async () => ++loads;
  assert.equal(await withCache('test:forced-refresh', 60_000, loader), 1);
  assert.equal(await withCache('test:forced-refresh', 60_000, loader), 1);
  assert.equal(await withCache('test:forced-refresh', 60_000, loader, { force: true }), 2);
  assert.equal(await withCache('test:forced-refresh', 60_000, loader), 2);
});

test('normal readers receive the previous value during a forced refresh', async () => {
  await withCache('test:stale-while-refresh', 60_000, async () => 'old');
  let finishRefresh;
  const refreshing = withCache('test:stale-while-refresh', 60_000, () => new Promise((resolve) => {
    finishRefresh = resolve;
  }), { force: true });
  assert.equal(await withCache('test:stale-while-refresh', 60_000, async () => 'unexpected'), 'old');
  finishRefresh('new');
  assert.equal(await refreshing, 'new');
  assert.equal(await withCache('test:stale-while-refresh', 60_000, async () => 'unexpected'), 'new');
});

test('forced refresh runs after a normal refresh already in progress', async () => {
  let finishNormal;
  const normal = withCache('test:force-after-pending', 60_000, () => new Promise((resolve) => {
    finishNormal = resolve;
  }));
  const forced = withCache('test:force-after-pending', 60_000, async () => 'scheduled', { force: true });
  finishNormal('interactive');
  assert.equal(await normal, 'interactive');
  assert.equal(await forced, 'scheduled');
});

test('cache merge can retain last-known-good fields after a partial refresh', async () => {
  await withCache('test:merge-partial', 60_000, async () => ({ current: 1, fallback: 2 }));
  const value = await withCache('test:merge-partial', 60_000, async () => ({ current: 3 }), {
    force: true,
    merge: (previous, next) => ({ ...previous, ...next }),
  });
  assert.deepEqual(value, { current: 3, fallback: 2 });
});

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('an unavailable answer is retried soon rather than kept for the full TTL', async () => {
  let loads = 0;
  const loader = async () => { loads += 1; return loads === 1 ? { status: 'unavailable', reason: 'provider timed out' } : { status: 'calculated', value: 7 }; };
  assert.equal((await withCache('test:degraded-retry', 60_000, loader, { degradedTtlMs: 20 })).status, 'unavailable');
  // Within the short retry window it is still served from the cache...
  assert.equal((await withCache('test:degraded-retry', 60_000, loader, { degradedTtlMs: 20 })).status, 'unavailable');
  assert.equal(loads, 1);
  // ...and after it, recomputed, though the full TTL is a minute.
  await pause(30);
  assert.equal((await withCache('test:degraded-retry', 60_000, loader, { degradedTtlMs: 20 })).value, 7);
  // A good answer is then kept for the full TTL.
  await pause(30);
  assert.equal((await withCache('test:degraded-retry', 60_000, loader, { degradedTtlMs: 20 })).value, 7);
  assert.equal(loads, 2);
});

test('an answer carrying provider errors is retried soon too', async () => {
  let loads = 0;
  const loader = async () => { loads += 1; return { status: 'calculated', errors: loads === 1 ? ['GC=F: timed out'] : [] }; };
  await withCache('test:errors-retry', 60_000, loader, { degradedTtlMs: 20 });
  await pause(30);
  const second = await withCache('test:errors-retry', 60_000, loader, { degradedTtlMs: 20 });
  assert.deepEqual(second.errors, []);
  assert.equal(loads, 2);
});

test('a good answer is not replaced by an unavailable one; it is served while the retry waits', async () => {
  let loads = 0;
  const loader = async () => { loads += 1; return loads === 2 ? { status: 'unavailable', reason: 'provider down' } : { status: 'calculated', asOf: `run ${loads}` }; };
  assert.equal((await withCache('test:keep-good', 10, loader, { degradedTtlMs: 20 })).asOf, 'run 1');
  await pause(15);
  // The good answer expired and the recompute failed: the good one is kept.
  assert.equal((await withCache('test:keep-good', 10, loader, { degradedTtlMs: 20 })).asOf, 'run 1');
  assert.equal(loads, 2);
  await pause(30);
  // Retried once the short window passes, and the provider is back.
  assert.equal((await withCache('test:keep-good', 10, loader, { degradedTtlMs: 20 })).asOf, 'run 3');
});

test('an answer with no status or errors is cached as before', async () => {
  let loads = 0;
  const loader = async () => ++loads;
  await withCache('test:plain', 60_000, loader, { degradedTtlMs: 1 });
  await pause(5);
  assert.equal(await withCache('test:plain', 60_000, loader, { degradedTtlMs: 1 }), 1);
});
