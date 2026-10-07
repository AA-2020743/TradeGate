import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWorkbookStream, readCompoundFile, readWorkbook, sheetRows } from './xls.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

// The .cells.json files are xlrd's reading of the same workbooks: every cell
// xlrd sees must come back identical, and no extra ones.
function assertMatchesReference(workbook, reference) {
  assert.deepEqual(workbook.sheets.map((sheet) => sheet.name), reference.map((sheet) => sheet.name));
  reference.forEach((expected, index) => {
    const cells = workbook.sheets[index].cells;
    let count = 0;
    for (const row of cells.values()) count += row.size;
    assert.equal(count, expected.cells.length, `${expected.name}: cell count`);
    for (const [row, column, value] of expected.cells) {
      assert.equal(cells.get(row)?.get(column), value, `${expected.name} R${row}C${column}`);
    }
  });
}

test('a Shiller-shaped workbook reads cell for cell as xlrd reads it', () => {
  const workbook = readWorkbook(fixture('shiller-sample.xls'));
  assertMatchesReference(workbook, JSON.parse(fixture('shiller-sample.cells.json')));
  const notes = workbook.sheets[0].cells;
  // Shared strings run past one record into CONTINUE records, some stored
  // two bytes per character.
  assert.match(notes.get(419).get(0), /^Note 419: /);
  assert.match(notes.get(413).get(0), /€é中$/);
});

test('a workbook small enough for the mini stream reads through the mini FAT', () => {
  const streams = readCompoundFile(fixture('mini-stream.xls'));
  assert.ok(streams.get('Workbook').length < 4096);
  const workbook = readWorkbook(fixture('mini-stream.xls'));
  assertMatchesReference(workbook, JSON.parse(fixture('mini-stream.cells.json')));
  assert.deepEqual(sheetRows(workbook.sheets[0]), [['Date', 'P'], [2026.09, -12.5], [null, 7]]);
});

// Hand-built BIFF8 records, for what xlwt never writes.
function record(type, ...parts) {
  const data = Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))));
  const header = Buffer.alloc(4);
  header.writeUInt16LE(type, 0);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
}
const u16 = (value) => { const buffer = Buffer.alloc(2); buffer.writeUInt16LE(value); return buffer; };
const u32 = (value) => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value >>> 0); return buffer; };
const f64 = (value) => { const buffer = Buffer.alloc(8); buffer.writeDoubleLE(value); return buffer; };
const cellHeader = (row, column) => Buffer.concat([u16(row), u16(column), u16(15)]);
const bof = (kind) => record(0x0809, u16(0x0600), u16(kind), Buffer.alloc(12));
const eof = () => record(0x000a);

function workbookStream(globals, sheetBody) {
  // BOUNDSHEET needs the sheet's offset, so the globals are laid out first.
  const name = Buffer.from('S', 'latin1');
  const boundsheet = (position) => record(0x0085, u32(position), Buffer.from([0, 0, name.length, 0]), name);
  const head = Buffer.concat([bof(0x0005), ...globals]);
  const position = head.length + boundsheet(0).length + eof().length;
  return Buffer.concat([head, boundsheet(position), eof(), bof(0x0010), ...sheetBody, eof()]);
}

test('RK numbers decode as integers, hundredths and truncated doubles; MULRK spreads across columns', () => {
  const rkInteger = (value, hundredths = false) => ((value << 2) | 0x02 | (hundredths ? 0x01 : 0)) >>> 0;
  const rkDouble = (value) => { const buffer = f64(value); return buffer.readUInt32LE(4) & 0xfffffffc; };
  const stream = workbookStream([], [
    record(0x027e, cellHeader(0, 0), u32(rkInteger(-42))),
    record(0x027e, cellHeader(0, 1), u32(rkInteger(187101, true))),
    record(0x027e, cellHeader(0, 2), u32(rkDouble(0.5))),
    record(0x00bd, u16(1), u16(3), u16(15), u32(rkInteger(1)), u16(15), u32(rkInteger(2)), u16(15), u32(rkInteger(3)), u16(5)),
  ]);
  const rows = sheetRows(parseWorkbookStream(stream).sheets[0]);
  assert.deepEqual(rows[0], [-42, 1871.01, 0.5]);
  assert.deepEqual(rows[1], [null, null, null, 1, 2, 3]);
});

test('formulas yield their cached results: numbers, strings from the STRING record, booleans; errors stay empty', () => {
  const special = (kind, value = 0) => Buffer.from([kind, 0, value, 0, 0, 0, 0xff, 0xff]);
  const formula = (row, column, result) => record(0x0006, cellHeader(row, column), result, u16(0), u32(0), u16(0));
  const stream = workbookStream([], [
    formula(0, 0, f64(31.42)),
    formula(0, 1, special(0)),
    record(0x0207, u16(4), Buffer.from([0]), Buffer.from('CAPE', 'latin1')),
    formula(0, 2, special(1, 1)),
    formula(0, 3, special(2, 0x07)),
    formula(0, 4, special(3)),
  ]);
  const cells = parseWorkbookStream(stream).sheets[0].cells.get(0);
  assert.equal(cells.get(0), 31.42);
  assert.equal(cells.get(1), 'CAPE');
  assert.equal(cells.get(2), true);
  assert.equal(cells.has(3), false, '#DIV/0! is not a value');
  assert.equal(cells.get(4), '');
});

test('a shared string split across CONTINUE records may change width mid-string', () => {
  // "Real earnings" begins as one byte per character and resumes, after the
  // record boundary, as two - the option byte is repeated at the boundary.
  const first = Buffer.concat([u32(2), u32(2), u16(1), Buffer.from([0]), Buffer.from('D', 'latin1'), u16(13), Buffer.from([0]), Buffer.from('Real ', 'latin1')]);
  const continued = Buffer.concat([Buffer.from([1]), Buffer.from('earnings', 'utf16le')]);
  const stream = workbookStream(
    [record(0x00fc, first), record(0x003c, continued)],
    [record(0x00fd, cellHeader(0, 0), u32(0)), record(0x00fd, cellHeader(0, 1), u32(1))],
  );
  assert.deepEqual(sheetRows(parseWorkbookStream(stream).sheets[0])[0], ['D', 'Real earnings']);
});

test('files that are not BIFF8 workbooks are refused with a reason', () => {
  assert.throws(() => readWorkbook(Buffer.from('PK\u0003\u0004 not an xls at all, but a zip header and then some padding'.padEnd(600))), /not an OLE2 compound file/);
  const biff5 = Buffer.concat([record(0x0809, u16(0x0500), u16(5), Buffer.alloc(4)), eof()]);
  assert.throws(() => parseWorkbookStream(biff5), /only BIFF8/);
});
