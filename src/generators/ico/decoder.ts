import type { PixelGrid } from '../../types.ts';
import type { IcoHeader, IcoDirEntry } from './types.ts';
import { decodePng } from '../png/decoder.ts';

function readU16LE(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8);
}

function readU32LE(d: Uint8Array, o: number): number {
  return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
}

function parseHeader(data: Uint8Array): IcoHeader {
  const reserved = readU16LE(data, 0);
  const type = readU16LE(data, 2);
  const count = readU16LE(data, 4);
  if (reserved !== 0) throw new Error('Invalid ICO/CUR: reserved field must be 0');
  if (type !== 1 && type !== 2) throw new Error('Invalid ICO/CUR: type must be 1 or 2');
  if (count === 0) throw new Error('ICO/CUR contains no images');
  return { type, count };
}

function parseDirEntry(data: Uint8Array, offset: number): IcoDirEntry {
  return {
    width: data[offset] || 256,
    height: data[offset + 1] || 256,
    colorCount: data[offset + 2],
    bitsPerPixel: readU16LE(data, offset + 6),
    dataSize: readU32LE(data, offset + 8),
    dataOffset: readU32LE(data, offset + 12),
  };
}

function pickBestEntry(entries: IcoDirEntry[]): IcoDirEntry {
  return entries.reduce((best, entry) => {
    const bestArea = best.width * best.height;
    const entryArea = entry.width * entry.height;
    if (entryArea > bestArea) return entry;
    if (entryArea === bestArea && entry.bitsPerPixel > best.bitsPerPixel) return entry;
    return best;
  });
}

// AND mask: 1-bit per pixel, rows padded to 4 bytes, bottom-up
function applyAndMask(
  maskData: Uint8Array, maskOffset: number,
  width: number, height: number, rgba: Uint8Array,
): void {
  const maskRowStride = Math.ceil(width / 32) * 4;
  for (let y = 0; y < height; y++) {
    const srcRow = height - 1 - y;
    const rowOff = maskOffset + srcRow * maskRowStride;
    for (let x = 0; x < width; x++) {
      const bit = (maskData[rowOff + (x >> 3)] >> (7 - (x & 7))) & 1;
      if (bit) rgba[(y * width + x) * 4 + 3] = 0;
    }
  }
}

function decodeIcoBmpDib(dibData: Uint8Array, entry: IcoDirEntry): PixelGrid {
  const dibHeaderSize = readU32LE(dibData, 0);
  const bitsPerPixel = readU16LE(dibData, 14);
  const compression = readU32LE(dibData, 16);

  if (compression !== 0 && compression !== 3) {
    throw new Error(`Unsupported ICO BMP compression: ${compression}`);
  }

  const { width, height } = entry;
  const rgba = new Uint8Array(width * height * 4);
  const rowStride = Math.ceil((width * bitsPerPixel) / 32) * 4;

  if (bitsPerPixel === 32) {
    const pixelOffset = dibHeaderSize;
    for (let y = 0; y < height; y++) {
      const srcRow = height - 1 - y;
      const srcOff = pixelOffset + srcRow * rowStride;
      for (let x = 0; x < width; x++) {
        const si = srcOff + x * 4;
        const di = (y * width + x) * 4;
        rgba[di] = dibData[si + 2];
        rgba[di + 1] = dibData[si + 1];
        rgba[di + 2] = dibData[si];
        rgba[di + 3] = dibData[si + 3];
      }
    }
  } else if (bitsPerPixel === 24) {
    const pixelOffset = dibHeaderSize;
    for (let y = 0; y < height; y++) {
      const srcRow = height - 1 - y;
      const srcOff = pixelOffset + srcRow * rowStride;
      for (let x = 0; x < width; x++) {
        const si = srcOff + x * 3;
        const di = (y * width + x) * 4;
        rgba[di] = dibData[si + 2];
        rgba[di + 1] = dibData[si + 1];
        rgba[di + 2] = dibData[si];
        rgba[di + 3] = 255;
      }
    }
    applyAndMask(dibData, dibHeaderSize + rowStride * height, width, height, rgba);
  } else if (bitsPerPixel === 8) {
    const colorTableEntries = entry.colorCount || 256;
    const colorTableOffset = dibHeaderSize;
    const pixelOffset = colorTableOffset + colorTableEntries * 4;
    for (let y = 0; y < height; y++) {
      const srcRow = height - 1 - y;
      const srcOff = pixelOffset + srcRow * rowStride;
      for (let x = 0; x < width; x++) {
        const idx = dibData[srcOff + x];
        const ci = colorTableOffset + idx * 4;
        const di = (y * width + x) * 4;
        rgba[di] = dibData[ci + 2];
        rgba[di + 1] = dibData[ci + 1];
        rgba[di + 2] = dibData[ci];
        rgba[di + 3] = 255;
      }
    }
    applyAndMask(dibData, pixelOffset + rowStride * height, width, height, rgba);
  } else {
    throw new Error(`Unsupported ICO BMP bit depth: ${bitsPerPixel}`);
  }

  return { width, height, data: rgba };
}

// ANI is a RIFF/ACON container with ICO/CUR frames — extract the first one
export function decodeAni(data: Uint8Array): PixelGrid {
  // Walk RIFF chunks to find LIST/fram, then first "icon" sub-chunk
  let pos = 12; // skip "RIFF" + size + "ACON"
  while (pos + 8 <= data.length) {
    const id = String.fromCharCode(data[pos], data[pos + 1], data[pos + 2], data[pos + 3]);
    const size = readU32LE(data, pos + 4);
    if (id === 'LIST') {
      const listType = String.fromCharCode(data[pos + 8], data[pos + 9], data[pos + 10], data[pos + 11]);
      if (listType === 'fram') {
        // Find first "icon" chunk inside this LIST
        let inner = pos + 12;
        const listEnd = pos + 8 + size;
        while (inner + 8 <= listEnd) {
          const chunkId = String.fromCharCode(data[inner], data[inner + 1], data[inner + 2], data[inner + 3]);
          const chunkSize = readU32LE(data, inner + 4);
          if (chunkId === 'icon') {
            return decodeIco(data.subarray(inner + 8, inner + 8 + chunkSize));
          }
          inner += 8 + chunkSize + (chunkSize & 1); // RIFF chunks are word-aligned
        }
      }
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error('ANI file contains no icon frames');
}

const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47];

export function decodeIco(data: Uint8Array): PixelGrid {
  const header = parseHeader(data);

  const entries: IcoDirEntry[] = [];
  for (let i = 0; i < header.count; i++) {
    entries.push(parseDirEntry(data, 6 + i * 16));
  }

  const best = pickBestEntry(entries);
  const entryData = data.subarray(best.dataOffset, best.dataOffset + best.dataSize);

  const isPng = entryData[0] === PNG_MAGIC[0] &&
                entryData[1] === PNG_MAGIC[1] &&
                entryData[2] === PNG_MAGIC[2] &&
                entryData[3] === PNG_MAGIC[3];

  return isPng ? decodePng(entryData) : decodeIcoBmpDib(entryData, best);
}
