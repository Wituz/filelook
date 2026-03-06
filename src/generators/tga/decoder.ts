import type { PixelGrid } from '../../types.ts';
import type { TgaHeader } from './types.ts';
import {
  IMAGE_TYPE_COLOR_MAPPED, IMAGE_TYPE_RLE_COLOR_MAPPED,
  IMAGE_TYPE_TRUE_COLOR, IMAGE_TYPE_GRAYSCALE,
  IMAGE_TYPE_RLE_TRUE_COLOR, IMAGE_TYPE_RLE_GRAYSCALE,
} from './types.ts';

function readU16LE(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8);
}

export function parseHeader(data: Uint8Array): TgaHeader {
  if (data.length < 18) throw new Error('TGA file too small');

  return {
    idLength: data[0],
    colorMapType: data[1],
    imageType: data[2],
    colorMapFirstIndex: readU16LE(data, 3),
    colorMapLength: readU16LE(data, 5),
    colorMapEntrySize: data[7],
    width: readU16LE(data, 12),
    height: readU16LE(data, 14),
    pixelDepth: data[16],
    descriptor: data[17],
  };
}

// Parse color map into RGBA lookup table
function parseColorMap(data: Uint8Array, h: TgaHeader): Uint8Array {
  const entryBytes = Math.ceil(h.colorMapEntrySize / 8);
  const mapOffset = 18 + h.idLength;
  const table = new Uint8Array(h.colorMapLength * 4);

  for (let i = 0; i < h.colorMapLength; i++) {
    const si = mapOffset + i * entryBytes;
    const di = i * 4;
    if (h.colorMapEntrySize === 32) {
      table[di] = data[si + 2];
      table[di + 1] = data[si + 1];
      table[di + 2] = data[si];
      table[di + 3] = data[si + 3];
    } else if (h.colorMapEntrySize === 24) {
      table[di] = data[si + 2];
      table[di + 1] = data[si + 1];
      table[di + 2] = data[si];
      table[di + 3] = 255;
    } else {
      // 16-bit: 5-5-5 with 1 attribute bit
      const lo = data[si], hi = data[si + 1];
      table[di] = ((hi >> 2) & 0x1F) * 255 / 31;
      table[di + 1] = (((hi & 0x03) << 3) | (lo >> 5)) * 255 / 31;
      table[di + 2] = (lo & 0x1F) * 255 / 31;
      table[di + 3] = 255;
    }
  }

  return table;
}

function decodePixel(
  src: Uint8Array, offset: number, depth: number, rgba: Uint8Array, di: number,
): void {
  if (depth === 32) {
    rgba[di] = src[offset + 2];
    rgba[di + 1] = src[offset + 1];
    rgba[di + 2] = src[offset];
    rgba[di + 3] = src[offset + 3];
  } else if (depth === 24) {
    rgba[di] = src[offset + 2];
    rgba[di + 1] = src[offset + 1];
    rgba[di + 2] = src[offset];
    rgba[di + 3] = 255;
  } else {
    // 8-bit grayscale
    rgba[di] = rgba[di + 1] = rgba[di + 2] = src[offset];
    rgba[di + 3] = 255;
  }
}

function lookupPixel(
  src: Uint8Array, offset: number, bpp: number,
  colorMap: Uint8Array, rgba: Uint8Array, di: number,
): void {
  const index = bpp === 2 ? readU16LE(src, offset) : src[offset];
  const ci = index * 4;
  rgba[di] = colorMap[ci];
  rgba[di + 1] = colorMap[ci + 1];
  rgba[di + 2] = colorMap[ci + 2];
  rgba[di + 3] = colorMap[ci + 3];
}

function decodeUncompressed(
  data: Uint8Array, offset: number, pixelCount: number, depth: number,
  colorMap: Uint8Array | null,
): Uint8Array {
  const bpp = depth / 8;
  const rgba = new Uint8Array(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    if (colorMap) {
      lookupPixel(data, offset + i * bpp, bpp, colorMap, rgba, i * 4);
    } else {
      decodePixel(data, offset + i * bpp, depth, rgba, i * 4);
    }
  }
  return rgba;
}

