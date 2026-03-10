import { BitReader } from './h264.ts';

// --- VLC tree decoder ---

interface VlcNode {
  value?: [number, number];
  children?: [VlcNode | null, VlcNode | null];
}

function buildTree(entries: Array<[string, number, number]>): VlcNode {
  const root: VlcNode = {};
  for (const [code, a, b] of entries) {
    let node = root;
    for (let i = 0; i < code.length; i++) {
      if (!node.children) node.children = [null, null];
      const bit = code[i] === '1' ? 1 : 0;
      if (!node.children[bit]) node.children[bit] = {};
      node = node.children[bit]!;
    }
    node.value = [a, b];
  }
  return root;
}

function decodeTree(reader: BitReader, root: VlcNode): [number, number] {
  let node = root;
  for (let i = 0; i < 32; i++) {
    if (node.value !== undefined) return node.value;
    if (!node.children) throw new Error('CAVLC: invalid VLC code');
    const bit = reader.readBit();
    const next = node.children[bit];
    if (!next) throw new Error('CAVLC: invalid VLC code');
    node = next;
  }
  throw new Error('CAVLC: VLC code too long');
}

// --- coeff_token tables (from FFmpeg h264_cavlc.c, verified against H.264 spec Table 9-5) ---
// Generated from len/bits arrays: code = bits.toString(2).padStart(len, '0')

function buildFromLenBits(len: number[], bits: number[], maxTc: number): VlcNode {
  const entries: Array<[string, number, number]> = [];
  for (let tc = 0; tc <= maxTc; tc++) {
    for (let to = 0; to <= Math.min(3, tc); to++) {
      const idx = tc * 4 + to;
      const l = len[idx];
      if (l === 0) continue;
      const code = bits[idx].toString(2).padStart(l, '0');
      entries.push([code, tc, to]);
    }
  }
  return buildTree(entries);
}

// VLC0 (nC 0-1)
const VLC0 = buildFromLenBits(
  [1,0,0,0, 6,2,0,0, 8,6,3,0, 9,8,7,5, 10,9,8,6, 11,10,9,7,
   13,11,10,8, 13,13,11,9, 13,13,13,10, 14,14,13,11, 14,14,14,13,
   15,15,14,14, 15,15,15,14, 16,15,15,15, 16,16,16,15, 16,16,16,16,
   16,16,16,16],
  [1,0,0,0, 5,1,0,0, 7,4,1,0, 7,6,5,3, 7,6,5,3, 7,6,5,4,
   15,6,5,4, 11,14,5,4, 8,10,13,4, 15,14,9,4, 11,10,13,12, 15,14,9,12,
   11,10,13,8, 15,1,9,12, 11,14,13,8, 7,10,9,12, 4,6,5,8],
  16
);

// VLC1 (nC 2-3)
const VLC1 = buildFromLenBits(
  [2,0,0,0, 6,2,0,0, 6,5,3,0, 7,6,6,4, 8,6,6,4, 8,7,7,5,
   9,8,8,6, 11,9,9,6, 11,11,11,7, 12,11,11,9, 12,12,12,11, 12,12,12,11,
   13,13,13,12, 13,13,13,13, 13,14,13,13, 14,14,14,13, 14,14,14,14],
  [3,0,0,0, 11,2,0,0, 7,7,3,0, 7,10,9,5, 7,6,5,4, 4,6,5,6,
   7,6,5,8, 15,6,5,4, 11,14,13,4, 15,10,9,4, 11,14,13,12, 8,10,9,8,
   15,14,13,12, 11,10,9,12, 7,11,6,8, 9,8,10,1, 7,6,5,4],
  16
);

// VLC2 (nC 4-7)
const VLC2 = buildFromLenBits(
  [4,0,0,0, 6,4,0,0, 6,5,4,0, 6,5,5,4, 7,5,5,4, 7,5,5,4,
   7,6,6,4, 7,6,6,4, 8,7,7,5, 8,8,7,6, 9,8,8,7, 9,9,8,8,
   9,9,9,8, 10,9,9,9, 10,10,10,10, 10,10,10,10, 10,10,10,10],
  [15,0,0,0, 15,14,0,0, 11,15,13,0, 8,12,14,12, 15,10,11,11, 11,8,9,10,
   9,14,13,9, 8,10,9,8, 15,14,13,13, 11,14,10,12, 15,10,13,12, 11,14,9,12,
   8,10,13,8, 13,7,9,12, 9,12,11,10, 5,8,7,6, 1,4,3,2],
  16
);

