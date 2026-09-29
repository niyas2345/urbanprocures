const LIMITS = Object.freeze({ maxEntries: 500, maxUncompressedBytes: 250 * 1024 * 1024, maxCompressionRatio: 200 });

export function inspectZipArchive(bytes, limits = LIMITS) {
  const buf = toBuffer(bytes); const entries = []; let offset = 0; let total = 0;
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) return blocked('not_a_zip');
  while (offset + 30 <= buf.length && entries.length < limits.maxEntries) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;
    const compressed = buf.readUInt32LE(offset + 18); const uncompressed = buf.readUInt32LE(offset + 22); const nameLength = buf.readUInt16LE(offset + 26); const extraLength = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    if (!name || name.includes('..') || name.startsWith('/') || name.includes('\\') || /.(?:exe|dll|bat|cmd|com|scr|js|vbs|ps1)$/i.test(name)) return blocked('unsafe_archive_entry', name);
    total += uncompressed; entries.push({ name, compressed_bytes: compressed, uncompressed_bytes: uncompressed, directory: name.endsWith('/') });
    if (total > limits.maxUncompressedBytes || (compressed > 0 && uncompressed / compressed > limits.maxCompressionRatio)) return blocked('archive_expansion_limit', name);
    offset += 30 + nameLength + extraLength + compressed;
  }
  if (entries.length >= limits.maxEntries) return blocked('archive_entry_limit');
  return { safe: true, format: 'zip', entry_count: entries.length, uncompressed_bytes: total, entries, requires_human_review: true, reason: 'archive_inspected_not_extracted' };
}

function blocked(reason, entry = null) { return { safe: false, format: 'zip', entry_count: 0, uncompressed_bytes: 0, entries: [], requires_human_review: true, reason, entry }; }
function toBuffer(bytes) { if (Buffer.isBuffer(bytes)) return bytes; if (bytes instanceof ArrayBuffer) return Buffer.from(bytes); if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength); return Buffer.from(bytes || []); }