function decodeRle(
  data: Uint8Array, offset: number, pixelCount: number, depth: number,
  colorMap: Uint8Array | null,
): Uint8Array {
  const bpp = depth / 8;
  const rgba = new Uint8Array(pixelCount * 4);
  let si = offset;
  let pi = 0;

  while (pi < pixelCount) {
    const ctrl = data[si++];
    const count = (ctrl & 0x7F) + 1;

    if (ctrl & 0x80) {
      // Run-length packet: one pixel repeated
      if (colorMap) {
        lookupPixel(data, si, bpp, colorMap, rgba, pi * 4);
        const r = rgba[pi * 4], g = rgba[pi * 4 + 1], b = rgba[pi * 4 + 2], a = rgba[pi * 4 + 3];
        for (let i = 1; i < count && pi + i < pixelCount; i++) {
          const di = (pi + i) * 4;
          rgba[di] = r; rgba[di + 1] = g; rgba[di + 2] = b; rgba[di + 3] = a;
        }
      } else {
        for (let i = 0; i < count && pi < pixelCount; i++, pi++) {
          decodePixel(data, si, depth, rgba, pi * 4);
        }
      }
      si += bpp;
      if (colorMap) pi += count;
    } else {
      // Raw packet: consecutive distinct pixels
      for (let i = 0; i < count && pi < pixelCount; i++, pi++) {
        if (colorMap) {
          lookupPixel(data, si, bpp, colorMap, rgba, pi * 4);
        } else {
          decodePixel(data, si, depth, rgba, pi * 4);
        }
        si += bpp;
      }
    }
  }

  return rgba;
}

export function decodeTga(data: Uint8Array): PixelGrid {
  const h = parseHeader(data);
  const { width, height, pixelDepth, imageType } = h;

  const isColorMapped = imageType === IMAGE_TYPE_COLOR_MAPPED
    || imageType === IMAGE_TYPE_RLE_COLOR_MAPPED;

  if (!isColorMapped && ![8, 24, 32].includes(pixelDepth)) {
    throw new Error(`Unsupported TGA pixel depth: ${pixelDepth}`);
  }

  // Parse color map if present
  const colorMap = (h.colorMapType === 1 && isColorMapped)
    ? parseColorMap(data, h)
    : null;

  // Skip header (18 bytes) + image ID + color map
  let offset = 18 + h.idLength;
  if (h.colorMapType === 1) {
    offset += h.colorMapLength * Math.ceil(h.colorMapEntrySize / 8);
  }

  const pixelCount = width * height;
  const isRle = imageType === IMAGE_TYPE_RLE_TRUE_COLOR
    || imageType === IMAGE_TYPE_RLE_GRAYSCALE
    || imageType === IMAGE_TYPE_RLE_COLOR_MAPPED;

  const rgba = isRle
    ? decodeRle(data, offset, pixelCount, pixelDepth, colorMap)
    : decodeUncompressed(data, offset, pixelCount, pixelDepth, colorMap);

  // Default is bottom-to-top; flip unless descriptor bit 5 is set (top-to-bottom)
  const topToBottom = (h.descriptor & 0x20) !== 0;
  if (!topToBottom) {
    const rowBytes = width * 4;
    const tmp = new Uint8Array(rowBytes);
    for (let y = 0; y < height >> 1; y++) {
      const topOff = y * rowBytes;
      const botOff = (height - 1 - y) * rowBytes;
      tmp.set(rgba.subarray(topOff, topOff + rowBytes));
      rgba.copyWithin(topOff, botOff, botOff + rowBytes);
      rgba.set(tmp, botOff);
    }
  }

  return { width, height, data: rgba };
}