// Chroma DC (nC = -1, 4:2:0)
const CHROMA_DC = buildFromLenBits(
  [2,0,0,0, 6,1,0,0, 6,6,3,0, 6,7,7,6, 6,8,8,7],
  [1,0,0,0, 7,1,0,0, 4,6,1,0, 3,3,2,5, 2,3,2,0],
  4
);

function decodeCoeffToken(reader: BitReader, nC: number): [number, number] {
  if (nC >= 8) {
    const code = reader.readBits(6);
    const to = code & 3;
    const tc = code >> 2;
    return [tc, Math.min(to, tc)];
  }
  if (nC === -1) return decodeTree(reader, CHROMA_DC);
  if (nC < 2) return decodeTree(reader, VLC0);
  if (nC < 4) return decodeTree(reader, VLC1);
  return decodeTree(reader, VLC2);
}

// --- Level decoding ---

function decodeLevel(reader: BitReader, suffixLength: number): number {
  let prefix = 0;
  while (reader.readBit() === 0) prefix++;

  let suffLen = suffixLength;
  if (prefix === 14 && suffixLength === 0) suffLen = 4;
  else if (prefix >= 15) suffLen = prefix - 3;

  let levelCode: number;
  if (suffLen > 0) {
    const suffix = reader.readBits(suffLen);
    levelCode = (Math.min(15, prefix) << suffixLength) + suffix;
  } else {
    levelCode = prefix;
  }

  if (prefix >= 15 && suffixLength === 0) levelCode += 15;
  if (prefix >= 16) levelCode += (1 << (prefix - 3)) - 4096;

  if (levelCode % 2 === 0) return (levelCode + 2) >> 1;
  return -(levelCode + 1) >> 1;
}

// --- Total zeros tables (H.264 spec Table 9-7/9-8) ---

function tz(entries: Array<[string, number]>): VlcNode {
  return buildTree(entries.map(([c, v]) => [c, v, 0]));
}

const TOTAL_ZEROS: VlcNode[] = [
  null as any, // index 0 unused
  tz([['1',0],['011',1],['010',2],['0011',3],['0010',4],['00011',5],['00010',6],['000011',7],['000010',8],['0000011',9],['0000010',10],['00000011',11],['00000010',12],['000000011',13],['000000010',14],['000000001',15]]),
  tz([['111',0],['110',1],['101',2],['100',3],['011',4],['0101',5],['0100',6],['0011',7],['0010',8],['00011',9],['00010',10],['000011',11],['000010',12],['000001',13],['000000',14]]),
  tz([['0101',0],['111',1],['110',2],['101',3],['0100',4],['0011',5],['100',6],['0010',7],['0001',8],['00001',9],['00000',10],['000011',11],['000010',12],['000001',13]]),  // NOTE: last entry might need fixing
  tz([['00011',0],['111',1],['0101',2],['0100',3],['110',4],['101',5],['100',6],['0011',7],['0010',8],['00010',9],['00001',10],['00000',11],['011',12]]),
  tz([['0101',0],['0100',1],['0011',2],['111',3],['110',4],['101',5],['100',6],['0010',7],['0001',8],['00001',9],['00000',10],['011',11]]),
  tz([['000001',0],['00001',1],['111',2],['110',3],['101',4],['100',5],['011',6],['010',7],['0001',8],['001',9],['000000',10]]),
  tz([['000001',0],['00001',1],['101',2],['100',3],['011',4],['11',5],['010',6],['001',7],['0001',8],['000000',9]]),
  tz([['000001',0],['0001',1],['00001',2],['011',3],['11',4],['10',5],['010',6],['001',7],['000000',8]]),
  tz([['000001',0],['000000',1],['0001',2],['11',3],['10',4],['001',5],['01',6],['00001',7]]),
  tz([['00001',0],['00000',1],['001',2],['11',3],['10',4],['01',5],['0001',6]]),
  tz([['0000',0],['0001',1],['001',2],['010',3],['1',4],['011',5]]),
  tz([['0000',0],['0001',1],['01',2],['1',3],['001',4]]),
  tz([['000',0],['001',1],['1',2],['01',3]]),
  tz([['00',0],['01',1],['1',2]]),
  tz([['0',0],['1',1]]),
];

