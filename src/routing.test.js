import test from 'node:test';
import assert from 'node:assert/strict';
import { NAV_LABELS, buildRoute, parseRoute } from './routing.js';

const SYMBOLS = ['NVDA', 'AAPL', 'GLD', 'BTC'];

test('every workspace round-trips through its route', () => {
  for (const label of NAV_LABELS) {
    assert.equal(parseRoute(buildRoute(label), SYMBOLS).nav, label);
  }
});

test('routes carry a tracked symbol and drop an untracked one', () => {
  assert.deepEqual(parseRoute('#/overview/BTC', SYMBOLS), { nav: 'Overview', symbol: 'BTC' });
  assert.deepEqual(parseRoute('#/overview/btc', SYMBOLS), { nav: 'Overview', symbol: 'BTC' });
  assert.deepEqual(parseRoute('#/overview/TSLA', SYMBOLS), { nav: 'Overview', symbol: null });
  assert.deepEqual(parseRoute('#/screener', SYMBOLS), { nav: 'Screener', symbol: null });
});

test('an empty, partial, or unknown hash resolves to the default workspace', () => {
  for (const hash of ['', '#', '#/', '#/nowhere', '#//BTC', null, undefined]) {
    assert.equal(parseRoute(hash, SYMBOLS).nav, 'Overview');
  }
});

test('a malformed percent escape does not throw', () => {
  assert.deepEqual(parseRoute('#/%E0%A4%A/%', SYMBOLS), { nav: 'Overview', symbol: null });
});

test('building a route lowercases the workspace and uppercases the symbol', () => {
  assert.equal(buildRoute('Screener'), '#/screener');
  assert.equal(buildRoute('Overview', 'nvda'), '#/overview/NVDA');
  assert.equal(buildRoute('Overview', null), '#/overview');
  assert.equal(buildRoute('Overview', ''), '#/overview');
});

test('an unknown workspace builds the default route instead of a dead link', () => {
  assert.equal(buildRoute('Nowhere', 'BTC'), '#/overview/BTC');
  assert.equal(buildRoute(undefined), '#/overview');
});
