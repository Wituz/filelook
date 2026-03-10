import type { PixelGrid, DecodeHints } from '../../types.ts';
import {
  ZIGZAG,
  type HuffmanTable,
  type QuantizationTable,
  type FrameInfo,
  type FrameComponent,
  type ScanComponent,
} from './types.ts';

const M_SOI = 0xD8;
const M_SOF0 = 0xC0;
const M_SOF2 = 0xC2;
const M_DHT = 0xC4;
const M_DQT = 0xDB;
const M_DRI = 0xDD;
const M_SOS = 0xDA;
const M_EOI = 0xD9;

// --- Bit reader with JPEG byte-stuffing (0xFF00 → 0xFF) ---

class BitReader {
  pos: number;
  private bitBuf = 0;
  private bitCount = 0;

  constructor(private data: Uint8Array, startPos: number) {
    this.pos = startPos;
  }

  reset(): void {
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  readBit(): number {
    if (this.bitCount === 0) {
      let byte = this.data[this.pos++];
      if (byte === 0xFF) {
        const next = this.data[this.pos++];
        if (next !== 0) throw new Error(`Unexpected marker 0xFF${next.toString(16)} in scan data`);
      }
      this.bitBuf = byte;
      this.bitCount = 8;
    }
    this.bitCount--;
    return (this.bitBuf >>> this.bitCount) & 1;
  }

  readBits(n: number): number {
    let val = 0;
    for (let i = 0; i < n; i++) {
      val = (val << 1) | this.readBit();
    }
    return val;
  }

  extend(value: number, bits: number): number {
    if (bits === 0) return 0;
    const threshold = 1 << (bits - 1);
    return value < threshold ? value - (2 * threshold - 1) : value;
  }

  decodeHuffman(table: HuffmanTable): number {
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | this.readBit();
      if (code <= table.maxCode[len]) {
        return table.values[table.valPtr[len] + code - table.minCode[len]];
      }
    }
    throw new Error('Invalid Huffman code');
  }

  // Find the next marker in the data stream after scan data
  findNextMarker(): number {
    this.reset();
    // Scan data may not be byte-aligned, search for 0xFF followed by non-zero
    let p = this.pos;
    while (p < this.data.length - 1) {
      if (this.data[p] === 0xFF && this.data[p + 1] !== 0x00 && this.data[p + 1] !== 0xFF) {
        this.pos = p;
        return this.data[p + 1];
      }
      p++;
    }
    return M_EOI;
  }
}

function readU16BE(data: Uint8Array, pos: number): number {
  return (data[pos] << 8) | data[pos + 1];
}

function buildHuffmanTable(bits: Uint8Array, values: Uint8Array): HuffmanTable {
  const minCode = new Int32Array(17);
  const maxCode = new Int32Array(17).fill(-1);
  const valPtr = new Int32Array(17);

  let code = 0;
  let valIdx = 0;
  for (let len = 1; len <= 16; len++) {
    const count = bits[len - 1];
    if (count > 0) {
      minCode[len] = code;
      valPtr[len] = valIdx;
      maxCode[len] = code + count - 1;
      valIdx += count;
    }
    code = (code + count) << 1;
  }

  return { minCode, maxCode, valPtr, values };
}

// --- Inverse DCT ---

const C1 = 0.9807852804;
const C2 = 0.9238795325;
const C3 = 0.8314696123;
const C5 = 0.5555702330;
const C6 = 0.3826834324;
const C7 = 0.1950903220;

const _colScratch = new Float64Array(8);

function idctPass(s0: number, s1: number, s2: number, s3: number,
  s4: number, s5: number, s6: number, s7: number,
  out: Float64Array, o: number): void {
  const p0 = (s0 + s4) * 0.5;
  const p1 = (s0 - s4) * 0.5;
  const p2 = s2 * C6 - s6 * C2;
  const p3 = s2 * C2 + s6 * C6;
  const t0 = p0 + p3, t1 = p1 + p2, t2 = p1 - p2, t3 = p0 - p3;
  const q0 = s1 * C1 + s3 * C3 + s5 * C5 + s7 * C7;
  const q1 = s1 * C3 - s3 * C7 - s5 * C1 - s7 * C5;
  const q2 = s1 * C5 - s3 * C1 + s5 * C7 + s7 * C3;
  const q3 = s1 * C7 - s3 * C5 + s5 * C3 - s7 * C1;
  out[o] = t0+q0; out[o+1] = t1+q1; out[o+2] = t2+q2; out[o+3] = t3+q3;
  out[o+4] = t3-q3; out[o+5] = t2-q2; out[o+6] = t1-q1; out[o+7] = t0-q0;
}

