import type { PixelGrid } from '../../types.ts';
import type { PnmHeader } from './types.ts';
import { validateDimensions } from '../../safety.ts';

// Reads the text-based header, skipping # comments between tokens
function parseHeader(data: Uint8Array): PnmHeader {
  let pos = 0;

  function skipWhitespaceAndComments(): void {
    while (pos < data.length) {
      const ch = data[pos];
      if (ch === 0x23) { // '#'
        while (pos < data.length && data[pos] !== 0x0A) pos++;
        if (pos < data.length) pos++; // skip newline
      } else if (ch === 0x20 || ch === 0x09 || ch === 0x0A || ch === 0x0D) {
        pos++;
      } else {
        break;
      }
    }
  }

  function readToken(): string {
    skipWhitespaceAndComments();
    const start = pos;
    while (pos < data.length) {
      const ch = data[pos];
      if (ch === 0x20 || ch === 0x09 || ch === 0x0A || ch === 0x0D || ch === 0x23) break;
      pos++;
    }
    return new TextDecoder().decode(data.subarray(start, pos));
  }

  const magicToken = readToken();
  if (magicToken.length !== 2 || magicToken[0] !== 'P') {
    throw new Error('Invalid PNM magic');
  }
  const magic = parseInt(magicToken[1], 10);
  if (magic < 1 || magic > 6) throw new Error(`Unsupported PNM type: P${magic}`);

  const width = parseInt(readToken(), 10);
  const height = parseInt(readToken(), 10);
  if (width <= 0 || height <= 0) throw new Error('Invalid PNM dimensions');

  const isPbm = magic === 1 || magic === 4;
  const maxval = isPbm ? 1 : parseInt(readToken(), 10);

  // For binary formats, exactly one whitespace char separates header from data
  const isBinary = magic >= 4;
  if (isBinary) {
    pos++; // skip the single whitespace after last header token
  }

  return { magic, width, height, maxval, dataOffset: pos };
}

function scale(val: number, maxval: number): number {
  return maxval === 255 ? val : Math.round(val * 255 / maxval);
}

// P1: ASCII PBM — 0=white, 1=black
function decodeP1(data: Uint8Array, h: PnmHeader): Uint8Array {
  const { width, height } = h;
  const rgba = new Uint8Array(width * height * 4);
  const text = new TextDecoder().decode(data.subarray(h.dataOffset));
  const tokens = text.match(/[01]/g)!;
  for (let i = 0; i < width * height; i++) {
    const v = tokens[i] === '1' ? 0 : 255;
    const di = i * 4;
    rgba[di] = rgba[di + 1] = rgba[di + 2] = v;
    rgba[di + 3] = 255;
  }
  return rgba;
}

// P2: ASCII PGM
function decodeP2(data: Uint8Array, h: PnmHeader): Uint8Array {
  const { width, height, maxval } = h;
  const rgba = new Uint8Array(width * height * 4);
  const text = new TextDecoder().decode(data.subarray(h.dataOffset));
  const tokens = text.match(/\d+/g)!;
  for (let i = 0; i < width * height; i++) {
    const v = scale(parseInt(tokens[i], 10), maxval);
    const di = i * 4;
    rgba[di] = rgba[di + 1] = rgba[di + 2] = v;
    rgba[di + 3] = 255;
  }
  return rgba;
}

// P3: ASCII PPM
function decodeP3(data: Uint8Array, h: PnmHeader): Uint8Array {
  const { width, height, maxval } = h;
  const rgba = new Uint8Array(width * height * 4);
  const text = new TextDecoder().decode(data.subarray(h.dataOffset));
  const tokens = text.match(/\d+/g)!;
  for (let i = 0; i < width * height; i++) {
    const di = i * 4;
    rgba[di] = scale(parseInt(tokens[i * 3], 10), maxval);
    rgba[di + 1] = scale(parseInt(tokens[i * 3 + 1], 10), maxval);
    rgba[di + 2] = scale(parseInt(tokens[i * 3 + 2], 10), maxval);
    rgba[di + 3] = 255;
  }
  return rgba;
}

// P4: Binary PBM — bits packed MSB-first, rows padded to byte boundary
function decodeP4(data: Uint8Array, h: PnmHeader): Uint8Array {
  const { width, height } = h;
  const rgba = new Uint8Array(width * height * 4);
  const rowBytes = Math.ceil(width / 8);
  let si = h.dataOffset;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byteIdx = si + Math.floor(x / 8);
      const bitIdx = 7 - (x % 8);
      const bit = (data[byteIdx] >> bitIdx) & 1;
      const v = bit === 1 ? 0 : 255; // 1=black, 0=white
      const di = (y * width + x) * 4;
      rgba[di] = rgba[di + 1] = rgba[di + 2] = v;
      rgba[di + 3] = 255;
    }
    si += rowBytes;
  }
  return rgba;
}

// P5: Binary PGM — 1 byte per sample (maxval<256) or 2 bytes BE (maxval>=256)
function decodeP5(data: Uint8Array, h: PnmHeader): Uint8Array {
  const { width, height, maxval } = h;
  const rgba = new Uint8Array(width * height * 4);
  const wide = maxval >= 256;
  let si = h.dataOffset;

  for (let i = 0; i < width * height; i++) {
    const raw = wide ? (data[si] << 8 | data[si + 1]) : data[si];
    si += wide ? 2 : 1;
    const v = scale(raw, maxval);
    const di = i * 4;
    rgba[di] = rgba[di + 1] = rgba[di + 2] = v;
    rgba[di + 3] = 255;
  }
  return rgba;
}

// P6: Binary PPM — 3 bytes per pixel (maxval<256) or 6 bytes BE (maxval>=256)
function decodeP6(data: Uint8Array, h: PnmHeader): Uint8Array {
  const { width, height, maxval } = h;
  const rgba = new Uint8Array(width * height * 4);
  const wide = maxval >= 256;
  let si = h.dataOffset;

  for (let i = 0; i < width * height; i++) {
    const di = i * 4;
    if (wide) {
      rgba[di] = scale((data[si] << 8 | data[si + 1]), maxval);
      rgba[di + 1] = scale((data[si + 2] << 8 | data[si + 3]), maxval);
      rgba[di + 2] = scale((data[si + 4] << 8 | data[si + 5]), maxval);
      si += 6;
    } else {
      rgba[di] = scale(data[si], maxval);
      rgba[di + 1] = scale(data[si + 1], maxval);
      rgba[di + 2] = scale(data[si + 2], maxval);
      si += 3;
    }
    rgba[di + 3] = 255;
  }
  return rgba;
}

const decoders = [undefined, decodeP1, decodeP2, decodeP3, decodeP4, decodeP5, decodeP6];

export function decodePnm(data: Uint8Array): PixelGrid {
  const h = parseHeader(data);
  validateDimensions(h.width, h.height);
  const decode = decoders[h.magic];
  if (!decode) throw new Error(`Unsupported PNM type: P${h.magic}`);
  const rgba = decode(data, h);
  return { width: h.width, height: h.height, data: rgba };
}
