import test from 'node:test';
import assert from 'node:assert/strict';

test('empty Twelve Data limits use safe defaults while explicit zero is preserved', async () => {
  process.env.TWELVE_DAILY_CREDIT_LIMIT = '';
  process.env.TWELVE_INTERACTIVE_DAILY_LIMIT = '';
  process.env.TWELVE_MAX_INTERACTIVE_WAIT_MS = '';
  const empty = (await import(`./config.js?empty=${Date.now()}`)).config;
  assert.equal(empty.twelveDailyCreditLimit, 760);
  assert.equal(empty.twelveInteractiveDailyLimit, 140);
  assert.equal(empty.twelveMaxInteractiveWaitMs, 10_000);

  process.env.TWELVE_INTERACTIVE_DAILY_LIMIT = '0';
  process.env.TWELVE_MAX_INTERACTIVE_WAIT_MS = '0';
  const zero = (await import(`./config.js?zero=${Date.now()}`)).config;
  assert.equal(zero.twelveInteractiveDailyLimit, 0);
  assert.equal(zero.twelveMaxInteractiveWaitMs, 0);

  delete process.env.TWELVE_DAILY_CREDIT_LIMIT;
  delete process.env.TWELVE_INTERACTIVE_DAILY_LIMIT;
  delete process.env.TWELVE_MAX_INTERACTIVE_WAIT_MS;
});
