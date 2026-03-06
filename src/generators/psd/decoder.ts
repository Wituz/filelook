import type { PixelGrid } from '../../types.ts';
import type { PsdHeader } from './types.ts';
import { COLOR_MODE_GRAYSCALE, COLOR_MODE_RGB, COLOR_MODE_CMYK } from './types.ts';

function readU16BE(d: Uint8Array, o: number): number {
  return (d[o] << 8) | d[o + 1];
}

function readU32BE(d: Uint8Array, o: number): number {
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
}

function parseHeader(data: Uint8Array): PsdHeader {
  if (data.length < 26) throw new Error('PSD file too small');
  if (data[0] !== 0x38 || data[1] !== 0x42 || data[2] !== 0x50 || data[3] !== 0x53) {
    throw new Error('Invalid PSD signature');
  }

  return {
    version: readU16BE(data, 4),
    channels: readU16BE(data, 12),
    height: readU32BE(data, 14),
    width: readU32BE(data, 18),
    depth: readU16BE(data, 22),
    colorMode: readU16BE(data, 24),
  };
}

// Skip sections 2–4 to find the start of section 5 (Image Data)
function skipToImageData(data: Uint8Array): number {
  let offset = 26;

  // Section 2: Color Mode Data
  offset += 4 + readU32BE(data, offset);

  // Section 3: Image Resources
  offset += 4 + readU32BE(data, offset);

  // Section 4: Layer and Mask Information
  offset += 4 + readU32BE(data, offset);

  return offset;
}

// PackBits RLE decompression
function unpackBits(data: Uint8Array, offset: number, unpackedSize: number): { decoded: Uint8Array; bytesRead: number } {
  const decoded = new Uint8Array(unpackedSize);
  let si = offset;
  let di = 0;

  while (di < unpackedSize) {
    const n = (data[si++] << 24) >> 24; // sign-extend to int8
    if (n >= 0) {
      // Copy next n+1 bytes literally
      const count = n + 1;
      for (let i = 0; i < count && di < unpackedSize; i++) decoded[di++] = data[si++];
    } else if (n > -128) {
      // Repeat next byte 1-n times
      const count = 1 - n;
      const val = data[si++];
      for (let i = 0; i < count && di < unpackedSize; i++) decoded[di++] = val;
    }
    // n === -128: no-op
  }

  return { decoded, bytesRead: si - offset };
}

export function decodePsd(data: Uint8Array): PixelGrid {
  const h = parseHeader(data);
  const { width, height, channels, depth, colorMode } = h;

  if (depth !== 8 && depth !== 16) {
    throw new Error(`Unsupported PSD depth: ${depth}`);
  }
  if (colorMode !== COLOR_MODE_RGB && colorMode !== COLOR_MODE_GRAYSCALE && colorMode !== COLOR_MODE_CMYK) {
    throw new Error(`Unsupported PSD color mode: ${colorMode}`);
  }

  let offset = skipToImageData(data);
  const compression = readU16BE(data, offset);
  offset += 2;

  const bytesPerSample = depth / 8;
  const rowSize = width * bytesPerSample;
  const totalRows = height * channels;

  // Decompress all channel data into a flat planar buffer
  let planar: Uint8Array;

  if (compression === 0) {
    // Raw: data is already in order
    planar = data.subarray(offset, offset + totalRows * rowSize);
  } else if (compression === 1) {
    // RLE: row byte counts (2 bytes BE each), then packed rows
    const rowCounts: number[] = [];
    for (let i = 0; i < totalRows; i++) {
      rowCounts.push(readU16BE(data, offset));
      offset += 2;
    }

    planar = new Uint8Array(totalRows * rowSize);
    let planarOffset = 0;

    for (let i = 0; i < totalRows; i++) {
      const { decoded } = unpackBits(data, offset, rowSize);
      planar.set(decoded, planarOffset);
      planarOffset += rowSize;
      offset += rowCounts[i];
    }
  } else {
    throw new Error(`Unsupported PSD compression: ${compression}`);
  }

  // Assemble planar channels into RGBA
  const rgba = new Uint8Array(width * height * 4);
  const channelSize = width * height * bytesPerSample;

  function readSample(channel: number, pixel: number): number {
    const off = channel * channelSize + pixel * bytesPerSample;
    if (bytesPerSample === 2) {
      // 16-bit: scale to 8-bit
      return readU16BE(planar, off) >> 8;
    }
    return planar[off];
  }

  if (colorMode === COLOR_MODE_RGB) {
    const hasAlpha = channels >= 4;
    for (let i = 0; i < width * height; i++) {
      const di = i * 4;
      rgba[di] = readSample(0, i);
      rgba[di + 1] = readSample(1, i);
      rgba[di + 2] = readSample(2, i);
      rgba[di + 3] = hasAlpha ? readSample(3, i) : 255;
    }
  } else if (colorMode === COLOR_MODE_GRAYSCALE) {
    const hasAlpha = channels >= 2;
    for (let i = 0; i < width * height; i++) {
      const di = i * 4;
      const v = readSample(0, i);
      rgba[di] = rgba[di + 1] = rgba[di + 2] = v;
      rgba[di + 3] = hasAlpha ? readSample(1, i) : 255;
    }
  } else {
    // CMYK → RGB
    for (let i = 0; i < width * height; i++) {
      const di = i * 4;
      const c = readSample(0, i) / 255;
      const m = readSample(1, i) / 255;
      const y = readSample(2, i) / 255;
      const k = readSample(3, i) / 255;
      rgba[di] = Math.round(255 * (1 - c) * (1 - k));
      rgba[di + 1] = Math.round(255 * (1 - m) * (1 - k));
      rgba[di + 2] = Math.round(255 * (1 - y) * (1 - k));
      rgba[di + 3] = channels >= 5 ? readSample(4, i) : 255;
    }
  }

  return { width, height, data: rgba };
}
