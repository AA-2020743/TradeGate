import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SYMBOLS_PER_LIST, addSymbolToList, canAddSymbol, normalizeWatchlists, sanitizeListName, sanitizeSymbol,
} from './watchlistRules.js';

// The server applies exactly this to every symbol it stores.
const serverSanitize = (symbol) => String(symbol).toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10);

test('client sanitisation matches what the server will store', () => {
  const inputs = ['aapl', ' msft ', 'BRK.B', 'brk/b', 'AAPL!', 'RY-PA', 'verylongtickername', '???', '', 'a1.b-2'];
  for (const input of inputs) {
    assert.equal(sanitizeSymbol(input), serverSanitize(input.trim()), `mismatch for ${JSON.stringify(input)}`);
  }
});

test('a sanitised symbol survives a second pass unchanged', () => {
  for (const input of ['brk/b', 'AAPL!', 'verylongtickername', ' nvda ']) {
    const once = sanitizeSymbol(input);
    assert.equal(sanitizeSymbol(once), once);
  }
});

test('symbols are uppercased and stripped of characters the server rejects', () => {
  assert.equal(sanitizeSymbol('brk/b'), 'BRKB');
  assert.equal(sanitizeSymbol('BRK.B'), 'BRK.B');
  assert.equal(sanitizeSymbol('ry-pa'), 'RY-PA');
  assert.equal(sanitizeSymbol('verylongtickername'), 'VERYLONGTI');
  assert.equal(sanitizeSymbol('!!!'), '');
});

test('a symbol of only invalid characters is refused with a reason', () => {
  const verdict = canAddSymbol([], '///');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /letters, digits, dots or hyphens/);
});

test('a duplicate is refused by its sanitised form, not its raw text', () => {
  const verdict = canAddSymbol(['BRKB'], 'brk/b');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /already on this list/);
});

test('the list cap is enforced client-side so the sync is not rejected wholesale', () => {
  const full = Array.from({ length: MAX_SYMBOLS_PER_LIST }, (_, index) => `SYM${index}`);
  const verdict = canAddSymbol(full, 'NVDA');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, new RegExp(`${MAX_SYMBOLS_PER_LIST} symbols`));

  const oneShort = full.slice(0, MAX_SYMBOLS_PER_LIST - 1);
  assert.equal(canAddSymbol(oneShort, 'NVDA').ok, true);
});

test('adding returns a new object and leaves the original untouched', () => {
  const lists = { Core: ['AAPL'] };
  const result = addSymbolToList(lists, 'Core', 'nvda');
  assert.deepEqual(result.lists.Core, ['AAPL', 'NVDA']);
  assert.deepEqual(lists.Core, ['AAPL']);
  assert.equal(result.ok, true);
});

test('a refused add returns the lists unchanged along with the reason', () => {
  const lists = { Core: ['AAPL'] };
  const result = addSymbolToList(lists, 'Core', 'aapl');
  assert.equal(result.ok, false);
  assert.equal(result.lists, lists);
});

test('adding to a list that does not exist yet creates it', () => {
  const result = addSymbolToList({}, 'New', 'spy');
  assert.deepEqual(result.lists.New, ['SPY']);
});

test('list names are trimmed and capped like the server does', () => {
  assert.equal(sanitizeListName('  Core  '), 'Core');
  assert.equal(sanitizeListName('x'.repeat(60)).length, 40);
  assert.equal(sanitizeListName('   '), '');
});

test('normalising a payload dedupes, drops empties and caps every list', () => {
  const normalized = normalizeWatchlists({
    '  Core  ': ['aapl', 'AAPL', 'brk/b', '???', 'nvda'],
    '   ': ['SPY'],
    Long: Array.from({ length: 70 }, (_, index) => `SYM${index}`),
  });
  assert.deepEqual(normalized.Core, ['AAPL', 'BRKB', 'NVDA']);
  assert.equal('   ' in normalized, false);
  assert.equal(Object.keys(normalized).includes(''), false);
  assert.equal(normalized.Long.length, MAX_SYMBOLS_PER_LIST);
});

test('a normalised payload passes the server rules unchanged', () => {
  const normalized = normalizeWatchlists({ Core: ['aapl', 'brk/b', 'verylongtickername'] });
  for (const [name, symbols] of Object.entries(normalized)) {
    assert.equal(name.length <= 40 && name.trim() === name, true);
    assert.ok(symbols.length <= MAX_SYMBOLS_PER_LIST);
    for (const symbol of symbols) assert.equal(serverSanitize(symbol), symbol);
  }
});
