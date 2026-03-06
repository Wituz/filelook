import type { PixelGrid } from '../../types.ts';
import type { DdsHeader } from './types.ts';
import { DDPF_FOURCC, DDPF_RGB } from './types.ts';

function readU16LE(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8);
}

function readU32LE(d: Uint8Array, o: number): number {
  return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
}

function fourCCString(d: Uint8Array, o: number): string {
  return String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);
}

function parseHeader(data: Uint8Array): DdsHeader {
  if (data.length < 128) throw new Error('DDS file too small');
  if (data[0] !== 0x44 || data[1] !== 0x44 || data[2] !== 0x53 || data[3] !== 0x20) {
    throw new Error('Invalid DDS magic');
  }

  // Pixel format starts at file offset 76 (header offset 72 + magic 4)
  return {
    height: readU32LE(data, 12),
    width: readU32LE(data, 16),
    pfFlags: readU32LE(data, 80),
    fourCC: fourCCString(data, 84),
    rgbBitCount: readU32LE(data, 88),
    rMask: readU32LE(data, 92),
    gMask: readU32LE(data, 96),
    bMask: readU32LE(data, 100),
    aMask: readU32LE(data, 104),
  };
}

// Count trailing zeros to find shift amount for a mask
function maskShift(mask: number): number {
  if (mask === 0) return 0;
  let shift = 0;
  let m = mask;
  while ((m & 1) === 0) { shift++; m >>>= 1; }
  return shift;
}

// Count set bits to find bit width of a mask
function maskBits(mask: number): number {
  let m = mask >>> maskShift(mask);
  let bits = 0;
  while (m & 1) { bits++; m >>>= 1; }
  return bits;
}

function extractChannel(pixel: number, mask: number): number {
  if (mask === 0) return 255;
  const shift = maskShift(mask);
  const bits = maskBits(mask);
  const val = (pixel >>> shift) & ((1 << bits) - 1);
  return Math.round(val * 255 / ((1 << bits) - 1));
}

function decodeUncompressed(data: Uint8Array, h: DdsHeader): Uint8Array {
  const { width, height, rgbBitCount, rMask, gMask, bMask, aMask } = h;
  const bpp = rgbBitCount / 8;
  const rgba = new Uint8Array(width * height * 4);
  let si = 128;

  for (let i = 0; i < width * height; i++) {
    let pixel = 0;
    for (let b = 0; b < bpp; b++) pixel |= data[si + b] << (b * 8);
    si += bpp;

    const di = i * 4;
    rgba[di] = extractChannel(pixel, rMask);
    rgba[di + 1] = extractChannel(pixel, gMask);
    rgba[di + 2] = extractChannel(pixel, bMask);
    rgba[di + 3] = aMask ? extractChannel(pixel, aMask) : 255;
  }

  return rgba;
}

