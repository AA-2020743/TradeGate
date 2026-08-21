export const SCREENER_COLUMNS = [
  { key: 'symbol', label: 'Symbol', type: 'text' },
  { key: 'last', label: 'Last', type: 'number' },
  { key: 'mom20', label: '20D', type: 'number' },
  { key: 'mom60', label: '60D', type: 'number' },
  { key: 'vsSma200', label: 'vs 200D', type: 'number' },
  { key: 'rsi14', label: 'RSI-14', type: 'number' },
  { key: 'vol20', label: 'Vol 20D', type: 'number' },
  { key: 'trendQuality', label: 'Trend 90D', type: 'number' },
  { key: 'score', label: 'Score', type: 'number' },
];

const COLUMN_BY_KEY = new Map(SCREENER_COLUMNS.map((column) => [column.key, column]));

/**
 * Cycles a header between its natural direction, the reverse, and off — where
 * off hands sorting back to whichever screen is selected.
 */
export function nextSortState(current, key) {
  const column = COLUMN_BY_KEY.get(key);
  if (!column) return current ?? null;
  const naturalDirection = column.type === 'text' ? 'asc' : 'desc';
  if (current?.key !== key) return { key, direction: naturalDirection };
  if (current.direction === naturalDirection) return { key, direction: naturalDirection === 'asc' ? 'desc' : 'asc' };
  return null;
}

/**
 * Sorts by an explicit column when one is chosen, otherwise by the screen's own
 * ordering. A row missing the sorted metric always sinks, in either direction:
 * an absent reading is not a small one.
 */
export function sortRows(rows, sort, fallbackCompare) {
  const list = Array.isArray(rows) ? [...rows] : [];
  const column = sort ? COLUMN_BY_KEY.get(sort.key) : null;
  if (!column) return typeof fallbackCompare === 'function' ? list.sort(fallbackCompare) : list;
  const sign = sort.direction === 'asc' ? 1 : -1;
  return list.sort((left, right) => {
    const leftValue = left?.[column.key];
    const rightValue = right?.[column.key];
    if (column.type === 'text') {
      const leftText = typeof leftValue === 'string' ? leftValue : '';
      const rightText = typeof rightValue === 'string' ? rightValue : '';
      if (!leftText || !rightText) return leftText ? -1 : rightText ? 1 : 0;
      return sign * leftText.localeCompare(rightText);
    }
    const leftReading = Number.isFinite(leftValue);
    const rightReading = Number.isFinite(rightValue);
    if (!leftReading || !rightReading) return leftReading ? -1 : rightReading ? 1 : 0;
    return sign * (leftValue - rightValue);
  });
}

export function ariaSortFor(sort, key) {
  if (sort?.key !== key) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}
