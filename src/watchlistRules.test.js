import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SYMBOLS_PER_LIST, addSymbolToList, canAddSymbol, listsFromServer, nextListName, normalizeWatchlists, reconcileWatchlists, renameList,
  sameWatchlists, sanitizeListName, sanitizeSymbol,
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

const DEFAULTS = { Core: ['NVDA', 'AAPL', 'GLD', 'BTC'] };

test('server rows become the lists the client edits, cleaned the same way', () => {
  assert.deepEqual(
    listsFromServer([{ name: 'Mine', symbols: ['msft', 'MSFT', 'tsla'] }, { name: '', symbols: ['X'] }, { name: 'Bad' }, null]),
    { Mine: ['MSFT', 'TSLA'] },
  );
  assert.deepEqual(listsFromServer(undefined), {});
});

test('list order does not make two sets of lists differ, but symbol order does', () => {
  assert.equal(sameWatchlists({ B: ['X'], A: ['Y'] }, { A: ['Y'], B: ['X'] }), true);
  assert.equal(sameWatchlists({ A: ['X', 'Y'] }, { A: ['Y', 'X'] }), false);
  assert.equal(sameWatchlists({ A: ['x'] }, { A: ['X'] }), true);
});

test('a browser nobody has edited adopts the server lists instead of overwriting them', () => {
  // The defaults reach localStorage on first render, before the server
  // answers, so merely having stored lists does not mean they were edited.
  const result = reconcileWatchlists({ local: DEFAULTS, defaults: DEFAULTS, server: [{ name: 'Mine', symbols: ['MSFT'] }] });
  assert.equal(result.action, 'adopt');
  assert.deepEqual(result.lists, { Mine: ['MSFT'] });
  assert.equal(reconcileWatchlists({ local: null, defaults: DEFAULTS, server: [{ name: 'Mine', symbols: ['MSFT'] }] }).action, 'adopt');
});

test('an edited browser that disagrees with the server keeps its lists and reports the conflict', () => {
  const local = { Core: ['NVDA', 'AMD'] };
  const result = reconcileWatchlists({ local, defaults: DEFAULTS, server: [{ name: 'Mine', symbols: ['MSFT'] }] });
  assert.equal(result.action, 'conflict');
  assert.deepEqual(result.lists, local);
  assert.deepEqual(result.serverLists, { Mine: ['MSFT'] });
});

test('matching lists need nothing, and an empty server takes only edited lists', () => {
  assert.equal(reconcileWatchlists({ local: { B: ['X'], A: ['Y'] }, defaults: DEFAULTS, server: [{ name: 'A', symbols: ['Y'] }, { name: 'B', symbols: ['X'] }] }).action, 'keep');
  assert.equal(reconcileWatchlists({ local: { Core: ['AMD'] }, defaults: DEFAULTS, server: [] }).action, 'push');
  assert.equal(reconcileWatchlists({ local: DEFAULTS, defaults: DEFAULTS, server: [] }).action, 'keep');
});

test('a new list never takes the name of one that still exists', () => {
  assert.equal(nextListName({ Core: [] }), 'List 2');
  // After deleting "List 2" the count points at "List 3", which is still there.
  assert.equal(nextListName({ Core: [], 'List 3': ['AMD'] }), 'List 4');
  assert.equal(nextListName({}), 'List 1');
});

test('a renamed list keeps its symbols and its place, and never takes another list\'s name', () => {
  const lists = { Core: ['NVDA'], 'List 2': ['AMD'], Miners: ['GDX'] };
  const renamed = renameList(lists, 'List 2', '  Semis  ');
  assert.equal(renamed.ok, true);
  assert.deepEqual(Object.keys(renamed.lists), ['Core', 'Semis', 'Miners']);
  assert.deepEqual(renamed.lists.Semis, ['AMD']);
  assert.match(renameList(lists, 'List 2', 'Core').reason, /already exists/);
  assert.equal(renameList(lists, 'List 2', '   ').ok, false);
  assert.equal(renameList(lists, 'Gone', 'X').ok, false);
  assert.equal(renameList(lists, 'Core', 'x'.repeat(60)).name.length, 40);
});
