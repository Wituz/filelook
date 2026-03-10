import { inflateRawSync } from 'node:zlib';
import { MAX_DECOMPRESSED_BYTES } from '../../safety.ts';

// Reads 2-byte little-endian unsigned int
function u16(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8);
}

// Reads 4-byte little-endian unsigned int
function u32(d: Uint8Array, o: number): number {
  return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
}

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  flags: number;
}

export function extractFiles(data: Uint8Array): Map<string, Uint8Array> {
  // Find End of Central Directory record — scan backward from EOF
  let eocdOffset = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (u32(data, i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Invalid ZIP: EOCD not found');

  const cdOffset = u32(data, eocdOffset + 16);
  const cdEntries = u16(data, eocdOffset + 10);

  // Parse central directory
  const entries: CentralEntry[] = [];
  let pos = cdOffset;

  for (let i = 0; i < cdEntries; i++) {
    if (pos + 46 > data.length) break;
    if (u32(data, pos) !== 0x02014b50) throw new Error('Invalid ZIP: bad central directory entry');

    const flags = u16(data, pos + 8);
    const method = u16(data, pos + 10);
    const compressedSize = u32(data, pos + 20);
    const uncompressedSize = u32(data, pos + 24);
    const nameLen = u16(data, pos + 28);
    const extraLen = u16(data, pos + 30);
    const commentLen = u16(data, pos + 32);
    const localHeaderOffset = u32(data, pos + 42);

    const nameEnd = pos + 46 + nameLen;
    if (nameEnd > data.length) break;
    const name = new TextDecoder().decode(data.subarray(pos + 46, nameEnd));

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset, flags });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  // Extract files from local headers
  const files = new Map<string, Uint8Array>();

  for (const entry of entries) {
    // Skip directories
    if (entry.name.endsWith('/')) continue;

    // Check encryption
    if (entry.flags & 0x01) throw new Error('Encrypted DOCX files are not supported');

    const lh = entry.localHeaderOffset;
    if (u32(data, lh) !== 0x04034b50) throw new Error('Invalid ZIP: bad local header');

    const lhNameLen = u16(data, lh + 26);
    const lhExtraLen = u16(data, lh + 28);
    const dataStart = lh + 30 + lhNameLen + lhExtraLen;

    const raw = data.subarray(dataStart, dataStart + entry.compressedSize);

    if (entry.method === 0) {
      // Stored
      files.set(entry.name, raw.slice());
    } else if (entry.method === 8) {
      // Deflate — raw deflate, NOT zlib-wrapped
      if (entry.uncompressedSize > MAX_DECOMPRESSED_BYTES) {
        throw new Error('ZIP entry too large');
      }
      files.set(entry.name, new Uint8Array(inflateRawSync(raw, { maxOutputLength: MAX_DECOMPRESSED_BYTES })));
    } else {
      // Unsupported compression method — skip
    }
  }

  return files;
}
