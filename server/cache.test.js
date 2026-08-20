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