function inverseDCT(coefficients: Int32Array, qt: Int32Array): Float64Array {
  const block = new Float64Array(64);

  for (let i = 0; i < 64; i++) {
    block[ZIGZAG[i]] = coefficients[i] * qt[i];
  }

  // Row pass — write directly into block (contiguous rows)
  for (let r = 0; r < 8; r++) {
    const o = r * 8;
    idctPass(block[o], block[o+1], block[o+2], block[o+3],
      block[o+4], block[o+5], block[o+6], block[o+7], block, o);
  }

  // Column pass — use scratch buffer, scatter back
  for (let c = 0; c < 8; c++) {
    idctPass(block[c], block[8+c], block[16+c], block[24+c],
      block[32+c], block[40+c], block[48+c], block[56+c], _colScratch, 0);
    for (let r = 0; r < 8; r++) block[r * 8 + c] = _colScratch[r];
  }

  return block;
}

// --- Scan state shared between baseline and progressive ---

interface ScanParams {
  scanComps: ScanComponent[];
  ss: number;  // spectral selection start
  se: number;  // spectral selection end
  ah: number;  // successive approximation high bit
  al: number;  // successive approximation low bit
}

// --- Main decoder ---

export function decodeJpeg(data: Uint8Array, hints?: DecodeHints): PixelGrid {
  if (data[0] !== 0xFF || data[1] !== M_SOI) throw new Error('Invalid JPEG: missing SOI');

  const dcTables: HuffmanTable[] = [];
  const acTables: HuffmanTable[] = [];
  const qtTables: QuantizationTable[] = [];
  let frame: FrameInfo | null = null;
  let progressive = false;
  let restartInterval = 0;

  // Coefficient storage for progressive — allocated after SOF
  let coeffBlocks: Int32Array[][][] | null = null;
  let mcuCols = 0;
  let mcuRows = 0;
  let useDCOnly = false;

  let pos = 2;

  while (pos < data.length) {
    if (data[pos] !== 0xFF) { pos++; continue; }

    while (pos < data.length - 1 && data[pos + 1] === 0xFF) pos++;
    const marker = data[pos + 1];
    pos += 2;

    if (marker === M_EOI) break;
    if (marker === M_SOI || (marker >= 0xD0 && marker <= 0xD7)) continue;

    const segLen = readU16BE(data, pos);

    if (marker === M_DQT) {
      let off = pos + 2;
      const end = pos + segLen;
      while (off < end) {
        const info = data[off++];
        const precision = info >> 4;
        const tableId = info & 0x0F;
        const qt = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
          qt[i] = precision === 0 ? data[off++] : readU16BE(data, (off += 2) - 2);
        }
        qtTables[tableId] = { data: qt };
      }
    } else if (marker === M_SOF0 || marker === M_SOF2) {
      progressive = marker === M_SOF2;
      const precision = data[pos + 2];
      if (precision !== 8) throw new Error(`Unsupported JPEG precision: ${precision}`);
      const height = readU16BE(data, pos + 3);
      const width = readU16BE(data, pos + 5);
      const numComps = data[pos + 7];
      const components: FrameComponent[] = [];
      let maxH = 1, maxV = 1;

      for (let i = 0; i < numComps; i++) {
        const off = pos + 8 + i * 3;
        const hv = data[off + 1];
        const hSample = hv >> 4;
        const vSample = hv & 0x0F;
        maxH = Math.max(maxH, hSample);
        maxV = Math.max(maxV, vSample);
        components.push({ id: data[off], hSample, vSample, qtId: data[off + 2] });
      }

      frame = { width, height, components, maxH, maxV };
      mcuCols = Math.ceil(width / (maxH * 8));
      mcuRows = Math.ceil(height / (maxV * 8));

      // DC-only mode: 1 pixel per 8x8 block is enough when that's still >= target
      const dcWidth = mcuCols * maxH;
      const dcHeight = mcuRows * maxV;
      useDCOnly = hints != null
        && dcWidth >= hints.targetWidth
        && dcHeight >= hints.targetHeight;

      // Pre-allocate coefficient blocks for all components
      coeffBlocks = components.map(comp => {
        const bH = mcuCols * comp.hSample;
        const bV = mcuRows * comp.vSample;
        return Array.from({ length: bV }, () =>
          Array.from({ length: bH }, () => new Int32Array(useDCOnly ? 1 : 64)),
        );
      });
    } else if (marker === M_DHT) {
      let off = pos + 2;
      const end = pos + segLen;
      while (off < end) {
        const info = data[off++];
        const bits = data.subarray(off, off + 16);
        off += 16;
        let totalCodes = 0;
        for (let i = 0; i < 16; i++) totalCodes += bits[i];
        const values = new Uint8Array(data.subarray(off, off + totalCodes));
        off += totalCodes;
        const table = buildHuffmanTable(bits, values);
        if ((info >> 4) === 0) dcTables[info & 0x0F] = table;
        else acTables[info & 0x0F] = table;
      }
    } else if (marker === M_DRI) {
      restartInterval = readU16BE(data, pos + 2);
    } else if (marker === M_SOS) {
      if (!frame || !coeffBlocks) throw new Error('SOS before SOF');

      const numScanComps = data[pos + 2];
      const scanComps: ScanComponent[] = [];
      for (let i = 0; i < numScanComps; i++) {
        const off = pos + 3 + i * 2;
        const compId = data[off];
        const tdta = data[off + 1];
        const compIdx = frame.components.findIndex(c => c.id === compId);
        scanComps.push({ compIdx, dcTableId: tdta >> 4, acTableId: tdta & 0x0F });
      }

      // Spectral selection and successive approximation params (after component list)
      const paramOff = pos + 3 + numScanComps * 2;
      const ss = data[paramOff];
      const se = data[paramOff + 1];
      const ahl = data[paramOff + 2];
      const scanParams: ScanParams = { scanComps, ss, se, ah: ahl >> 4, al: ahl & 0x0F };

      const scanStart = pos + segLen;
      const reader = new BitReader(data, scanStart);

      // In DC-only mode, skip AC scans entirely for progressive JPEGs
      if (useDCOnly && progressive && ss > 0) {
        // Skip past scan data without decoding
      } else if (progressive) {
        decodeProgressiveScan(reader, frame, coeffBlocks, scanParams, dcTables, acTables, restartInterval, mcuCols, mcuRows);
      } else {
        decodeBaselineScan(reader, frame, coeffBlocks, scanParams, dcTables, acTables, restartInterval, mcuCols, mcuRows, useDCOnly);
      }

      // Advance pos past the scan data to the next marker
      const nextMarker = reader.findNextMarker();
      pos = reader.pos;

      if (nextMarker === M_EOI && !progressive) break;
      continue; // re-enter marker loop at the found position
    }

    pos += segLen;
  }

  if (!frame || !coeffBlocks) throw new Error('Invalid JPEG: no image data found');

  if (useDCOnly) {
    return assembleDCPixels(coeffBlocks, frame, qtTables, mcuCols, mcuRows);
  }
  return assemblePixels(coeffBlocks, frame, qtTables, mcuCols, mcuRows);
}

