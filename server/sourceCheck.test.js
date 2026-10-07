import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReport, partStates, reasonsFrom, summarizeSource } from './sourceCheck.js';

const fulfilled = (value) => ({ status: 'fulfilled', value });

test('a fully calculated source is OK, with its figure and parts', () => {
  const summary = summarizeSource(
    { name: 'Shiller', endpoint: '/api/x', figure: (payload) => `CAPE ${payload.cape}` },
    fulfilled({ status: 'calculated', cape: 37.1, outlook: { status: 'calculated' } }),
    2345,
  );
  assert.equal(summary.verdict, 'ok');
  assert.equal(summary.figure, 'CAPE 37.1');
  assert.equal(summary.seconds, 2.3);
  assert.deepEqual(summary.parts, ['outlook=calculated']);
  assert.deepEqual(summary.reasons, []);
});

test('a source with some parts published is partial, and names why the rest are not', () => {
  const summary = summarizeSource({ name: 'Deribit' }, fulfilled({
    status: 'provisional',
    surfaces: [{ currency: 'BTC', status: 'calculated' }, { currency: 'ETH', status: 'unavailable', reason: 'ETH chain: 503' }],
    errors: ['ETH chain: 503', 'DVOL history: timeout'],
  }), 100);
  assert.equal(summary.verdict, 'partial');
  assert.deepEqual(summary.parts, ['surfaces: BTC=calculated ETH=unavailable']);
  assert.deepEqual(summary.reasons, ['ETH chain: 503', 'DVOL history: timeout'], 'reasons are de-duplicated');
});

test('an unavailable payload, a rejected loader and a throwing figure all fail cleanly', () => {
  const unavailable = summarizeSource({ name: 'French' }, fulfilled({ status: 'unavailable', reason: 'Upstream request failed with 403' }), 50);
  assert.equal(unavailable.verdict, 'failed');
  assert.deepEqual(unavailable.reasons, ['Upstream request failed with 403']);
  const rejected = summarizeSource({ name: 'Treasury' }, { status: 'rejected', reason: new Error('did not answer within 90s') }, 90_000);
  assert.equal(rejected.verdict, 'failed');
  assert.deepEqual(rejected.reasons, ['did not answer within 90s']);
  const broken = summarizeSource({ name: 'X', figure: (payload) => payload.missing.deep }, fulfilled({ status: 'calculated' }), 1);
  assert.equal(broken.figure, null);
  assert.equal(broken.verdict, 'ok');
});

test('a payload with no status of its own is judged by the source’s own test', () => {
  const answered = (payload) => payload.provider.failedSeries === 0;
  const healthy = summarizeSource({ name: 'FRED', answered }, fulfilled({ provider: { failedSeries: 0 }, model: { status: 'calculated' } }), 1);
  assert.equal(healthy.verdict, 'ok');
  assert.equal(healthy.status, 'answered');
  const someFailed = summarizeSource({ name: 'FRED', answered }, fulfilled({ provider: { failedSeries: 3 }, model: { status: 'calculated' } }), 1);
  assert.equal(someFailed.verdict, 'partial', 'models still published from the series that arrived');
  const none = summarizeSource({ name: 'FRED', answered }, fulfilled({ provider: { failedSeries: 32 }, model: { status: 'unavailable', reason: 'no series' } }), 1);
  assert.equal(none.verdict, 'failed');
});

test('parts and reasons read only one level deep, and long lists are capped', () => {
  const payload = { checks: Array.from({ length: 12 }, (_unused, index) => ({ symbol: `S${index}`, status: 'pass' })), nested: { inner: { status: 'unavailable', reason: 'deep' } } };
  assert.match(partStates(payload)[0], /S7=pass \(\+4\)$/);
  assert.deepEqual(reasonsFrom(payload), []);
});

test('the report ends with a count of what answered', () => {
  const report = formatReport([
    summarizeSource({ name: 'A' }, fulfilled({ status: 'calculated' }), 1),
    summarizeSource({ name: 'B' }, fulfilled({ status: 'provisional' }), 1),
    summarizeSource({ name: 'C' }, fulfilled({ status: 'unavailable', reason: 'x' }), 1),
  ]);
  assert.match(report, /^OK +A/m);
  assert.match(report, /^PART +B/m);
  assert.match(report, /^FAIL +C/m);
  assert.match(report, /1 of 3 sources fully answered, 1 partly, 1 not at all\.$/);
});
