/**
 * A reader for legacy Excel workbooks (.xls, BIFF8), with no dependencies.
 *
 * Shiller's long-run S&P 500 dataset - the only free, keyless source of
 * index earnings back to 1871 - is published only as .xls. The format is two
 * layers: an OLE2 compound file (a small FAT filesystem) holding a
 * "Workbook" stream, and inside that stream a sequence of BIFF records.
 *
 * Only cell values are read: numbers, shared and inline strings, and the
 * cached results of formulas. Formats, styles and dates-as-serials are not
 * interpreted; a cell holding 1871.01 is the number 1871.01.
 */

const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;

function fail(message) {
  throw new Error(`Unreadable .xls: ${message}`);
}

/** The named streams of an OLE2 compound file. */
export function readCompoundFile(buffer) {
  if (buffer.length < 512 || !buffer.subarray(0, 8).equals(SIGNATURE)) fail('not an OLE2 compound file');
  const sectorSize = 1 << buffer.readUInt16LE(0x1e);
  const miniSectorSize = 1 << buffer.readUInt16LE(0x20);
  const fatSectorCount = buffer.readUInt32LE(0x2c);
  const firstDirectorySector = buffer.readUInt32LE(0x30);
  const miniStreamCutoff = buffer.readUInt32LE(0x38);
  const firstMiniFatSector = buffer.readUInt32LE(0x3c);
  const firstDifatSector = buffer.readUInt32LE(0x44);
  const difatSectorCount = buffer.readUInt32LE(0x48);
  const entriesPerSector = sectorSize / 4;
  const sectorOffset = (sector) => (sector + 1) * sectorSize;
  const sector = (index) => {
    const start = sectorOffset(index);
    if (start >= buffer.length) fail(`sector ${index} lies beyond the file`);
    return buffer.subarray(start, Math.min(start + sectorSize, buffer.length));
  };

  // The FAT's own sectors: 109 listed in the header, the rest in a DIFAT chain.
  const fatSectors = [];
  for (let index = 0; index < 109 && fatSectors.length < fatSectorCount; index += 1) fatSectors.push(buffer.readUInt32LE(0x4c + index * 4));
  let difat = firstDifatSector;
  for (let hop = 0; hop < difatSectorCount && difat !== END_OF_CHAIN && difat !== FREE_SECTOR; hop += 1) {
    const data = sector(difat);
    for (let index = 0; index < entriesPerSector - 1 && fatSectors.length < fatSectorCount; index += 1) fatSectors.push(data.readUInt32LE(index * 4));
    difat = data.readUInt32LE((entriesPerSector - 1) * 4);
  }
  const fat = [];
  for (const fatSector of fatSectors) {
    const data = sector(fatSector);
    for (let index = 0; index < entriesPerSector; index += 1) fat.push(data.readUInt32LE(index * 4));
  }

  const chain = (start, table) => {
    const sectors = [];
    const seen = new Set();
    for (let current = start; current !== END_OF_CHAIN && current !== FREE_SECTOR; current = table[current]) {
      if (current >= table.length || seen.has(current)) fail('a sector chain is broken or loops');
      seen.add(current);
      sectors.push(current);
    }
    return sectors;
  };
  const readChain = (start) => Buffer.concat(chain(start, fat).map(sector));

  const directory = readChain(firstDirectorySector);
  const entries = [];
  for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
    const nameLength = directory.readUInt16LE(offset + 0x40);
    const type = directory[offset + 0x42];
    if (!type) continue;
    entries.push({
      name: directory.subarray(offset, offset + Math.max(0, nameLength - 2)).toString('utf16le'),
      type,
      start: directory.readUInt32LE(offset + 0x74),
      size: directory.readUInt32LE(offset + 0x78),
    });
  }
  const root = entries.find((entry) => entry.type === 5);
  if (!root) fail('no root directory entry');

  // Small streams live in the root's mini stream, chained by the mini FAT.
  let miniStream = null;
  let miniFat = null;
  const loadMini = () => {
    if (miniStream) return;
    miniStream = readChain(root.start);
    miniFat = [];
    if (firstMiniFatSector !== END_OF_CHAIN) {
      const data = readChain(firstMiniFatSector);
      for (let offset = 0; offset + 4 <= data.length; offset += 4) miniFat.push(data.readUInt32LE(offset));
    }
  };

  const streams = new Map();
  for (const entry of entries) {
    if (entry.type !== 2) continue;
    let data;
    if (entry.size < miniStreamCutoff) {
      loadMini();
      data = Buffer.concat(chain(entry.start, miniFat).map((index) => miniStream.subarray(index * miniSectorSize, (index + 1) * miniSectorSize)));
    } else {
      data = readChain(entry.start);
    }
    streams.set(entry.name, data.subarray(0, entry.size));
  }
  return streams;
}