// --- Baseline scan: all coefficients in one pass ---

function decodeBaselineScan(
  reader: BitReader, frame: FrameInfo, coeffBlocks: Int32Array[][][],
  params: ScanParams, dcTables: HuffmanTable[], acTables: HuffmanTable[],
  restartInterval: number, mcuCols: number, mcuRows: number,
  dcOnly = false,
): void {
  const { components } = frame;
  const prevDC = new Int32Array(components.length);
  let mcuCount = 0;

  for (let mcuRow = 0; mcuRow < mcuRows; mcuRow++) {
    for (let mcuCol = 0; mcuCol < mcuCols; mcuCol++) {
      if (restartInterval > 0 && mcuCount > 0 && mcuCount % restartInterval === 0) {
        handleRestart(reader);
        prevDC.fill(0);
      }

      for (const sc of params.scanComps) {
        const comp = components[sc.compIdx];
        const dcTable = dcTables[sc.dcTableId];
        const acTable = acTables[sc.acTableId];

        for (let v = 0; v < comp.vSample; v++) {
          for (let h = 0; h < comp.hSample; h++) {
            const blockRow = mcuRow * comp.vSample + v;
            const blockCol = mcuCol * comp.hSample + h;
            const coeffs = coeffBlocks[sc.compIdx][blockRow][blockCol];

            // DC
            const dcLen = reader.decodeHuffman(dcTable);
            if (dcLen > 0) {
              prevDC[sc.compIdx] += reader.extend(reader.readBits(dcLen), dcLen);
            }
            coeffs[0] = prevDC[sc.compIdx];

            // AC — must still read from bitstream to maintain alignment
            let k = 1;
            while (k < 64) {
              const rs = reader.decodeHuffman(acTable);
              const run = rs >> 4;
              const size = rs & 0x0F;
              if (size === 0) {
                if (run === 0x0F) { k += 16; continue; }
                break;
              }
              k += run;
              if (k >= 64) break;
              const val = reader.extend(reader.readBits(size), size);
              if (!dcOnly) coeffs[k] = val;
              k++;
            }
          }
        }
      }
      mcuCount++;
    }
  }
}

