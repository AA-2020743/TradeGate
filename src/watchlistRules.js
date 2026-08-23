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
