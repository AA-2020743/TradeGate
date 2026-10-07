import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listZipEntries, readLargestTextEntry } from './zip.js';

// Fixtures were written by Python's zipfile, an independent implementation,
// so these test the reader against the format rather than against itself.
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

test('a deflated archive yields its largest text entry', () => {
  const entries = listZipEntries(fixture('deflated.zip'));
  assert.equal(entries.length, 2);
  const text = readLargestTextEntry(fixture('deflated.zip'));
  assert.match(text, /,Mom/);
  assert.match(text, /19261103,\s+0\.56/);
});

test('a stored (uncompressed) archive reads the same', () => {
  assert.equal(readLargestTextEntry(fixture('stored.zip')), readLargestTextEntry(fixture('deflated.zip')));
});

test('a streamed archive is read from the central directory, not the zeroed local sizes', () => {
  // Streaming writers set flag bit 3 and leave the local header's sizes at
  // zero; a reader that trusts the local header gets an empty file.
  const buffer = fixture('streamed.zip');
  assert.equal(buffer.readUInt16LE(6) & 0x08, 0x08);
  assert.equal(buffer.readUInt32LE(18), 0);
  assert.equal(readLargestTextEntry(buffer), readLargestTextEntry(fixture('deflated.zip')));
});

test('something that is not a zip fails with a reason', () => {
  assert.throws(() => listZipEntries(Buffer.from('<html>blocked</html>'.padEnd(200, ' '))), /Not a zip archive/);
});