// --- Progressive scan: spectral selection + successive approximation ---

function decodeProgressiveScan(
  reader: BitReader, frame: FrameInfo, coeffBlocks: Int32Array[][][],
  params: ScanParams, dcTables: HuffmanTable[], acTables: HuffmanTable[],
  restartInterval: number, mcuCols: number, mcuRows: number,
): void {
  const { ss, se, ah, al, scanComps } = params;
  const { components } = frame;
  const prevDC = new Int32Array(components.length);
  let mcuCount = 0;

  const isDC = ss === 0;
  const isFirstDC = isDC && ah === 0;
  const isRefineDC = isDC && ah !== 0;
  const isFirstAC = !isDC && ah === 0;

  // Interleaved scan (multiple components) — only for DC
  if (scanComps.length > 1) {
    for (let mcuRow = 0; mcuRow < mcuRows; mcuRow++) {
      for (let mcuCol = 0; mcuCol < mcuCols; mcuCol++) {
        if (restartInterval > 0 && mcuCount > 0 && mcuCount % restartInterval === 0) {
          handleRestart(reader);
          prevDC.fill(0);
        }

        for (const sc of scanComps) {
          const comp = components[sc.compIdx];
          for (let v = 0; v < comp.vSample; v++) {
            for (let h = 0; h < comp.hSample; h++) {
              const coeffs = coeffBlocks[sc.compIdx][mcuRow * comp.vSample + v][mcuCol * comp.hSample + h];
              if (isFirstDC) {
                const dcLen = reader.decodeHuffman(dcTables[sc.dcTableId]);
                if (dcLen > 0) prevDC[sc.compIdx] += reader.extend(reader.readBits(dcLen), dcLen);
                coeffs[0] = prevDC[sc.compIdx] << al;
              } else if (isRefineDC) {
                coeffs[0] |= reader.readBit() << al;
              }
            }
          }
        }
        mcuCount++;
      }
    }
    return;
  }

  // Non-interleaved scan (single component)
  const sc = scanComps[0];
  const comp = components[sc.compIdx];
  const blocksH = mcuCols * comp.hSample;
  const blocksV = mcuRows * comp.vSample;

  // EOB run counter for progressive AC scans
  let eobRun = 0;

  for (let blockRow = 0; blockRow < blocksV; blockRow++) {
    for (let blockCol = 0; blockCol < blocksH; blockCol++) {
      if (restartInterval > 0 && mcuCount > 0 && mcuCount % restartInterval === 0) {
        handleRestart(reader);
        prevDC.fill(0);
        eobRun = 0;
      }

      const coeffs = coeffBlocks[sc.compIdx][blockRow][blockCol];

      if (isDC) {
        if (isFirstDC) {
          const dcLen = reader.decodeHuffman(dcTables[sc.dcTableId]);
          if (dcLen > 0) prevDC[sc.compIdx] += reader.extend(reader.readBits(dcLen), dcLen);
          coeffs[0] = prevDC[sc.compIdx] << al;
        } else {
          coeffs[0] |= reader.readBit() << al;
        }
      } else if (isFirstAC) {
        // First AC scan for this spectral range
        if (eobRun > 0) {
          eobRun--;
        } else {
          let k = ss;
          while (k <= se) {
            const rs = reader.decodeHuffman(acTables[sc.acTableId]);
            const run = rs >> 4;
            const size = rs & 0x0F;

            if (size === 0) {
              if (run < 15) {
                // EOB run
                eobRun = (1 << run) - 1;
                if (run > 0) eobRun += reader.readBits(run);
                break;
              }
              k += 16;
              continue;
            }

            k += run;
            if (k > se) break;
            coeffs[k] = reader.extend(reader.readBits(size), size) << al;
            k++;
          }
        }
      } else {
        // Refining AC scan — update previously nonzero coefficients and add new ones
        let k = ss;
        if (eobRun > 0) {
          // Refine existing nonzero coefficients within the EOB run
          for (; k <= se; k++) {
            if (coeffs[k] !== 0) {
              if (reader.readBit()) {
                coeffs[k] += coeffs[k] > 0 ? (1 << al) : -(1 << al);
              }
            }
          }
          eobRun--;
        } else {
          while (k <= se) {
            const rs = reader.decodeHuffman(acTables[sc.acTableId]);
            const run = rs >> 4;
            const size = rs & 0x0F;

            if (size === 0 && run < 15) {
              // EOB run
              eobRun = (1 << run);
              if (run > 0) eobRun += reader.readBits(run);
              // Refine remaining nonzero coefficients
              for (; k <= se; k++) {
                if (coeffs[k] !== 0) {
                  if (reader.readBit()) {
                    coeffs[k] += coeffs[k] > 0 ? (1 << al) : -(1 << al);
                  }
                }
              }
              eobRun--;
              break;
            }

            // Skip 'run' zero coefficients, refining any nonzero ones we pass over
            let zerosToSkip = run;
            while (k <= se) {
              if (coeffs[k] !== 0) {
                if (reader.readBit()) {
                  coeffs[k] += coeffs[k] > 0 ? (1 << al) : -(1 << al);
                }
              } else {
                if (zerosToSkip === 0) break;
                zerosToSkip--;
              }
              k++;
            }

            if (k > se) break;

            if (size === 1) {
              coeffs[k] = reader.extend(reader.readBits(1), 1) << al;
            }
            k++;
          }
        }
      }

      mcuCount++;
    }
  }
}

