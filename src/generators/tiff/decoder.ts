import { inflateSync } from 'node:zlib';
import type { PixelGrid } from '../../types.ts';
import {
  Tag, Compression, Photometric, FieldType, FIELD_TYPE_SIZE,
  type TiffHeader, type IfdEntry, type TiffInfo,
} from './types.ts';

// Endianness-aware reader — TIFF can be LE or BE
class TiffReader {
  constructor(
    private readonly data: Uint8Array,
    private readonly le: boolean,
  ) {}

  readU16(o: number): number {
    return this.le
      ? this.data[o] | (this.data[o + 1] << 8)
      : (this.data[o] << 8) | this.data[o + 1];
  }

  readU32(o: number): number {
    return this.le
      ? (this.data[o] | (this.data[o + 1] << 8) | (this.data[o + 2] << 16) | (this.data[o + 3] << 24)) >>> 0
      : ((this.data[o] << 24) | (this.data[o + 1] << 16) | (this.data[o + 2] << 8) | this.data[o + 3]) >>> 0;
  }
}

function parseHeader(data: Uint8Array): TiffHeader {
  const le = data[0] === 0x49 && data[1] === 0x49;
  const be = data[0] === 0x4D && data[1] === 0x4D;
  if (!le && !be) throw new Error('Invalid TIFF: bad byte order marker');

  const r = new TiffReader(data, le);
  if (r.readU16(2) !== 42) throw new Error('Invalid TIFF: bad magic number');

  return { littleEndian: le, ifdOffset: r.readU32(4) };
}

function parseIfd(r: TiffReader, offset: number): IfdEntry[] {
  const count = r.readU16(offset);
  const entries: IfdEntry[] = [];
  for (let i = 0; i < count; i++) {
    const o = offset + 2 + i * 12;
    entries.push({
      tag: r.readU16(o),
      type: r.readU16(o + 2),
      count: r.readU32(o + 4),
      valueOffset: o + 8, // position of the 4-byte value field itself
    });
  }
  return entries;
}

function readEntryValues(r: TiffReader, entry: IfdEntry): number[] {
  const size = FIELD_TYPE_SIZE[entry.type] ?? 1;
  const totalBytes = size * entry.count;
  // Inline if fits in 4 bytes, otherwise dereference as file offset
  const dataOffset = totalBytes <= 4 ? entry.valueOffset : r.readU32(entry.valueOffset);

  const values: number[] = [];
  for (let i = 0; i < entry.count; i++) {
    const pos = dataOffset + i * size;
    switch (entry.type) {
      case FieldType.BYTE:  values.push(r.readU16(pos) & 0xFF); break;
      case FieldType.SHORT: values.push(r.readU16(pos)); break;
      case FieldType.LONG:  values.push(r.readU32(pos)); break;
      default:              values.push(r.readU32(pos)); break;
    }
  }
  return values;
}

function buildTiffInfo(r: TiffReader, entries: IfdEntry[]): TiffInfo {
  const map = new Map(entries.map(e => [e.tag, e]));

  function vals(tag: Tag): number[] {
    const e = map.get(tag);
    if (!e) throw new Error(`Missing required TIFF tag: ${tag}`);
    return readEntryValues(r, e);
  }

  function val(tag: Tag): number { return vals(tag)[0]; }

  function optVal(tag: Tag, def: number): number {
    const e = map.get(tag);
    return e ? readEntryValues(r, e)[0] : def;
  }

  const width = val(Tag.ImageWidth);
  const height = val(Tag.ImageLength);
  const compression = val(Tag.Compression) as Compression;
  const photometric = val(Tag.PhotometricInterpretation) as Photometric;
  const samplesPerPixel = optVal(Tag.SamplesPerPixel, 1);
  const bitsPerSample = map.has(Tag.BitsPerSample) ? vals(Tag.BitsPerSample) : [1];
  const rowsPerStrip = optVal(Tag.RowsPerStrip, height);
  const stripOffsets = vals(Tag.StripOffsets);
  const stripByteCounts = vals(Tag.StripByteCounts);

  let colorMap: Uint16Array | null = null;
  if (photometric === Photometric.Palette && map.has(Tag.ColorMap)) {
    colorMap = new Uint16Array(readEntryValues(r, map.get(Tag.ColorMap)!));
  }

  const extraSamples = map.has(Tag.ExtraSamples)
    ? readEntryValues(r, map.get(Tag.ExtraSamples)!)[0] : null;

  const planar = optVal(Tag.PlanarConfiguration, 1);
  if (planar !== 1) throw new Error('Unsupported TIFF planar configuration');

  for (const bps of bitsPerSample) {
    if (bps !== 8) throw new Error(`Unsupported TIFF bits per sample: ${bps}`);
  }

  if (photometric === Photometric.RGB && samplesPerPixel < 3) {
    throw new Error('TIFF RGB image must have at least 3 samples per pixel');
  }

  return {
    width, height, bitsPerSample, compression, photometric,
    stripOffsets, samplesPerPixel, rowsPerStrip, stripByteCounts,
    colorMap, extraSamples,
  };
}

// --- Decompression ---

function decompressPackBits(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    const n = (src[i] << 24) >> 24; // sign-extend to int8
    i++;
    if (n >= 0) {
      for (let j = 0; j <= n; j++) out.push(src[i++]);
    } else if (n > -128) {
      const val = src[i++];
      for (let j = 0; j < 1 - n; j++) out.push(val);
    }
  }
  return new Uint8Array(out);
}

