import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from './rateLimit.js';

function exchange(limiter, ip = '10.0.0.1') {
  const headers = {};
  let statusCode = null;
  let body = null;
  let passed = false;
  limiter.middleware(
    { ip },
    {
      setHeader: (name, value) => { headers[name] = value; },
      status: (code) => { statusCode = code; return { json: (payload) => { body = payload; } }; },
    },
    () => { passed = true; },
  );
  return { headers, statusCode, body, passed };
}

test('requests pass until the ceiling and the remaining count counts down', () => {
  const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
  const first = exchange(limiter);
  assert.equal(first.passed, true);
  assert.equal(first.headers['RateLimit-Limit'], '3');
  assert.equal(first.headers['RateLimit-Remaining'], '2');
  assert.equal(exchange(limiter).headers['RateLimit-Remaining'], '1');
  assert.equal(exchange(limiter).headers['RateLimit-Remaining'], '0');
  limiter.stop();
});

test('exceeding the ceiling answers 429 with Retry-After instead of continuing', () => {
  const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
  exchange(limiter);
  exchange(limiter);
  const blocked = exchange(limiter);
  assert.equal(blocked.passed, false);
  assert.equal(blocked.statusCode, 429);
  assert.match(blocked.body.error, /rate limit/i);
  assert.equal(blocked.headers['RateLimit-Remaining'], '0');
  assert.equal(Number(blocked.headers['Retry-After']) > 0, true);
  limiter.stop();
});

test('each client carries its own window', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
  assert.equal(exchange(limiter, '10.0.0.1').passed, true);
  assert.equal(exchange(limiter, '10.0.0.1').passed, false);
  assert.equal(exchange(limiter, '10.0.0.2').passed, true);
  assert.equal(limiter.trackedClients(), 2);
  limiter.stop();
});

test('a blocked client is served again once its window rolls over', () => {
  let clock = 1_000_000;
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => clock });
  assert.equal(exchange(limiter).passed, true);
  assert.equal(exchange(limiter).passed, false);
  clock += 60_001;
  const afterReset = exchange(limiter);
  assert.equal(afterReset.passed, true);
  assert.equal(afterReset.headers['RateLimit-Remaining'], '0');
  limiter.stop();
});

test('a request without an address is still counted rather than throwing', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
  const headers = {};
  let statusCode = null;
  limiter.middleware({}, {
    setHeader: (name, value) => { headers[name] = value; },
    status: (code) => { statusCode = code; return { json: () => {} }; },
  }, () => {});
  assert.equal(headers['RateLimit-Remaining'], '0');
  assert.equal(statusCode, null);
  assert.equal(limiter.trackedClients(), 1);
  limiter.stop();
});

test('invalid or missing settings fall back to 120 requests a minute', () => {
  for (const options of [undefined, {}, { limit: 0, windowMs: -5 }, { limit: Number.NaN, windowMs: 'soon' }]) {
    const limiter = createRateLimiter(options);
    assert.equal(limiter.limit, 120);
    assert.equal(limiter.windowMs, 60_000);
    limiter.stop();
  }
});

test('expired windows are swept so idle clients do not accumulate', async () => {
  let clock = 1_000_000;
  const limiter = createRateLimiter({ limit: 5, windowMs: 20, now: () => clock });
  exchange(limiter, '10.0.0.1');
  exchange(limiter, '10.0.0.2');
  assert.equal(limiter.trackedClients(), 2);
  clock += 1000;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(limiter.trackedClients(), 0);
  limiter.stop();
});
