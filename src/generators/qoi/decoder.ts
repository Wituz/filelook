import type { PixelGrid } from '../../types.ts';
import type { QoiHeader } from './types.ts';

function readU32BE(d: Uint8Array, o: number): number {
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
}

function parseHeader(data: Uint8Array): QoiHeader {
  if (data.length < 14) throw new Error('QOI file too small');
  if (data[0] !== 0x71 || data[1] !== 0x6F || data[2] !== 0x69 || data[3] !== 0x66) {
    throw new Error('Invalid QOI magic');
  }

  return {
    width: readU32BE(data, 4),
    height: readU32BE(data, 8),
    channels: data[12],
    colorspace: data[13],
  };
}

function hash(r: number, g: number, b: number, a: number): number {
  return (r * 3 + g * 5 + b * 7 + a * 11) % 64;
}

export function decodeQoi(data: Uint8Array): PixelGrid {
  const h = parseHeader(data);
  const { width, height } = h;
  const pixelCount = width * height;
  const rgba = new Uint8Array(pixelCount * 4);

  // 64-entry running index, each entry is [r, g, b, a]
  const index = new Uint8Array(64 * 4);

  let r = 0, g = 0, b = 0, a = 255;
  let si = 14; // after header
  let pi = 0;

  while (pi < pixelCount) {
    const tag = data[si++];

    if (tag === 0xFE) {
      // QOI_OP_RGB
      r = data[si++];
      g = data[si++];
      b = data[si++];
    } else if (tag === 0xFF) {
      // QOI_OP_RGBA
      r = data[si++];
      g = data[si++];
      b = data[si++];
      a = data[si++];
    } else if ((tag & 0xC0) === 0x00) {
      // QOI_OP_INDEX
      const idx = (tag & 0x3F) * 4;
      r = index[idx];
      g = index[idx + 1];
      b = index[idx + 2];
      a = index[idx + 3];
    } else if ((tag & 0xC0) === 0x40) {
      // QOI_OP_DIFF
      r = (r + ((tag >> 4) & 0x03) - 2) & 0xFF;
      g = (g + ((tag >> 2) & 0x03) - 2) & 0xFF;
      b = (b + (tag & 0x03) - 2) & 0xFF;
    } else if ((tag & 0xC0) === 0x80) {
      // QOI_OP_LUMA
      const b2 = data[si++];
      const dg = (tag & 0x3F) - 32;
      r = (r + dg + ((b2 >> 4) & 0x0F) - 8) & 0xFF;
      g = (g + dg) & 0xFF;
      b = (b + dg + (b2 & 0x0F) - 8) & 0xFF;
    } else {
      // QOI_OP_RUN (0b11xxxxxx, but not 0xFE/0xFF which are handled above)
      const run = (tag & 0x3F) + 1;
      for (let i = 0; i < run && pi < pixelCount; i++) {
        const di = pi * 4;
        rgba[di] = r;
        rgba[di + 1] = g;
        rgba[di + 2] = b;
        rgba[di + 3] = a;
        pi++;
      }
      // Update index for run pixels (current pixel already correct)
      const idx = hash(r, g, b, a) * 4;
      index[idx] = r; index[idx + 1] = g; index[idx + 2] = b; index[idx + 3] = a;
      continue;
    }

    // Store pixel in index and output
    const idx = hash(r, g, b, a) * 4;
    index[idx] = r; index[idx + 1] = g; index[idx + 2] = b; index[idx + 3] = a;

    const di = pi * 4;
    rgba[di] = r;
    rgba[di + 1] = g;
    rgba[di + 2] = b;
    rgba[di + 3] = a;
    pi++;
  }

  return { width, height, data: rgba };
}
