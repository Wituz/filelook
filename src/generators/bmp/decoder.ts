import type { PixelGrid } from '../../types.ts';
import { BI_RGB, BI_BITFIELDS, type BmpHeader } from './types.ts';

function readU16LE(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8);
}

function readU32LE(d: Uint8Array, o: number): number {
  return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
}

function readI32LE(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24);
}

function parseHeader(data: Uint8Array): BmpHeader {
  if (data[0] !== 0x42 || data[1] !== 0x4D) throw new Error('Invalid BMP signature');

  const dataOffset = readU32LE(data, 10);
  const rawHeight = readI32LE(data, 22);

  return {
    dataOffset,
    width: readI32LE(data, 18),
    height: Math.abs(rawHeight),
    bitsPerPixel: readU16LE(data, 28),
    compression: readU32LE(data, 30),
    topDown: rawHeight < 0,
  };
}

export function decodeBmp(data: Uint8Array): PixelGrid {
  const h = parseHeader(data);

  if (h.compression !== BI_RGB && h.compression !== BI_BITFIELDS) {
    throw new Error(`Unsupported BMP compression: ${h.compression}`);
  }
  if (![24, 32].includes(h.bitsPerPixel)) {
    throw new Error(`Unsupported BMP bit depth: ${h.bitsPerPixel}`);
  }

  const { width, height, bitsPerPixel, dataOffset, topDown } = h;
  const bytesPerPixel = bitsPerPixel / 8;
  // BMP rows are padded to 4-byte boundaries
  const rowStride = Math.ceil((width * bytesPerPixel) / 4) * 4;
  const rgba = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    // BMP default is bottom-up row order
    const srcRow = topDown ? y : height - 1 - y;
    const srcOff = dataOffset + srcRow * rowStride;

    for (let x = 0; x < width; x++) {
      const si = srcOff + x * bytesPerPixel;
      const di = (y * width + x) * 4;
      // BMP stores BGR(A)
      rgba[di] = data[si + 2];
      rgba[di + 1] = data[si + 1];
      rgba[di + 2] = data[si];
      rgba[di + 3] = bytesPerPixel === 4 ? data[si + 3] : 255;
    }
  }

  return { width, height, data: rgba };
}
