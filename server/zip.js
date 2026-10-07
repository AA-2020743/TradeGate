import { inflateRawSync } from 'node:zlib';

/**
 * Just enough of the zip format to read a published data archive: find the
 * central directory, pick an entry, inflate it. No dependency, because the
 * one archive this reads is a single CSV and a general zip library is a large
 * surface to carry for that.
 *
 * Sizes and offsets are read from the central directory rather than the local
 * header, because writers that stream (bit 3 set) leave the local header's
 * sizes as zero and put the real ones after the data.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export function listZipEntries(buffer) {
  // The end-of-central-directory record is the last 22 bytes plus any comment
  // (up to 65,535 bytes), so search backwards for its signature.
  const floor = Math.max(0, buffer.length - 22 - 65_535);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('Not a zip archive: no end-of-central-directory record');
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error('Corrupt zip: bad central directory entry');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    entries.push({ name, method, compressedSize, size, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function readZipEntry(buffer, entry) {
  if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) throw new Error(`Corrupt zip: bad local header for ${entry.name}`);
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.name}`);
}

/** The largest CSV or TXT entry, decoded - which is what a single-table data archive contains. */
export function readLargestTextEntry(buffer) {
  const candidates = listZipEntries(buffer).filter((entry) => /\.(csv|txt)$/i.test(entry.name) && !entry.name.endsWith('/'));
  if (!candidates.length) throw new Error('The archive contains no CSV or TXT file');
  const entry = candidates.sort((left, right) => right.size - left.size)[0];
  // These files are plain ASCII digits and commas; latin1 decodes any byte
  // without throwing, where a strict UTF-8 decode can fail on a stray symbol
  // in the copyright header.
  return readZipEntry(buffer, entry).toString('latin1');
}
