// Read source JSON directly from a ZIP/ZIP64 export. Never extract names to
// the filesystem, load the entire archive, or trust advertised inflate sizes.
import fs from 'node:fs';
import { inflateRawSync } from 'node:zlib';
export const SOURCE_ZIP_ENTRY_MAX = 32 * 1024 * 1024;
const crcTable = Array.from({ length: 256 }, (_, i) => {
  let value = i; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function sourceCrc32(bytes) {
  let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function integer(value) {
  const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) throw new Error('ZIP64 integer exceeds safe range'); return number;
}
function read(fd, offset, size, end) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0 || offset + size > end) throw new Error('ZIP byte range exceeds archive');
  const bytes = Buffer.alloc(size); if (fs.readSync(fd, bytes, 0, size, offset) !== size) throw new Error('ZIP content is truncated'); return bytes;
}
export function sourceZipDirectory(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - 65557), tail = read(fd, start, size - start, size);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error('ZIP end record missing or multidisk');
    let count = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16), directoryEnd = start + end;
    if (count === 65535 || length === 0xffffffff || offset === 0xffffffff) {
      const locator = read(fd, start + end - 20, 20, size);
      if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) || locator.readUInt32LE(16) !== 1) throw new Error('ZIP64 locator invalid');
      directoryEnd = integer(locator.readBigUInt64LE(8));
      const extended = read(fd, directoryEnd, 56, size);
      if (extended.readUInt32LE(0) !== 0x06064b50 || extended.readBigUInt64LE(4) < 44n || extended.readUInt32LE(16) || extended.readUInt32LE(20)
        || extended.readBigUInt64LE(24) !== extended.readBigUInt64LE(32)) throw new Error('ZIP64 directory invalid');
      count = integer(extended.readBigUInt64LE(32)); length = integer(extended.readBigUInt64LE(40)); offset = integer(extended.readBigUInt64LE(48));
    } else if (tail.readUInt16LE(end + 8) !== count) throw new Error('ZIP directory count inconsistent');
    if (!count || count > 10000000 || offset + length !== directoryEnd) throw new Error('ZIP directory bounds inconsistent');
    return { size, count, offset, length };
  } finally { fs.closeSync(fd); }
}
export function* sourceZipEntries(file, directory) {
  const fd = fs.openSync(file, 'r');
  try {
    let offset = directory.offset;
    for (let ordinal = 0; ordinal < directory.count; ordinal++) {
      const header = read(fd, offset, 46, directory.offset + directory.length);
      if (header.readUInt32LE(0) !== 0x02014b50) throw new Error('ZIP directory entry invalid');
      const nameLength = header.readUInt16LE(28), extraLength = header.readUInt16LE(30), commentLength = header.readUInt16LE(32);
      const data = read(fd, offset + 46, nameLength + extraLength + commentLength, directory.offset + directory.length);
      const name = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, nameLength));
      if (!/^[^/\\\x00-\x1f]{1,160}\.json$/.test(name) || name.includes('..')) throw new Error('ZIP source name is not a flat JSON identity');
      let compressed = header.readUInt32LE(20), expanded = header.readUInt32LE(24), localOffset = header.readUInt32LE(42), disk = header.readUInt16LE(34);
      const flags = header.readUInt16LE(8), method = header.readUInt16LE(10);
      if (flags & ~0x0808 || ![0, 8].includes(method)) throw new Error('ZIP encrypted or unsupported compression/flags');
      if ([compressed, expanded, localOffset].includes(0xffffffff) || disk === 65535) {
        let extraOffset = nameLength, found = false;
        while (extraOffset + 4 <= nameLength + extraLength) {
          const kind = data.readUInt16LE(extraOffset), bytes = data.readUInt16LE(extraOffset + 2); extraOffset += 4;
          if (extraOffset + bytes > nameLength + extraLength) throw new Error('ZIP extra field truncated');
          if (kind === 1) {
            let at = extraOffset;
            const next = () => { if (at + 8 > extraOffset + bytes) throw new Error('ZIP64 extra field truncated'); const value = integer(data.readBigUInt64LE(at)); at += 8; return value; };
            if (expanded === 0xffffffff) expanded = next(); if (compressed === 0xffffffff) compressed = next(); if (localOffset === 0xffffffff) localOffset = next();
            if (disk === 65535) { if (at + 4 > extraOffset + bytes) throw new Error('ZIP64 disk missing'); disk = data.readUInt32LE(at); }
            found = true;
          }
          extraOffset += bytes;
        }
        if (!found) throw new Error('ZIP64 extended entry missing');
      }
      if (disk || localOffset >= directory.offset || compressed > SOURCE_ZIP_ENTRY_MAX || expanded > SOURCE_ZIP_ENTRY_MAX || !expanded)
        throw new Error(`ZIP source entry exceeds supported bounds: ${name}, compressed=${compressed}, expanded=${expanded}, disk=${disk}, localOffset=${localOffset}`);
      yield { ordinal, name, compressed, expanded, localOffset, flags, method, crc32: header.readUInt32LE(16), archiveSize: directory.size, directoryOffset: directory.offset };
      offset += 46 + data.length;
    }
    if (offset !== directory.offset + directory.length) throw new Error('ZIP directory count differs from byte length');
  } finally { fs.closeSync(fd); }
}
export function readSourceZipEntry(file, entry) {
  const fd = fs.openSync(file, 'r');
  try {
    if (![entry.compressed, entry.expanded].every(value => Number.isSafeInteger(value) && value > 0 && value <= SOURCE_ZIP_ENTRY_MAX)) throw new Error('ZIP source entry exceeds byte limit');
    const size = fs.fstatSync(fd).size;
    if (size !== entry.archiveSize) throw new Error('ZIP archive size differs');
    const header = read(fd, entry.localOffset, 30, entry.directoryOffset);
    if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== entry.flags || header.readUInt16LE(8) !== entry.method) throw new Error('ZIP local header differs');
    const nameLength = header.readUInt16LE(26), extraLength = header.readUInt16LE(28);
    const name = read(fd, entry.localOffset + 30, nameLength, entry.directoryOffset);
    if (new TextDecoder('utf-8', { fatal: true }).decode(name) !== entry.name) throw new Error('ZIP local source identity differs');
    if (!(entry.flags & 8) && header.readUInt32LE(14) !== entry.crc32) throw new Error('ZIP local CRC differs');
    const bytes = read(fd, entry.localOffset + 30 + nameLength + extraLength, entry.compressed, entry.directoryOffset);
    const output = entry.method === 0 ? bytes : inflateRawSync(bytes, { maxOutputLength: SOURCE_ZIP_ENTRY_MAX });
    if (output.length !== entry.expanded || sourceCrc32(output) !== entry.crc32) throw new Error('ZIP source length or CRC differs');
    return output;
  } finally { fs.closeSync(fd); }
}
