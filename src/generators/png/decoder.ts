import { inflateSync } from 'node:zlib';
import type { PixelGrid } from '../../types.ts';
import { ColorType, bytesPerPixel, type PngHeader } from './types.ts';

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

function readU32BE(data: Uint8Array, offset: number): number {
  return (data[offset] << 24 | data[offset + 1] << 16 | data[offset + 2] << 8 | data[offset + 3]) >>> 0;
}

function parseHeader(data: Uint8Array): { header: PngHeader; idatChunks: Uint8Array[]; palette?: Uint8Array } {
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PNG_SIGNATURE[i]) throw new Error('Invalid PNG signature');
  }

  let header: PngHeader | null = null;
  const idatChunks: Uint8Array[] = [];
  let palette: Uint8Array | undefined;
  let pos = 8;

  while (pos < data.length) {
    const length = readU32BE(data, pos);
    const type = String.fromCharCode(data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]);
    const chunkData = data.subarray(pos + 8, pos + 8 + length);

    if (type === 'IHDR') {
      header = {
        width: readU32BE(chunkData, 0),
        height: readU32BE(chunkData, 4),
        bitDepth: chunkData[8],
        colorType: chunkData[9] as ColorType,
        interlace: chunkData[12],
      };
      if (header.interlace !== 0) throw new Error('Interlaced PNGs not supported');
      if (header.bitDepth !== 8) throw new Error('Only 8-bit PNGs supported');
    } else if (type === 'PLTE') {
      palette = new Uint8Array(chunkData);
    } else if (type === 'IDAT') {
      idatChunks.push(new Uint8Array(chunkData));
    } else if (type === 'IEND') {
      break;
    }

    pos += 12 + length; // length(4) + type(4) + data + crc(4)
  }

  if (!header) throw new Error('Missing IHDR chunk');
  return { header, idatChunks, palette };
}

// Reverse PNG row filters to recover raw pixel bytes
function unfilter(raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(height * stride);

  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const outRow = y * stride;

    for (let x = 0; x < stride; x++) {
      const curr = raw[rowStart + x];
      const a = x >= bpp ? out[outRow + x - bpp] : 0;
      const b = y > 0 ? out[outRow - stride + x] : 0;
      const c = (x >= bpp && y > 0) ? out[outRow - stride + x - bpp] : 0;

      switch (filterType) {
        case 0: out[outRow + x] = curr; break;
        case 1: out[outRow + x] = (curr + a) & 0xFF; break;
        case 2: out[outRow + x] = (curr + b) & 0xFF; break;
        case 3: out[outRow + x] = (curr + ((a + b) >> 1)) & 0xFF; break;
        case 4: out[outRow + x] = (curr + paethPredictor(a, b, c)) & 0xFF; break;
        default: throw new Error(`Unknown PNG filter type: ${filterType}`);
      }
    }
  }

  return out;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Convert any PNG color type to RGBA
function toRGBA(pixels: Uint8Array, header: PngHeader, palette?: Uint8Array): Uint8Array {
  const { width, height, colorType } = header;
  const total = width * height;
  const rgba = new Uint8Array(total * 4);

  for (let i = 0; i < total; i++) {
    const oi = i * 4;

    switch (colorType) {
      case ColorType.RGBA:
        rgba[oi] = pixels[i * 4];
        rgba[oi + 1] = pixels[i * 4 + 1];
        rgba[oi + 2] = pixels[i * 4 + 2];
        rgba[oi + 3] = pixels[i * 4 + 3];
        break;
      case ColorType.RGB:
        rgba[oi] = pixels[i * 3];
        rgba[oi + 1] = pixels[i * 3 + 1];
        rgba[oi + 2] = pixels[i * 3 + 2];
        rgba[oi + 3] = 255;
        break;
      case ColorType.Grayscale:
        rgba[oi] = rgba[oi + 1] = rgba[oi + 2] = pixels[i];
        rgba[oi + 3] = 255;
        break;
      case ColorType.GrayscaleAlpha:
        rgba[oi] = rgba[oi + 1] = rgba[oi + 2] = pixels[i * 2];
        rgba[oi + 3] = pixels[i * 2 + 1];
        break;
      case ColorType.Indexed: {
        if (!palette) throw new Error('Indexed PNG missing PLTE chunk');
        const idx = pixels[i] * 3;
        rgba[oi] = palette[idx];
        rgba[oi + 1] = palette[idx + 1];
        rgba[oi + 2] = palette[idx + 2];
        rgba[oi + 3] = 255;
        break;
      }
    }
  }

  return rgba;
}

export function decodePng(data: Uint8Array): PixelGrid {
  const { header, idatChunks, palette } = parseHeader(data);

  // Concatenate IDAT chunks and decompress
  const totalLen = idatChunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of idatChunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  const raw = inflateSync(combined);
  const bpp = bytesPerPixel(header.colorType);
  const pixels = unfilter(raw, header.width, header.height, bpp);
  const rgba = toRGBA(pixels, header, palette);

  return { width: header.width, height: header.height, data: rgba };
}
