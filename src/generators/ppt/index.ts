import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodePpt } from './decoder.ts';

// UTF-16LE "PowerPoint Document"
const PPT_STREAM_NAME = [
  0x50, 0x00, 0x6F, 0x00, 0x77, 0x00, 0x65, 0x00,
  0x72, 0x00, 0x50, 0x00, 0x6F, 0x00, 0x69, 0x00,
  0x6E, 0x00, 0x74, 0x00, 0x20, 0x00, 0x44, 0x00,
  0x6F, 0x00, 0x63, 0x00, 0x75, 0x00, 0x6D, 0x00,
  0x65, 0x00, 0x6E, 0x00, 0x74, 0x00,
];

function readU16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}

function readI32(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
}

// Lightweight OLE2 directory scan for "PowerPoint Document" stream
function hasPptStream(data: Uint8Array): boolean {
  const sectorSizePow = readU16(data, 0x1E);
  const sectorSize = 1 << sectorSizePow;
  const sectorOffset = (s: number) => 512 + s * sectorSize;

  // Build DIFAT → FAT
  const difat: number[] = [];
  for (let i = 0; i < 109; i++) {
    const v = readI32(data, 0x4C + i * 4);
    if (v < 0) break;
    difat.push(v);
  }

  const fat: number[] = [];
  for (const fatSec of difat) {
    const off = sectorOffset(fatSec);
    if (off + sectorSize > data.length) break;
    for (let i = 0; i < sectorSize / 4; i++) {
      fat.push(readI32(data, off + i * 4));
    }
  }

  // Follow directory chain and scan entries
  let dirSec = readI32(data, 0x30);
  let visited = 0;
  while (dirSec >= 0 && dirSec !== -2 && visited < 1000) {
    const base = sectorOffset(dirSec);
    if (base + sectorSize > data.length) break;
    const count = sectorSize / 128;
    for (let i = 0; i < count; i++) {
      const entryOff = base + i * 128;
      const nameLen = readU16(data, entryOff + 0x40);
      if (nameLen < PPT_STREAM_NAME.length + 2) continue;
      let match = true;
      for (let j = 0; j < PPT_STREAM_NAME.length; j++) {
        if (data[entryOff + j] !== PPT_STREAM_NAME[j]) { match = false; break; }
      }
      if (match) return true;
    }
    dirSec = fat[dirSec] ?? -2;
    visited++;
  }

  return false;
}

export class PptGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['ppt'];
  readonly signatures: readonly MagicSignature[] = [];

  detectFromHeader(header: Uint8Array): FileType | null {
    if (header.length < 512) return null;
    // OLE2 magic
    if (header[0] !== 0xD0 || header[1] !== 0xCF || header[2] !== 0x11 || header[3] !== 0xE0 ||
        header[4] !== 0xA1 || header[5] !== 0xB1 || header[6] !== 0x1A || header[7] !== 0xE1) {
      return null;
    }
    try {
      if (hasPptStream(header)) return 'ppt';
    } catch {
      // Malformed OLE2
    }
    return null;
  }

  decode(data: Uint8Array): PixelGrid {
    return decodePpt(data);
  }
}