function handleRestart(reader: BitReader): void {
  reader.reset();
  // Skip to the restart marker (0xFF 0xDn)
  while (reader.pos < 2) break;
  if (reader['data'][reader.pos] === 0xFF) {
    reader.pos += 2;
  }
}

// --- DC-only assembly: 1 pixel per 8x8 block, no IDCT ---

function assembleDCPixels(
  coeffBlocks: Int32Array[][][],
  frame: FrameInfo,
  qtTables: QuantizationTable[],
  mcuCols: number,
  mcuRows: number,
): PixelGrid {
  const { components, maxH, maxV } = frame;
  const outW = mcuCols * maxH;
  const outH = mcuRows * maxV;
  const rgba = new Uint8Array(outW * outH * 4);

  // DC normalization: two idctPass stages each multiply DC by 0.5 → 0.25 total
  const dcScales = components.map(comp => qtTables[comp.qtId].data[0] * 0.25);

  if (components.length === 1) {
    const scale = dcScales[0];
    const blocks = coeffBlocks[0];
    for (let by = 0; by < blocks.length; by++) {
      const row = blocks[by];
      for (let bx = 0; bx < row.length; bx++) {
        const v = clamp(row[bx][0] * scale + 128);
        const i = (by * outW + bx) * 4;
        rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
      }
    }
  } else {
    // Build per-component DC value arrays at native block resolution
    const dcImages = components.map((comp, ci) => {
      const scale = dcScales[ci];
      const bH = mcuCols * comp.hSample;
      const bV = mcuRows * comp.vSample;
      const img = new Float64Array(bV * bH);
      for (let by = 0; by < bV; by++) {
        for (let bx = 0; bx < bH; bx++) {
          img[by * bH + bx] = coeffBlocks[ci][by][bx][0] * scale + 128;
        }
      }
      return img;
    });

    const h0 = components[0].hSample, v0 = components[0].vSample;
    const h1 = components[1].hSample, v1 = components[1].vSample;
    const h2 = components[2].hSample, v2 = components[2].vSample;
    const w0 = mcuCols * h0, w1 = mcuCols * h1, w2 = mcuCols * h2;

    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const yy = dcImages[0][(y * v0 / maxV | 0) * w0 + (x * h0 / maxH | 0)];
        const cb = dcImages[1][(y * v1 / maxV | 0) * w1 + (x * h1 / maxH | 0)];
        const cr = dcImages[2][(y * v2 / maxV | 0) * w2 + (x * h2 / maxH | 0)];

        const i = (y * outW + x) * 4;
        rgba[i]     = clamp(yy + 1.402 * (cr - 128));
        rgba[i + 1] = clamp(yy - 0.344136 * (cb - 128) - 0.714136 * (cr - 128));
        rgba[i + 2] = clamp(yy + 1.772 * (cb - 128));
        rgba[i + 3] = 255;
      }
    }
  }

  return { width: outW, height: outH, data: rgba };
}

