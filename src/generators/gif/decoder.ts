import type { PixelGrid } from '../../types.ts';
import type { GifHeader, GifFrame } from './types.ts';

function readU16LE(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8);
}

function parseHeader(data: Uint8Array): { header: GifHeader; pos: number } {
  const sig = String.fromCharCode(...data.subarray(0, 6));
  if (!sig.startsWith('GIF')) throw new Error('Invalid GIF signature');

  const packed = data[10];
  const hasGlobalTable = (packed & 0x80) !== 0;
  const globalTableSize = hasGlobalTable ? 3 * (1 << ((packed & 0x07) + 1)) : 0;

  return {
    header: {
      width: readU16LE(data, 6),
      height: readU16LE(data, 8),
      hasGlobalTable,
      globalTableSize,
      bgColorIndex: data[11],
    },
    pos: 13 + globalTableSize,
  };
}

// LZW decoder for GIF image data
function lzwDecode(data: Uint8Array, pos: number, minCodeSize: number): { pixels: Uint8Array; endPos: number } {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;

  // Collect sub-blocks into a single bitstream
  const blocks: number[] = [];
  let p = pos;
  while (p < data.length) {
    const blockSize = data[p++];
    if (blockSize === 0) break;
    for (let i = 0; i < blockSize; i++) blocks.push(data[p++]);
  }

  const output: number[] = [];
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  const maxTableSize = 4096;

  // Code table: each entry is [prefix index, suffix byte]
  // For codes < clearCode, the entry is just the byte itself
  let table: (number[] | null)[] = [];

  function resetTable(): void {
    table = [];
    for (let i = 0; i < clearCode; i++) table[i] = [i];
    table[clearCode] = null;   // clear
    table[eoiCode] = null;     // eoi
    nextCode = eoiCode + 1;
    codeSize = minCodeSize + 1;
  }

  function getSequence(code: number): number[] {
    return table[code]!;
  }

  resetTable();

  let bitPos = 0;

  function readCode(): number {
    let val = 0;
    for (let i = 0; i < codeSize; i++) {
      const byteIdx = (bitPos + i) >> 3;
      const bitIdx = (bitPos + i) & 7;
      if (byteIdx < blocks.length && (blocks[byteIdx] & (1 << bitIdx))) {
        val |= 1 << i;
      }
    }
    bitPos += codeSize;
    return val;
  }

  // First code must be clear
  let code = readCode();
  if (code !== clearCode) resetTable();

  code = readCode();
  if (code === eoiCode) return { pixels: new Uint8Array(output), endPos: p };

  let prev = getSequence(code);
  output.push(...prev);

  while (bitPos < blocks.length * 8) {
    code = readCode();

    if (code === clearCode) {
      resetTable();
      code = readCode();
      if (code === eoiCode) break;
      prev = getSequence(code);
      output.push(...prev);
      continue;
    }

    if (code === eoiCode) break;

    let seq: number[];
    if (code < nextCode && table[code]) {
      seq = getSequence(code);
      if (nextCode < maxTableSize) {
        table[nextCode++] = [...prev, seq[0]];
      }
    } else {
      // code === nextCode (the special case)
      seq = [...prev, prev[0]];
      if (nextCode < maxTableSize) {
        table[nextCode++] = seq;
      }
    }

    output.push(...seq);
    prev = seq;

    // Increase code size when the table outgrows the current bit width
    if (nextCode > (1 << codeSize) - 1 && codeSize < 12) {
      codeSize++;
    }
  }

  return { pixels: new Uint8Array(output), endPos: p };
}

// GIF interlacing: rows are stored in 4 passes
function deinterlace(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(pixels.length);
  const passes = [
    { start: 0, step: 8 },
    { start: 4, step: 8 },
    { start: 2, step: 4 },
    { start: 1, step: 2 },
  ];

  let srcRow = 0;
  for (const { start, step } of passes) {
    for (let y = start; y < height; y += step) {
      out.set(pixels.subarray(srcRow * width, (srcRow + 1) * width), y * width);
      srcRow++;
    }
  }

  return out;
}

export function decodeGif(data: Uint8Array): PixelGrid {
  const { header, pos: startPos } = parseHeader(data);
  const globalTable = header.hasGlobalTable ? data.subarray(13, 13 + header.globalTableSize) : null;

  let pos = startPos;
  let transparentIndex = -1;

  // Skip extension blocks until we find an image descriptor
  while (pos < data.length) {
    const block = data[pos++];

    if (block === 0x21) {
      // Extension block
      const label = data[pos++];

      if (label === 0xF9) {
        // Graphics control extension
        const size = data[pos++];
        const packed = data[pos];
        const hasTransparency = (packed & 0x01) !== 0;
        transparentIndex = hasTransparency ? data[pos + 3] : -1;
        pos += size + 1; // +1 for block terminator
        continue;
      }

      // Skip other extensions
      while (pos < data.length) {
        const subSize = data[pos++];
        if (subSize === 0) break;
        pos += subSize;
      }
      continue;
    }

    if (block === 0x2C) {
      // Image descriptor - first frame
      const frame: GifFrame = {
        left: readU16LE(data, pos),
        top: readU16LE(data, pos + 2),
        width: readU16LE(data, pos + 4),
        height: readU16LE(data, pos + 6),
        hasLocalTable: (data[pos + 8] & 0x80) !== 0,
        localTableSize: (data[pos + 8] & 0x80) ? 3 * (1 << ((data[pos + 8] & 0x07) + 1)) : 0,
        interlaced: (data[pos + 8] & 0x40) !== 0,
      };
      pos += 9;

      const colorTable = frame.hasLocalTable
        ? data.subarray(pos, pos + frame.localTableSize)
        : globalTable;
      if (frame.hasLocalTable) pos += frame.localTableSize;
      if (!colorTable) throw new Error('GIF frame has no color table');

      const minCodeSize = data[pos++];
      const { pixels } = lzwDecode(data, pos, minCodeSize);

      const indices = frame.interlaced
        ? deinterlace(pixels, frame.width, frame.height)
        : pixels;

      // Map palette indices to RGBA on the full canvas
      const { width: canvasW, height: canvasH } = header;
      const rgba = new Uint8Array(canvasW * canvasH * 4);

      for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
          const idx = indices[y * frame.width + x];
          const di = ((frame.top + y) * canvasW + (frame.left + x)) * 4;
          const ci = idx * 3;
          rgba[di] = colorTable[ci];
          rgba[di + 1] = colorTable[ci + 1];
          rgba[di + 2] = colorTable[ci + 2];
          rgba[di + 3] = idx === transparentIndex ? 0 : 255;
        }
      }

      return { width: canvasW, height: canvasH, data: rgba };
    }

    if (block === 0x3B) break; // Trailer
  }

  throw new Error('No image data found in GIF');
}
