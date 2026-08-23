import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from './log.js';

function capture(options = {}) {
  const out = [];
  const err = [];
  const log = createLogger({
    write: (line) => out.push(JSON.parse(line)),
    writeError: (line) => err.push(JSON.parse(line)),
    now: () => '2026-01-01T00:00:00.000Z',
    ...options,
  });
  return { log, out, err };
}

test('every line is one JSON object with a level and a timestamp', () => {
  const { log, out } = capture();
  log.info('ingestion finished', { job: 'fred-liquidity', runId: 42 });
  assert.deepEqual(out[0], { at: '2026-01-01T00:00:00.000Z', level: 'info', message: 'ingestion finished', job: 'fred-liquidity', runId: 42 });
});

test('errors go to stderr and carry a trimmed stack', () => {
  const { log, out, err } = capture();
  log.error('run failed', { job: 'fred-liquidity', error: new Error('provider down') });
  assert.equal(out.length, 0);
  assert.equal(err[0].level, 'error');
  assert.equal(err[0].error.message, 'provider down');
  assert.equal(err[0].error.name, 'Error');
  // The stack is the most useful field and the largest; six frames is the trade.
  assert.equal(err[0].error.stack.split('\n').length <= 6, true);
});

test('a cause is carried so a wrapped failure is not anonymous', () => {
  const { log, err } = capture();
  log.error('failed', { error: new Error('outer', { cause: new Error('inner') }) });
  assert.equal(err[0].error.cause.message, 'inner');
});

test('a child logger stamps every line with its context', () => {
  const { log, out } = capture();
  const run = log.child({ runId: 7, job: 'market-history' });
  run.info('started');
  run.info('finished', { written: 120 });
  assert.equal(out.every((entry) => entry.runId === 7 && entry.job === 'market-history'), true);
  assert.equal(out[1].written, 120);
});

test('a level below the threshold is not emitted', () => {
  const { log, out } = capture({ level: 'warn' });
  log.info('quiet');
  log.debug('quieter');
  assert.deepEqual(out, []);
  log.warn('loud');
  assert.equal(out.length, 1);
});

test('a field that cannot be serialised loses the field, not the line', () => {
  const { log, out } = capture();
  const circular = {};
  circular.self = circular;
  log.info('still logged', { circular });
  assert.equal(out.length, 1, 'the line must survive');
  assert.equal(out[0].serialisationFailed, true);
  assert.equal(out[0].message, 'still logged');
});

test('an explicit field overrides the child context rather than being dropped', () => {
  const { log, out } = capture();
  log.child({ job: 'a' }).info('m', { job: 'b' });
  assert.equal(out[0].job, 'b');
});
