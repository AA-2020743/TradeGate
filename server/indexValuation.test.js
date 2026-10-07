import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculateIndexValuation, findShillerDataLink, parseShillerRows } from './indexValuation.js';
import { readWorkbook, sheetRows } from './xls.js';

function monthsFrom(startYear, count, fill) {
  return Array.from({ length: count }, (_unused, index) => {
    const year = startYear + Math.floor(index / 12);
    const month = (index % 12) + 1;
    return { key: `${year}-${String(month).padStart(2, '0')}`, year, month, dividend: null, gs10: null, ...fill(index) };
  });
}

test('the monthly table is found by its headers, dates decode as year.month, and footnotes are skipped', () => {
  const parsed = parseShillerRows([
    ['U.S. Stock Markets 1871-Present'],
    [],
    ['Date', 'P', 'D', 'E', 'CPI', 'Date', 'Rate GS10'],
    ...Array.from({ length: 30 }, (_unused, index) => [1871 + Math.floor(index / 12) + ((index % 12) + 1) / 100, 4.44, 0.26, 0.4, 12.46, 0, 5.32]),
    ['Source: Standard & Poor’s'],
    [2026.1, 6600, null, 'NA', 330],
  ]);
  assert.equal(parsed.status, 'ready');
  assert.equal(parsed.months[0].key, '1871-01');
  assert.equal(parsed.months[9].key, '1871-10', '1871.1 is October, not January');
  const last = parsed.months.at(-1);
  assert.deepEqual([last.key, last.price, last.earnings, last.dividend], ['2026-10', 6600, null, null], 'a text "NA" earnings cell is missing, not zero');
  assert.equal(parseShillerRows([['Year', 'Close'], [2020, 1]]).status, 'unavailable');
});

test('the Shiller-shaped fixture workbook parses end to end', () => {
  const workbook = readWorkbook(readFileSync(new URL('./fixtures/shiller-sample.xls', import.meta.url)));
  const data = workbook.sheets.find((sheet) => sheet.name === 'Data');
  const parsed = parseShillerRows(sheetRows(data));
  assert.equal(parsed.status, 'ready');
  assert.equal(parsed.months.length, 441);
  assert.equal(parsed.months.at(-1).key, '2026-09');
  assert.equal(parsed.months.at(-1).earnings, null, 'the last six months carry no earnings yet');
  assert.equal(parseShillerRows(sheetRows(workbook.sheets[0])).status, 'unavailable', 'the notes sheet is not mistaken for data');
});

test('CAPE is price over ten years of real earnings, and inflation cancels out of it', () => {
  const flat = calculateIndexValuation(monthsFrom(1950, 200, () => ({ price: 100, earnings: 5, cpi: 50 })));
  assert.equal(flat.cape, 20);
  assert.equal(flat.earningsYield, 5);
  // Prices, earnings and CPI all doubling over the span: real CAPE is unchanged.
  const inflating = calculateIndexValuation(monthsFrom(1950, 200, (index) => {
    const level = 2 ** (index / 199);
    return { price: 100 * level, earnings: 5 * level, cpi: 50 * level };
  }));
  assert.ok(Math.abs(inflating.cape - 20) < 0.6, `${inflating.cape}`);
});

test('the latest prices are set against the last reported earnings, but not beyond nine months of lag', () => {
  const lagged = monthsFrom(1950, 200, (index) => ({ price: index >= 194 ? 120 : 100, earnings: index >= 194 ? null : 5, cpi: 50 }));
  const result = calculateIndexValuation(lagged);
  assert.equal(result.asOf, '1966-08');
  assert.equal(result.earningsThrough, '1966-02');
  assert.equal(result.cape, 24, 'today’s price over the last ten reported years');
  const stale = calculateIndexValuation(monthsFrom(1950, 200, (index) => ({ price: 100, earnings: index >= 185 ? null : 5, cpi: 50 })));
  assert.equal(stale.asOf, '1966-02', 'months more than nine past the last earnings carry no CAPE');
});

