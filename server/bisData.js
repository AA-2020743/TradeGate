/**
 * Series from the BIS statistics API (SDMX, CSV form).
 *
 * The PBoC balance sheet used to come through DBnomics, a mirror of BIS data.
 * The mirror stopped refreshing at 2025-03 while the BIS itself carried
 * 2026-06, so the series was marked abandoned and dropped from the global
 * liquidity pool for over a year of data the source still published.
 */

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and newlines. */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text ?? '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Monthly observations from a BIS SDMX CSV response, newest first, in the
 * `{ date, value }` shape the macro series use.
 */
export function parseBisMonthlySeries(csv) {
  const [header, ...rows] = parseCsvRows(csv);
  if (!header) throw new Error('The BIS returned an empty response');
  const period = header.indexOf('TIME_PERIOD');
  const value = header.indexOf('OBS_VALUE');
  if (period < 0 || value < 0) throw new Error('The BIS response has no TIME_PERIOD and OBS_VALUE columns');
  return rows
    // An empty OBS_VALUE is a missing month, not a zero: Number('') is 0.
    .filter((row) => String(row[value] ?? '').trim() !== '')
    .map((row) => ({ period: row[period], value: Number(row[value]) }))
    .filter((entry) => /^\d{4}-\d{2}$/.test(entry.period ?? '') && Number.isFinite(entry.value))
    .map((entry) => ({ date: `${entry.period}-01`, value: entry.value, realtimeStart: null, realtimeEnd: null }))
    .sort((left, right) => right.date.localeCompare(left.date));
}

