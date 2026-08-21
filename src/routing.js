export const NAV_LABELS = ['Overview', 'Markets', 'Equities', 'Metals', 'Screener', 'Watchlists', 'Macro', 'Forex', 'Crypto'];

const LABEL_BY_SLUG = new Map(NAV_LABELS.map((label) => [label.toLowerCase(), label]));

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Reads `#/screener` or `#/overview/BTC` into the workspace it addresses.
 * Anything unrecognized falls back to the default view rather than rendering
 * a blank workspace, and the symbol is only honored when it is one the
 * caller actually tracks.
 */
export function parseRoute(hash, knownSymbols = []) {
  const raw = String(hash ?? '').replace(/^#/, '').replace(/^\/+/, '');
  const [navSegment = '', symbolSegment = ''] = raw.split('/');
  const nav = LABEL_BY_SLUG.get(safeDecode(navSegment).trim().toLowerCase()) ?? NAV_LABELS[0];
  const wanted = safeDecode(symbolSegment).trim().toUpperCase();
  const symbol = wanted ? knownSymbols.find((candidate) => String(candidate).toUpperCase() === wanted) ?? null : null;
  return { nav, symbol };
}

export function buildRoute(nav, symbol = null) {
  const slug = String(nav ?? '').trim().toLowerCase();
  const label = LABEL_BY_SLUG.has(slug) ? slug : NAV_LABELS[0].toLowerCase();
  const ticker = symbol === null || symbol === undefined ? '' : String(symbol).trim().toUpperCase();
  return ticker ? `#/${label}/${encodeURIComponent(ticker)}` : `#/${label}`;
}
