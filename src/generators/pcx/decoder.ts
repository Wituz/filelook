import type { PixelGrid } from '../../types.ts';
import type { PcxHeader } from './types.ts';
import { validateDimensions } from '../../safety.ts';

function readU16LE(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8);
}

function parseHeader(data: Uint8Array): PcxHeader {
  if (data.length < 128) throw new Error('PCX file too small');
  if (data[0] !== 0x0A) throw new Error('Invalid PCX manufacturer byte');

  const xMin = readU16LE(data, 4);
  const yMin = readU16LE(data, 6);
  const xMax = readU16LE(data, 8);
  const yMax = readU16LE(data, 10);

  return {
    version: data[1],
    encoding: data[2],
    bitsPerPixel: data[3],
    xMin, yMin, xMax, yMax,
    width: xMax - xMin + 1,
    height: yMax - yMin + 1,
    numPlanes: data[65],
    bytesPerLine: readU16LE(data, 66),
    paletteType: readU16LE(data, 68),
    egaPalette: data.subarray(16, 64),
  };
}

// Decode RLE-compressed scanline data into a flat buffer
function decodeRle(
  data: Uint8Array, offset: number, totalBytes: number,
): { decoded: Uint8Array; bytesRead: number } {
  const decoded = new Uint8Array(totalBytes);
  let si = offset;
  let di = 0;

  while (di < totalBytes && si < data.length) {
    const byte = data[si++];
    if ((byte & 0xC0) === 0xC0) {
      const count = byte & 0x3F;
      if (si >= data.length) break;
      const val = data[si++];
      for (let i = 0; i < count && di < totalBytes; i++) decoded[di++] = val;
    } else {
      decoded[di++] = byte;
    }
  }

  return { decoded, bytesRead: si - offset };
}

// Read VGA 256-color palette from end of file (0x0C marker + 768 bytes)
function readVgaPalette(data: Uint8Array): Uint8Array {
  const paletteOffset = data.length - 769;
  if (paletteOffset < 128 || data[paletteOffset] !== 0x0C) {
    throw new Error('PCX VGA palette marker not found');
  }
  return data.subarray(paletteOffset + 1, paletteOffset + 769);
}

export function decodePcx(data: Uint8Array): PixelGrid {
  const h = parseHeader(data);
  const { width, height, bitsPerPixel, numPlanes, bytesPerLine } = h;
  validateDimensions(width, height);
  const rgba = new Uint8Array(width * height * 4);
  const scanlineBytes = bytesPerLine * numPlanes;

  let si = 128; // pixel data starts after header

  for (let y = 0; y < height; y++) {
    let line: Uint8Array;
    if (h.encoding === 1) {
      const result = decodeRle(data, si, scanlineBytes);
      line = result.decoded;
      si = si + result.bytesRead;
    } else {
      line = data.subarray(si, si + scanlineBytes);
      si += scanlineBytes;
    }

    if (bitsPerPixel === 8 && numPlanes >= 3) {
      // 24-bit or 32-bit RGB(A): one plane per channel
      for (let x = 0; x < width; x++) {
        const di = (y * width + x) * 4;
        rgba[di] = line[x];
        rgba[di + 1] = line[bytesPerLine + x];
        rgba[di + 2] = line[bytesPerLine * 2 + x];
        rgba[di + 3] = numPlanes === 4 ? line[bytesPerLine * 3 + x] : 255;
      }
    } else if (bitsPerPixel === 8 && numPlanes === 1) {
      // 256-color indexed — palette lookup deferred after all scanlines
      for (let x = 0; x < width; x++) {
        const di = (y * width + x) * 4;
        rgba[di] = line[x]; // store index temporarily in R channel
      }
    } else if (bitsPerPixel === 1 && numPlanes === 1) {
      // Monochrome: 1 bit per pixel, MSB first
      for (let x = 0; x < width; x++) {
        const bit = (line[Math.floor(x / 8)] >> (7 - (x % 8))) & 1;
        const di = (y * width + x) * 4;
        rgba[di] = rgba[di + 1] = rgba[di + 2] = bit ? 255 : 0;
        rgba[di + 3] = 255;
      }
    } else if (bitsPerPixel === 4 && numPlanes === 1) {
      // 16-color indexed, 4 bits per pixel
      for (let x = 0; x < width; x++) {
        const byteVal = line[Math.floor(x / 2)];
        const idx = (x % 2 === 0) ? (byteVal >> 4) : (byteVal & 0x0F);
        const di = (y * width + x) * 4;
        rgba[di] = h.egaPalette[idx * 3];
        rgba[di + 1] = h.egaPalette[idx * 3 + 1];
        rgba[di + 2] = h.egaPalette[idx * 3 + 2];
        rgba[di + 3] = 255;
      }
    } else if (bitsPerPixel === 1 && numPlanes === 4) {
      // 16-color EGA: 4 bitplanes → palette index
      for (let x = 0; x < width; x++) {
        const bytePos = Math.floor(x / 8);
        const bitPos = 7 - (x % 8);
        let idx = 0;
        for (let p = 0; p < 4; p++) {
          idx |= ((line[bytesPerLine * p + bytePos] >> bitPos) & 1) << p;
        }
        const di = (y * width + x) * 4;
        rgba[di] = h.egaPalette[idx * 3];
        rgba[di + 1] = h.egaPalette[idx * 3 + 1];
        rgba[di + 2] = h.egaPalette[idx * 3 + 2];
        rgba[di + 3] = 255;
      }
    } else {
      throw new Error(`Unsupported PCX format: ${bitsPerPixel}bpp, ${numPlanes} planes`);
    }
  }

  // Apply VGA palette for 256-color indexed images
  if (bitsPerPixel === 8 && numPlanes === 1) {
    const palette = readVgaPalette(data);
    for (let i = 0; i < width * height; i++) {
      const di = i * 4;
      const idx = rgba[di]; // index stored in R channel
      rgba[di] = palette[idx * 3];
      rgba[di + 1] = palette[idx * 3 + 1];
      rgba[di + 2] = palette[idx * 3 + 2];
      rgba[di + 3] = 255;
    }
  }

  return { width, height, data: rgba };
}