// Unpack RGB565 to [r, g, b] (0-255)
function rgb565(val: number): [number, number, number] {
  return [
    ((val >> 11) & 0x1F) * 255 / 31,
    ((val >> 5) & 0x3F) * 255 / 63,
    (val & 0x1F) * 255 / 31,
  ];
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

// Decode 8-byte DXT1 color block → 16 RGBA pixels
// fourColor: true for DXT3/DXT5 (always 4-color mode), false for standalone DXT1
function decodeDxt1ColorBlock(
  data: Uint8Array, offset: number, fourColor: boolean,
): Uint8Array {
  const c0val = readU16LE(data, offset);
  const c1val = readU16LE(data, offset + 2);
  const c0 = rgb565(c0val);
  const c1 = rgb565(c1val);

  const palette: [number, number, number, number][] = [
    [c0[0], c0[1], c0[2], 255],
    [c1[0], c1[1], c1[2], 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
  ];

  if (fourColor || c0val > c1val) {
    palette[2] = [lerp(c0[0], c1[0], 1 / 3), lerp(c0[1], c1[1], 1 / 3), lerp(c0[2], c1[2], 1 / 3), 255];
    palette[3] = [lerp(c0[0], c1[0], 2 / 3), lerp(c0[1], c1[1], 2 / 3), lerp(c0[2], c1[2], 2 / 3), 255];
  } else {
    palette[2] = [lerp(c0[0], c1[0], 0.5), lerp(c0[1], c1[1], 0.5), lerp(c0[2], c1[2], 0.5), 255];
    palette[3] = [0, 0, 0, 0]; // transparent black
  }

  const out = new Uint8Array(16 * 4);
  for (let i = 0; i < 4; i++) {
    const bits = data[offset + 4 + i];
    for (let j = 0; j < 4; j++) {
      const idx = (bits >> (j * 2)) & 0x03;
      const di = (i * 4 + j) * 4;
      out[di] = palette[idx][0];
      out[di + 1] = palette[idx][1];
      out[di + 2] = palette[idx][2];
      out[di + 3] = palette[idx][3];
    }
  }
  return out;
}

function decodeDxt3Block(data: Uint8Array, offset: number): Uint8Array {
  // First 8 bytes: explicit 4-bit alpha for 16 pixels
  const colors = decodeDxt1ColorBlock(data, offset + 8, true);

  for (let i = 0; i < 16; i++) {
    const byteIdx = offset + Math.floor(i / 2);
    const alpha = (i % 2 === 0) ? (data[byteIdx] & 0x0F) : (data[byteIdx] >> 4);
    colors[i * 4 + 3] = Math.round(alpha * 255 / 15);
  }

  return colors;
}

function decodeDxt5Block(data: Uint8Array, offset: number): Uint8Array {
  const a0 = data[offset];
  const a1 = data[offset + 1];

  // Build 8-entry alpha palette
  const alphas = new Uint8Array(8);
  alphas[0] = a0;
  alphas[1] = a1;
  if (a0 > a1) {
    for (let i = 1; i <= 6; i++) alphas[1 + i] = lerp(a0, a1, i / 7);
  } else {
    for (let i = 1; i <= 4; i++) alphas[1 + i] = lerp(a0, a1, i / 5);
    alphas[6] = 0;
    alphas[7] = 255;
  }

  // Read 48-bit (6-byte) alpha index block as 16 3-bit indices
  let alphaBits = 0n;
  for (let i = 0; i < 6; i++) alphaBits |= BigInt(data[offset + 2 + i]) << BigInt(i * 8);

  const colors = decodeDxt1ColorBlock(data, offset + 8, true);

  for (let i = 0; i < 16; i++) {
    const alphaIdx = Number((alphaBits >> BigInt(i * 3)) & 0x7n);
    colors[i * 4 + 3] = alphas[alphaIdx];
  }

  return colors;
}

function decodeBlockCompressed(
  data: Uint8Array, h: DdsHeader, blockSize: number,
  decodeBlock: (d: Uint8Array, o: number) => Uint8Array,
): Uint8Array {
  const { width, height } = h;
  const bw = Math.max(1, Math.ceil(width / 4));
  const bh = Math.max(1, Math.ceil(height / 4));
  const rgba = new Uint8Array(width * height * 4);
  let si = 128;

  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const block = decodeBlock(data, si);
      si += blockSize;

      // Copy 4×4 block into output, clamping to image bounds
      for (let py = 0; py < 4; py++) {
        const iy = by * 4 + py;
        if (iy >= height) break;
        for (let px = 0; px < 4; px++) {
          const ix = bx * 4 + px;
          if (ix >= width) continue;
          const srcOff = (py * 4 + px) * 4;
          const dstOff = (iy * width + ix) * 4;
          rgba[dstOff] = block[srcOff];
          rgba[dstOff + 1] = block[srcOff + 1];
          rgba[dstOff + 2] = block[srcOff + 2];
          rgba[dstOff + 3] = block[srcOff + 3];
        }
      }
    }
  }

  return rgba;
}

export function decodeDds(data: Uint8Array): PixelGrid {
  const h = parseHeader(data);
  const { width, height, pfFlags, fourCC } = h;
  let rgba: Uint8Array;

  if (pfFlags & DDPF_FOURCC) {
    switch (fourCC) {
      case 'DXT1':
        rgba = decodeBlockCompressed(data, h, 8, (d, o) => decodeDxt1ColorBlock(d, o, false));
        break;
      case 'DXT3':
        rgba = decodeBlockCompressed(data, h, 16, decodeDxt3Block);
        break;
      case 'DXT5':
        rgba = decodeBlockCompressed(data, h, 16, decodeDxt5Block);
        break;
      default:
        throw new Error(`Unsupported DDS FourCC: ${fourCC}`);
    }
  } else if (pfFlags & DDPF_RGB) {
    rgba = decodeUncompressed(data, h);
  } else {
    throw new Error('Unsupported DDS pixel format');
  }

  return { width, height, data: rgba };
}