// --- Assemble decoded blocks into RGBA pixels ---

function assemblePixels(
  coeffBlocks: Int32Array[][][],
  frame: FrameInfo,
  qtTables: QuantizationTable[],
  mcuCols: number,
  mcuRows: number,
): PixelGrid {
  const { width, height, components, maxH, maxV } = frame;

  // IDCT all blocks
  const pixelBlocks: Float64Array[][][] = components.map((comp, ci) => {
    const qt = qtTables[comp.qtId].data;
    const bH = mcuCols * comp.hSample;
    const bV = mcuRows * comp.vSample;
    return Array.from({ length: bV }, (_, row) =>
      Array.from({ length: bH }, (_, col) => inverseDCT(coeffBlocks[ci][row][col], qt)),
    );
  });

  const rgba = new Uint8Array(width * height * 4);
  const isGrayscale = components.length === 1;

  if (isGrayscale) {
    const h0 = components[0].hSample, v0 = components[0].vSample;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sx = (x * h0) / maxH;
        const sy = (y * v0) / maxV;
        const val = pixelBlocks[0][Math.floor(sy / 8)]?.[Math.floor(sx / 8)]?.[Math.floor(sy) % 8 * 8 + Math.floor(sx) % 8] ?? 0;
        const v = clamp(val + 128);
        const i = (y * width + x) * 4;
        rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
      }
    }
  } else {
    const h0 = components[0].hSample, v0 = components[0].vSample;
    const h1 = components[1].hSample, v1 = components[1].vSample;
    const h2 = components[2].hSample, v2 = components[2].vSample;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sx0 = (x * h0) / maxH, sy0 = (y * v0) / maxV;
        const yy = (pixelBlocks[0][Math.floor(sy0 / 8)]?.[Math.floor(sx0 / 8)]?.[Math.floor(sy0) % 8 * 8 + Math.floor(sx0) % 8] ?? 0) + 128;

        const sx1 = (x * h1) / maxH, sy1 = (y * v1) / maxV;
        const cb = (pixelBlocks[1][Math.floor(sy1 / 8)]?.[Math.floor(sx1 / 8)]?.[Math.floor(sy1) % 8 * 8 + Math.floor(sx1) % 8] ?? 0) + 128;

        const sx2 = (x * h2) / maxH, sy2 = (y * v2) / maxV;
        const cr = (pixelBlocks[2][Math.floor(sy2 / 8)]?.[Math.floor(sx2 / 8)]?.[Math.floor(sy2) % 8 * 8 + Math.floor(sx2) % 8] ?? 0) + 128;

        const i = (y * width + x) * 4;
        rgba[i] = clamp(yy + 1.402 * (cr - 128));
        rgba[i + 1] = clamp(yy - 0.344136 * (cb - 128) - 0.714136 * (cr - 128));
        rgba[i + 2] = clamp(yy + 1.772 * (cb - 128));
        rgba[i + 3] = 255;
      }
    }
  }

  return { width, height, data: rgba };
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
