import { strict as assert } from 'node:assert';
import test from 'node:test';
import { inspectZipArchive } from './archive-inspector.js';

test('archive inspector reports safe ZIP entries without extracting them', () => {
  const data = Buffer.from('hello'); const name = Buffer.from('boq.csv'); const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
  const result = inspectZipArchive(Buffer.concat([header, name, data]));
  assert.equal(result.safe, true); assert.equal(result.entry_count, 1); assert.equal(result.entries[0].name, 'boq.csv');
});

test('archive inspector blocks traversal and executable entries', () => {
  const data = Buffer.from('x'); const name = Buffer.from('../run.exe'); const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
  assert.equal(inspectZipArchive(Buffer.concat([header, name, data])).safe, false);
});