function decompressLzw(src: Uint8Array): Uint8Array {
  const CLEAR = 256;
  const EOI = 257;
  const FIRST = 258;
  const MAX_BITS = 12;

  const output: number[] = [];
  let codeSize = 9;
  let nextCode = FIRST;
  let table: (Uint8Array | null)[] = [];

  function resetTable(): void {
    table = new Array(258);
    for (let i = 0; i < 256; i++) table[i] = new Uint8Array([i]);
    table[CLEAR] = null;
    table[EOI] = null;
    nextCode = FIRST;
    codeSize = 9;
  }

  // MSB-first bit reader (TIFF LZW, unlike GIF's LSB-first)
  let bitPos = 0;

  function readCode(): number {
    let val = 0;
    for (let i = 0; i < codeSize; i++) {
      const byteIdx = (bitPos + i) >> 3;
      const bitIdx = 7 - ((bitPos + i) & 7);
      if (byteIdx < src.length && (src[byteIdx] & (1 << bitIdx))) {
        val |= 1 << (codeSize - 1 - i);
      }
    }
    bitPos += codeSize;
    return val;
  }

  resetTable();

  let code = readCode();
  if (code !== CLEAR) throw new Error('TIFF LZW: expected clear code');

  code = readCode();
  if (code === EOI) return new Uint8Array(output);

  let prev = table[code]!;
  for (let i = 0; i < prev.length; i++) output.push(prev[i]);

  while (bitPos < src.length * 8) {
    code = readCode();

    if (code === CLEAR) {
      resetTable();
      code = readCode();
      if (code === EOI) break;
      prev = table[code]!;
      for (let i = 0; i < prev.length; i++) output.push(prev[i]);
      continue;
    }

    if (code === EOI) break;

    let seq: Uint8Array;
    if (code < nextCode && table[code]) {
      seq = table[code]!;
      if (nextCode < (1 << MAX_BITS)) {
        const entry = new Uint8Array(prev.length + 1);
        entry.set(prev);
        entry[prev.length] = seq[0];
        table[nextCode] = entry;
        nextCode++;
      }
    } else {
      // code === nextCode: sequence not yet in table
      seq = new Uint8Array(prev.length + 1);
      seq.set(prev);
      seq[prev.length] = prev[0];
      if (nextCode < (1 << MAX_BITS)) {
        table[nextCode] = seq;
        nextCode++;
      }
    }

    for (let i = 0; i < seq.length; i++) output.push(seq[i]);
    prev = seq;

    // TIFF "early change": increment before table is full at current size
    if (nextCode >= (1 << codeSize) - 1 && codeSize < MAX_BITS) {
      codeSize++;
    }
  }

  return new Uint8Array(output);
}

function readStrips(data: Uint8Array, info: TiffInfo): Uint8Array {
  const chunks: Uint8Array[] = [];

  for (let i = 0; i < info.stripOffsets.length; i++) {
    const raw = data.subarray(
      info.stripOffsets[i],
      info.stripOffsets[i] + info.stripByteCounts[i],
    );

    switch (info.compression) {
      case Compression.None:
        chunks.push(raw);
        break;
      case Compression.PackBits:
        chunks.push(decompressPackBits(raw));
        break;
      case Compression.LZW:
        chunks.push(decompressLzw(raw));
        break;
      case Compression.Deflate:
      case Compression.AdobeDeflate:
        chunks.push(new Uint8Array(inflateSync(raw)));
        break;
      default:
        throw new Error(`Unsupported TIFF compression: ${info.compression}`);
    }
  }

  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// --- Color conversion ---

function toRGBA(pixels: Uint8Array, info: TiffInfo): Uint8Array {
  const { width, height, photometric, samplesPerPixel, colorMap, extraSamples } = info;
  const total = width * height;
  const rgba = new Uint8Array(total * 4);
  const hasAlpha = extraSamples !== null && samplesPerPixel > (photometric === Photometric.RGB ? 3 : 1);

  for (let i = 0; i < total; i++) {
    const si = i * samplesPerPixel;
    const di = i * 4;

    switch (photometric) {
      case Photometric.RGB:
        rgba[di] = pixels[si];
        rgba[di + 1] = pixels[si + 1];
        rgba[di + 2] = pixels[si + 2];
        rgba[di + 3] = hasAlpha ? pixels[si + 3] : 255;
        break;

      case Photometric.BlackIsZero: {
        const v = pixels[si];
        rgba[di] = rgba[di + 1] = rgba[di + 2] = v;
        rgba[di + 3] = hasAlpha ? pixels[si + 1] : 255;
        break;
      }

      case Photometric.WhiteIsZero: {
        const v = 255 - pixels[si];
        rgba[di] = rgba[di + 1] = rgba[di + 2] = v;
        rgba[di + 3] = hasAlpha ? pixels[si + 1] : 255;
        break;
      }

      case Photometric.Palette: {
        if (!colorMap) throw new Error('TIFF palette image missing ColorMap');
        const idx = pixels[si];
        const n = colorMap.length / 3;
        // TIFF ColorMap: all R values, then all G, then all B (16-bit each)
        rgba[di] = (colorMap[idx] >> 8) & 0xFF;
        rgba[di + 1] = (colorMap[n + idx] >> 8) & 0xFF;
        rgba[di + 2] = (colorMap[2 * n + idx] >> 8) & 0xFF;
        rgba[di + 3] = 255;
        break;
      }

      default:
        throw new Error(`Unsupported TIFF photometric: ${photometric}`);
    }
  }

  return rgba;
}

export function decodeTiff(data: Uint8Array): PixelGrid {
  const header = parseHeader(data);
  const r = new TiffReader(data, header.littleEndian);
  const entries = parseIfd(r, header.ifdOffset);
  const info = buildTiffInfo(r, entries);
  const pixels = readStrips(data, info);
  const rgba = toRGBA(pixels, info);
  return { width: info.width, height: info.height, data: rgba };
}
