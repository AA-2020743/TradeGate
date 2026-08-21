import test from 'node:test';
import assert from 'node:assert/strict';
import { settle, unwrap } from './settled.js';

const drain = () => new Promise((resolve) => setTimeout(resolve, 20));

async function rejectionsDuring(work) {
  const seen = [];
  const listener = (reason) => seen.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await work();
    await drain();
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
}

test('a settled success carries the value through', async () => {
  assert.deepEqual(await settle(Promise.resolve(7)), { ok: true, value: 7, error: null });
  assert.equal(unwrap(await settle(Promise.resolve('BTC'))), 'BTC');
});

test('a settled failure carries the error instead of rejecting', async () => {
  const failure = new Error('Upstream request failed with 403');
  const result = await settle(Promise.reject(failure));
  assert.equal(result.ok, false);
  assert.equal(result.error, failure);
  assert.throws(() => unwrap(result), /403/);
});

// The bare form of this — abandoning `Promise.reject(...)` — cannot be asserted
// here: node:test fails any run that produces a real unhandled rejection, which
// is the same reaction that takes a server process down in production.
test('a settled promise abandoned by an early return raises no unhandled rejection', async () => {
  const seen = await rejectionsDuring(async () => {
    // The shape of the bug: work is started, then the caller bails out before
    // ever awaiting it.
    const pending = settle(Promise.reject(new Error('provider 403')));
    if (pending) return;
  });
  assert.deepEqual(seen, []);
});

test('unwrap refuses a malformed result rather than returning undefined', () => {
  assert.throws(() => unwrap(null), /no value/);
  assert.throws(() => unwrap({ ok: false, error: null }), /no value/);
});

test('settle accepts a plain value as well as a promise', async () => {
  assert.deepEqual(await settle(5), { ok: true, value: 5, error: null });
});