const TOTAL_ZEROS_CHROMA_DC: VlcNode[] = [
  null as any,
  tz([['1',0],['01',1],['001',2],['000',3]]),
  tz([['1',0],['01',1],['00',2]]),
  tz([['1',0],['0',1]]),
];

function decodeTotalZeros(reader: BitReader, totalCoeff: number, maxCoeff: number): number {
  if (maxCoeff === 4) {
    if (totalCoeff >= 4) return 0;
    return decodeTree(reader, TOTAL_ZEROS_CHROMA_DC[totalCoeff])[0];
  }
  if (totalCoeff >= maxCoeff) return 0;
  return decodeTree(reader, TOTAL_ZEROS[totalCoeff])[0];
}

// --- Run before tables (H.264 spec Table 9-10) ---

const RUN_BEFORE: VlcNode[] = [
  null as any,
  tz([['1',0],['0',1]]),
  tz([['1',0],['01',1],['00',2]]),
  tz([['11',0],['10',1],['01',2],['00',3]]),
  tz([['11',0],['10',1],['01',2],['001',3],['000',4]]),
  tz([['11',0],['10',1],['011',2],['010',3],['001',4],['000',5]]),
  tz([['11',0],['000',1],['001',2],['010',3],['011',4],['10',5],['0000',6]]),
];

function decodeRunBefore(reader: BitReader, zerosLeft: number): number {
  if (zerosLeft <= 0) return 0;
  if (zerosLeft <= 6) return decodeTree(reader, RUN_BEFORE[zerosLeft])[0];

  // zerosLeft >= 7: 3-bit prefix then extension
  const val = reader.readBits(3);
  if (val > 0) return 7 - val;
  let runBefore = 7;
  while (reader.readBit() === 0) runBefore++;
  return runBefore;
}

// --- Main CAVLC residual decoder ---

export function cavlcDecodeResidual(
  reader: BitReader,
  maxCoeff: number,
  nC: number,
): { coeffs: Int32Array; totalCoeff: number } {
  const [totalCoeff, trailingOnes] = decodeCoeffToken(reader, nC);

  const coeffs = new Int32Array(maxCoeff);
  if (totalCoeff === 0) return { coeffs, totalCoeff };

  // Trailing ones sign flags
  const levels = new Int32Array(totalCoeff);
  for (let i = totalCoeff - 1; i >= totalCoeff - trailingOnes; i--) {
    levels[i] = reader.readBit() === 0 ? 1 : -1;
  }

  // Remaining levels
  let suffixLength = totalCoeff > 10 && trailingOnes < 3 ? 1 : 0;
  for (let i = totalCoeff - trailingOnes - 1; i >= 0; i--) {
    levels[i] = decodeLevel(reader, suffixLength);

    // Adjust first non-trailing level by ±1
    if (i === totalCoeff - trailingOnes - 1 && trailingOnes < 3) {
      if (levels[i] > 0) levels[i]++;
      else levels[i]--;
    }

    // Update suffixLength
    if (suffixLength === 0) suffixLength = 1;
    if (Math.abs(levels[i]) > (3 << (suffixLength - 1)) && suffixLength < 6) {
      suffixLength++;
    }
  }

  // Total zeros
  let totalZeros = 0;
  if (totalCoeff < maxCoeff) {
    totalZeros = decodeTotalZeros(reader, totalCoeff, maxCoeff);
  }

  // Run before
  const runs = new Int32Array(totalCoeff);
  let zerosLeft = totalZeros;
  for (let i = totalCoeff - 1; i > 0 && zerosLeft > 0; i--) {
    const rb = decodeRunBefore(reader, zerosLeft);
    runs[i] = rb;
    zerosLeft -= rb;
  }
  runs[0] = zerosLeft;

  // Place coefficients
  let pos = 0;
  for (let i = totalCoeff - 1; i >= 0; i--) {
    pos += runs[i];
    if (pos < maxCoeff) coeffs[pos] = levels[i];
    pos++;
  }

  return { coeffs, totalCoeff };
}