/**
 * Reads across a record and its CONTINUE records. A string whose characters
 * run past a record boundary resumes after a fresh option byte saying whether
 * the rest is one or two bytes per character - Excel may switch mid-string.
 */
class SegmentReader {
  constructor(segments) {
    this.segments = segments;
    this.segment = 0;
    this.offset = 0;
  }

  get current() {
    return this.segments[this.segment];
  }

  atSegmentEnd() {
    return this.offset >= this.current.length;
  }

  advanceIfExhausted() {
    while (this.segment < this.segments.length - 1 && this.atSegmentEnd()) {
      this.segment += 1;
      this.offset = 0;
    }
  }

  bytes(count) {
    const parts = [];
    let remaining = count;
    while (remaining > 0) {
      this.advanceIfExhausted();
      if (this.atSegmentEnd()) fail('a record ends mid-value');
      const take = Math.min(remaining, this.current.length - this.offset);
      parts.push(this.current.subarray(this.offset, this.offset + take));
      this.offset += take;
      remaining -= take;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  uint8() { return this.bytes(1)[0]; }
  uint16() { return this.bytes(2).readUInt16LE(0); }
  uint32() { return this.bytes(4).readUInt32LE(0); }

  characters(count, highByte) {
    let text = '';
    let wide = highByte;
    let remaining = count;
    while (remaining > 0) {
      if (this.atSegmentEnd()) {
        if (this.segment >= this.segments.length - 1) fail('a string ends early');
        this.segment += 1;
        this.offset = 0;
        wide = (this.uint8() & 0x01) === 1;
      }
      const width = wide ? 2 : 1;
      const available = Math.floor((this.current.length - this.offset) / width);
      const take = Math.min(remaining, available);
      if (take === 0) fail('a string character is split across records');
      const raw = this.current.subarray(this.offset, this.offset + take * width);
      text += wide ? raw.toString('utf16le') : raw.toString('latin1');
      this.offset += take * width;
      remaining -= take;
    }
    return text;
  }

  /** XLUnicodeRichExtendedString: the SST entry format. */
  richString() {
    this.advanceIfExhausted();
    const count = this.uint16();
    const flags = this.uint8();
    const runs = flags & 0x08 ? this.uint16() : 0;
    const extended = flags & 0x04 ? this.uint32() : 0;
    const text = this.characters(count, (flags & 0x01) === 1);
    if (runs) this.bytes(runs * 4);
    if (extended) this.bytes(extended);
    return text;
  }
}

function decodeRk(rk) {
  let value;
  if (rk & 0x02) {
    value = rk >> 2; // signed 30-bit integer
  } else {
    const bytes = Buffer.alloc(8);
    bytes.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    value = bytes.readDoubleLE(0);
  }
  return rk & 0x01 ? value / 100 : value;
}

function readRecords(stream, start = 0) {
  const records = [];
  let offset = start;
  while (offset + 4 <= stream.length) {
    const type = stream.readUInt16LE(offset);
    const length = stream.readUInt16LE(offset + 2);
    records.push({ type, data: stream.subarray(offset + 4, offset + 4 + length), offset });
    offset += 4 + length;
  }
  return records;
}

const RECORD = {
  BOF: 0x0809,
  EOF: 0x000a,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  FORMULA: 0x0006,
  STRING: 0x0207,
  BOOLERR: 0x0205,
};

function withContinues(records, index) {
  const segments = [records[index].data];
  let next = index + 1;
  while (next < records.length && records[next].type === RECORD.CONTINUE) {
    segments.push(records[next].data);
    next += 1;
  }
  return { segments, next };
}

/**
 * @returns {{ sheets: Array<{ name: string, cells: Map<number, Map<number, number|string|boolean>> }> }}
 */
export function readWorkbook(buffer) {
  const streams = readCompoundFile(buffer);
  const stream = streams.get('Workbook') ?? streams.get('Book');
  if (!stream) fail('no Workbook stream');
  return parseWorkbookStream(stream);
}

/** The BIFF8 record layer alone: a Workbook stream's bytes to sheets of cells. */
export function parseWorkbookStream(stream) {
  const records = readRecords(stream);
  const first = records[0];
  if (!first || first.type !== RECORD.BOF) fail('the Workbook stream does not open with a BOF record');
  if (first.data.readUInt16LE(0) !== 0x0600) fail('only BIFF8 (Excel 97 and later) is supported');

  const sheetsMeta = [];
  let sharedStrings = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.type === RECORD.EOF) break;
    if (record.type === RECORD.BOUNDSHEET) {
      const position = record.data.readUInt32LE(0);
      const kind = record.data[5];
      const count = record.data[6];
      const wide = (record.data[7] & 0x01) === 1;
      const name = wide ? record.data.subarray(8, 8 + count * 2).toString('utf16le') : record.data.subarray(8, 8 + count).toString('latin1');
      sheetsMeta.push({ name, position, kind });
    } else if (record.type === RECORD.SST) {
      const { segments } = withContinues(records, index);
      const reader = new SegmentReader(segments);
      reader.uint32();
      const unique = reader.uint32();
      sharedStrings = [];
      for (let entry = 0; entry < unique; entry += 1) sharedStrings.push(reader.richString());
    }
  }