// 156 years in which valuation mean-reverts: real earnings grow steadily, the
// price multiple wanders slowly around its mean, so a cheap market is
// followed by multiple expansion and a dear one by contraction.
function meanRevertingHistory() {
  let seed = 5;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
  let multiple = 0;
  return monthsFrom(1871, 156 * 12 - 3, (index) => {
    multiple = 0.985 * multiple + 0.05 * random();
    const cpi = 10 * 1.0017 ** index;
    const earnings = 0.5 * 1.0013 ** index * (1 + 0.1 * random()) * (cpi / 10);
    const price = 15 * Math.exp(multiple) * 0.5 * 1.0013 ** index * (cpi / 10);
    return { price, earnings, dividend: earnings * 0.5, cpi, gs10: 4 + 0.5 * random() };
  });
}

test('over a long mean-reverting history, a higher excess yield is followed by higher returns, out of sample too', () => {
  const result = calculateIndexValuation(meanRevertingHistory());
  assert.equal(result.status, 'calculated');
  assert.equal(result.historyFrom.slice(0, 4), '1880');
  assert.ok(Number.isFinite(result.capePercentileSince1950), 'a record reaching before 1950 also ranks since 1950');
  const { outlook } = result;
  assert.equal(outlook.status, 'calculated');
  assert.ok(outlook.slope > 0, `slope ${outlook.slope}`);
  assert.ok(outlook.independentDecades >= 13 && outlook.independentDecades <= 15, `${outlook.independentDecades}`);
  assert.equal(outlook.outOfSample.status, 'calculated');
  assert.equal(outlook.outOfSample.beatsNaive, true);
  assert.equal(outlook.buckets.filter((bucket) => bucket.current).length, 1);
  const medians = outlook.buckets.map((bucket) => bucket.medianForwardReturn);
  assert.ok(medians[4] > medians[0], `quintile medians ${medians}`);
  assert.match(result.read, /independent decades of evidence/);
  assert.match(result.read, /missed post-1990 outcomes by/);
});

test('without a current 10-year yield in the file, TIPS stands in and the read says the definitions are mixed', () => {
  const months = meanRevertingHistory();
  months.at(-1).gs10 = null;
  const result = calculateIndexValuation(months, { realYield10y: 1.8, realYieldDate: '2026-10-03' });
  assert.equal(result.mixedDefinitions, true);
  assert.equal(result.realRate, 1.8);
  assert.match(result.read, /mixes definitions/);
  // With the yield present, TIPS is shown beside the history-comparable figure, not ranked.
  const consistent = calculateIndexValuation(meanRevertingHistory(), { realYield10y: 1.8 });
  assert.equal(consistent.mixedDefinitions, false);
  assert.ok(Number.isFinite(consistent.excessYieldWithTips));
  assert.notEqual(consistent.excessYield, consistent.excessYieldWithTips);
});

test('too little history refuses with a reason', () => {
  const result = calculateIndexValuation(monthsFrom(2020, 60, () => ({ price: 100, earnings: 5, cpi: 50 })));
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /more than ten years/);
});

test('the data file is found by its link on the page, wherever it is hosted this month', () => {
  const page = '<a href="/about">About</a><a class="btn" href="https://img1.wsimg.com/blobby/go/abc/downloads/ie_data.xls?ver=1759&amp;x=1">Download</a>';
  assert.equal(findShillerDataLink(page), 'https://img1.wsimg.com/blobby/go/abc/downloads/ie_data.xls?ver=1759&x=1');
  assert.equal(findShillerDataLink("<a href='/downloads/IE_DATA.XLS'>x</a>"), 'https://shillerdata.com/downloads/IE_DATA.XLS');
  assert.equal(findShillerDataLink('<p>No files here.</p>'), null);
});
