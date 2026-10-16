// These mirror the server's PUT /api/watchlists validation exactly. Applying
// them client-side keeps local state and stored state identical: a symbol the
// browser accepts but the server rewrites diverges silently, and a list one
// symbol over the cap makes the server reject the whole payload, so every
// other list stops syncing too.
export const MAX_LISTS = 20;
export const MAX_SYMBOLS_PER_LIST = 50;
export const MAX_SYMBOL_LENGTH = 10;
export const MAX_LIST_NAME_LENGTH = 40;

export function sanitizeSymbol(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, MAX_SYMBOL_LENGTH);
}

export function sanitizeListName(raw) {
  return String(raw ?? '').trim().slice(0, MAX_LIST_NAME_LENGTH);
}

/**
 * Whether a symbol can join a list, and why not when it cannot. The reason is
 * shown to the user rather than the add silently doing nothing.
 */
export function canAddSymbol(symbols, raw) {
  const symbol = sanitizeSymbol(raw);
  if (!symbol) return { ok: false, symbol: '', reason: 'Enter a ticker using letters, digits, dots or hyphens.' };
  const list = Array.isArray(symbols) ? symbols : [];
  if (list.includes(symbol)) return { ok: false, symbol, reason: `${symbol} is already on this list.` };
  if (list.length >= MAX_SYMBOLS_PER_LIST) {
    return { ok: false, symbol, reason: `This list already holds ${MAX_SYMBOLS_PER_LIST} symbols, the most the server will store.` };
  }
  return { ok: true, symbol, reason: null };
}

export function addSymbolToList(lists, listName, raw) {
  const current = lists?.[listName] ?? [];
  const verdict = canAddSymbol(current, raw);
  if (!verdict.ok) return { lists, ...verdict };
  return { lists: { ...lists, [listName]: [...current, verdict.symbol] }, ...verdict };
}

/** The payload the server will accept, with the same normalisation it applies. */
export function normalizeWatchlists(lists) {
  const normalized = {};
  for (const [name, symbols] of Object.entries(lists ?? {}).slice(0, MAX_LISTS)) {
    const cleanName = sanitizeListName(name);
    if (!cleanName) continue;
    normalized[cleanName] = [...new Set((Array.isArray(symbols) ? symbols : []).map(sanitizeSymbol))]
      .filter(Boolean)
      .slice(0, MAX_SYMBOLS_PER_LIST);
  }
  return normalized;
}

/** The server's rows as the name-to-symbols object the client edits. */
export function listsFromServer(rows) {
  const adopted = {};
  for (const list of Array.isArray(rows) ? rows : []) {
    if (list?.name && Array.isArray(list.symbols)) adopted[list.name] = list.symbols;
  }
  return normalizeWatchlists(adopted);
}

/**
 * Same lists holding the same symbols in the same order. List order is
 * ignored because the server hands lists back sorted by name, so a browser's
 * own insertion order would otherwise always read as a difference.
 */
export function sameWatchlists(a, b) {
  const canonical = (lists) => JSON.stringify(Object.entries(normalizeWatchlists(lists))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  return canonical(a) === canonical(b);
}

/**
 * What a browser should do with its lists once the server has answered.
 *
 * Checking only whether anything was in localStorage could not work: the
 * defaults are written there on first render, before the server answers, so
 * every browser looked edited, a new one never picked up the server's lists,
 * and its first edit replaced them with the defaults plus that edit. Holding
 * exactly the defaults is the sign of a browser nobody has edited, and only
 * that browser adopts the server's lists. An edited one that disagrees keeps
 * its own and is told, so neither side is thrown away without a choice.
 *
 *   adopt    - show the server's lists
 *   push     - the server holds none; send this browser's edited lists
 *   keep     - nothing to do
 *   conflict - both sides edited and they differ
 */
export function reconcileWatchlists({ local, defaults, server }) {
  const serverLists = listsFromServer(server);
  const localLists = local && typeof local === 'object' ? local : {};
  const edited = Object.keys(localLists).length > 0 && !sameWatchlists(localLists, defaults);
  if (!Object.keys(serverLists).length) return { action: edited ? 'push' : 'keep', lists: localLists, serverLists };
  if (sameWatchlists(localLists, serverLists)) return { action: 'keep', lists: localLists, serverLists };
  if (!edited) return { action: 'adopt', lists: serverLists, serverLists };
  return { action: 'conflict', lists: localLists, serverLists };
}

/**
 * The first "List N" not already taken. Counting the lists was not enough:
 * after a deletion the count can name a list that still exists, and creating
 * the "new" one replaced that list with an empty one.
 */
export function nextListName(lists) {
  const taken = new Set(Object.keys(lists ?? {}));
  let number = taken.size + 1;
  while (taken.has(`List ${number}`)) number += 1;
  return `List ${number}`;
}