  const sheets = [];
  for (const meta of sheetsMeta) {
    if (meta.kind !== 0) continue; // worksheets only, not charts or macros
    const cells = new Map();
    const set = (row, column, value) => {
      if (!cells.has(row)) cells.set(row, new Map());
      cells.get(row).set(column, value);
    };
    const sheetRecords = readRecords(stream, meta.position);
    let pendingFormula = null;
    for (let index = 1; index < sheetRecords.length; index += 1) {
      const { type, data } = sheetRecords[index];
      if (type === RECORD.EOF || type === RECORD.BOF) break;
      if (type === RECORD.NUMBER) {
        set(data.readUInt16LE(0), data.readUInt16LE(2), data.readDoubleLE(6));
      } else if (type === RECORD.RK) {
        set(data.readUInt16LE(0), data.readUInt16LE(2), decodeRk(data.readUInt32LE(6)));
      } else if (type === RECORD.MULRK) {
        const row = data.readUInt16LE(0);
        const firstColumn = data.readUInt16LE(2);
        const count = (data.length - 6) / 6;
        for (let item = 0; item < count; item += 1) set(row, firstColumn + item, decodeRk(data.readUInt32LE(4 + item * 6 + 2)));
      } else if (type === RECORD.LABELSST) {
        const value = sharedStrings[data.readUInt32LE(6)];
        if (value !== undefined) set(data.readUInt16LE(0), data.readUInt16LE(2), value);
      } else if (type === RECORD.LABEL) {
        const { segments } = withContinues(sheetRecords, index);
        const reader = new SegmentReader(segments);
        const row = reader.uint16();
        const column = reader.uint16();
        reader.uint16();
        const count = reader.uint16();
        set(row, column, reader.characters(count, (reader.uint8() & 0x01) === 1));
      } else if (type === RECORD.FORMULA) {
        const row = data.readUInt16LE(0);
        const column = data.readUInt16LE(2);
        if (data.readUInt16LE(12) !== 0xffff) {
          set(row, column, data.readDoubleLE(6));
        } else if (data[6] === 0) {
          pendingFormula = { row, column }; // the text follows in a STRING record
        } else if (data[6] === 1) {
          set(row, column, data[8] === 1);
        } else if (data[6] === 3) {
          set(row, column, '');
        } // 2 is an error value (#N/A, #DIV/0!): left empty
      } else if (type === RECORD.STRING && pendingFormula) {
        const { segments } = withContinues(sheetRecords, index);
        const reader = new SegmentReader(segments);
        const count = reader.uint16();
        set(pendingFormula.row, pendingFormula.column, reader.characters(count, (reader.uint8() & 0x01) === 1));
        pendingFormula = null;
      } else if (type === RECORD.BOOLERR) {
        if (data[7] === 0) set(data.readUInt16LE(0), data.readUInt16LE(2), data[6] === 1);
      }
    }
    sheets.push({ name: meta.name, cells });
  }
  return { sheets };
}

/** A sheet's cells as a dense array of rows, for scanning. */
export function sheetRows(sheet) {
  const lastRow = Math.max(-1, ...sheet.cells.keys());
  return Array.from({ length: lastRow + 1 }, (_unused, row) => {
    const cells = sheet.cells.get(row);
    if (!cells) return [];
    const lastColumn = Math.max(...cells.keys());
    return Array.from({ length: lastColumn + 1 }, (_value, column) => (cells.has(column) ? cells.get(column) : null));
  });
}
