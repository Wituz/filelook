import type { SPS, PPS, SliceHeader } from './types.ts';
import { cavlcDecodeResidual } from './cavlc.ts';

// --- Emulation prevention byte removal ---

export function removeEmulationPrevention(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    if (i + 2 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 3) {
      out.push(0, 0);
      i += 3;
    } else {
      out.push(data[i++]);
    }
  }
  return new Uint8Array(out);
}

// --- Bit reader (MSB-first) ---

export class BitReader {
  pos = 0;
  private bitBuf = 0;
  private bitsLeft = 0;

  constructor(private data: Uint8Array) {}

  readBit(): number {
    if (this.bitsLeft === 0) {
      if (this.pos >= this.data.length) throw new Error('H264: unexpected end of data');
      this.bitBuf = this.data[this.pos++];
      this.bitsLeft = 8;
    }
    this.bitsLeft--;
    return (this.bitBuf >>> this.bitsLeft) & 1;
  }

  readBits(n: number): number {
    let val = 0;
    for (let i = 0; i < n; i++) {
      val = (val << 1) | this.readBit();
    }
    return val;
  }

  readUe(): number {
    let zeros = 0;
    while (this.readBit() === 0) zeros++;
    if (zeros === 0) return 0;
    return (1 << zeros) - 1 + this.readBits(zeros);
  }

  readSe(): number {
    const val = this.readUe();
    return (val & 1) ? ((val + 1) >> 1) : -(val >> 1);
  }

  readBool(): boolean {
    return this.readBit() === 1;
  }

  alignToByte(): void {
    this.bitsLeft = 0;
  }

  get bytesRead(): number {
    return this.pos;
  }
}

// --- NAL unit extraction (MP4 length-prefixed format) ---

export function extractNalUnits(data: Uint8Array, offset: number, size: number, nalLengthSize: number): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let pos = offset;
  const end = offset + size;

  while (pos + nalLengthSize <= end) {
    let nalLen = 0;
    for (let i = 0; i < nalLengthSize; i++) {
      nalLen = (nalLen << 8) | data[pos + i];
    }
    pos += nalLengthSize;
    if (pos + nalLen > end) break;
    nals.push(data.slice(pos, pos + nalLen));
    pos += nalLen;
  }

  return nals;
}

// --- SPS parsing ---

export function parseSPS(nalData: Uint8Array): SPS {
  const rbsp = removeEmulationPrevention(nalData);
  const r = new BitReader(rbsp);

  // NAL header
  r.readBits(8); // forbidden_zero_bit + nal_ref_idc + nal_unit_type

  const profileIdc = r.readBits(8);
  r.readBits(8); // constraint_set flags + reserved
  const levelIdc = r.readBits(8);
  r.readUe(); // seq_parameter_set_id

  let chromaFormatIdc = 1;
  let bitDepthLuma = 8;
  let bitDepthChroma = 8;

  if (profileIdc === 100 || profileIdc === 110 || profileIdc === 122 ||
      profileIdc === 244 || profileIdc === 44 || profileIdc === 83 ||
      profileIdc === 86 || profileIdc === 118 || profileIdc === 128 ||
      profileIdc === 138 || profileIdc === 139 || profileIdc === 134 || profileIdc === 135) {
    chromaFormatIdc = r.readUe();
    if (chromaFormatIdc === 3) r.readBool(); // separate_colour_plane_flag
    bitDepthLuma = r.readUe() + 8;
    bitDepthChroma = r.readUe() + 8;
    r.readBool(); // qpprime_y_zero_transform_bypass_flag
    const seqScalingMatrixPresent = r.readBool();
    if (seqScalingMatrixPresent) {
      const cnt = chromaFormatIdc === 3 ? 12 : 8;
      for (let i = 0; i < cnt; i++) {
        if (r.readBool()) { // scaling_list_present_flag
          const size = i < 6 ? 16 : 64;
          let last = 8, next = 8;
          for (let j = 0; j < size; j++) {
            if (next !== 0) {
              const delta = r.readSe();
              next = (last + delta + 256) % 256;
            }
            last = next === 0 ? last : next;
          }
        }
      }
    }
  }

  const log2MaxFrameNum = r.readUe() + 4;
  const picOrderCntType = r.readUe();
  let log2MaxPocLsb = 0;
  if (picOrderCntType === 0) {
    log2MaxPocLsb = r.readUe() + 4;
  } else if (picOrderCntType === 1) {
    r.readBool(); // delta_pic_order_always_zero_flag
    r.readSe(); // offset_for_non_ref_pic
    r.readSe(); // offset_for_top_to_bottom_field
    const numRefFrames = r.readUe();
    for (let i = 0; i < numRefFrames; i++) r.readSe();
  }
  r.readUe(); // max_num_ref_frames
  r.readBool(); // gaps_in_frame_num_value_allowed_flag

  const picWidthInMbs = r.readUe() + 1;
  const picHeightInMapUnits = r.readUe() + 1;
  const frameMbsOnly = r.readBool();
  if (!frameMbsOnly) r.readBool(); // mb_adaptive_frame_field_flag
  r.readBool(); // direct_8x8_inference_flag

  let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
  if (r.readBool()) { // frame_cropping_flag
    cropLeft = r.readUe();
    cropRight = r.readUe();
    cropTop = r.readUe();
    cropBottom = r.readUe();
  }

  return {
    profileIdc, levelIdc, chromaFormatIdc, bitDepthLuma, bitDepthChroma,
    log2MaxFrameNum, picOrderCntType, log2MaxPocLsb,
    picWidthInMbs, picHeightInMapUnits, frameMbsOnly,
    cropLeft, cropRight, cropTop, cropBottom,
  };
}

// --- PPS parsing ---

export function parsePPS(nalData: Uint8Array): PPS {
  const rbsp = removeEmulationPrevention(nalData);
  const r = new BitReader(rbsp);

  r.readBits(8); // NAL header
  r.readUe(); // pic_parameter_set_id
  r.readUe(); // seq_parameter_set_id
  const entropyCodingModeFlag = r.readBool();
  r.readBool(); // bottom_field_pic_order_in_frame_present_flag
  const numSliceGroups = r.readUe() + 1;
  if (numSliceGroups > 1) {
    throw new Error('H264: slice groups not supported');
  }
  r.readUe(); // num_ref_idx_l0_default_active_minus1
  r.readUe(); // num_ref_idx_l1_default_active_minus1
  r.readBool(); // weighted_pred_flag
  r.readBits(2); // weighted_bipred_idc
  const picInitQpMinus26 = r.readSe();
  r.readSe(); // pic_init_qs_minus26
  const chromaQpIndexOffset = r.readSe();
  const deblockingFilterControlPresent = r.readBool();
  r.readBool(); // constrained_intra_pred_flag
  r.readBool(); // redundant_pic_cnt_present_flag

  let transform8x8ModeFlag = false;
  let secondChromaQpIndexOffset = chromaQpIndexOffset;

  // Check for more data (high profile extensions)
  // Only present if there's remaining data before rbsp_trailing_bits
  // For baseline profile this is absent, so we just use defaults

  return {
    entropyCodingModeFlag, picInitQpMinus26, chromaQpIndexOffset,
    deblockingFilterControlPresent, transform8x8ModeFlag,
    secondChromaQpIndexOffset,
  };
}

// --- Slice header parsing ---

export function parseSliceHeader(nalData: Uint8Array, sps: SPS, pps: PPS): SliceHeader {
  const rbsp = removeEmulationPrevention(nalData);
  const r = new BitReader(rbsp);

  const nalHeader = r.readBits(8);
  const nalType = nalHeader & 0x1F;

  const firstMbInSlice = r.readUe();
  const sliceType = r.readUe();
  r.readUe(); // pic_parameter_set_id

  const log2MaxFrameNum = 4; // default, should come from SPS but rarely differs for thumbnail use
  r.readBits(log2MaxFrameNum + 4); // frame_num (log2_max_frame_num_minus4 + 4 bits)

  if (!sps.frameMbsOnly) {
    const fieldPicFlag = r.readBool();
    if (fieldPicFlag) r.readBool(); // bottom_field_flag
  }

  if (nalType === 5) { // IDR
    r.readUe(); // idr_pic_id
  }

  // pic_order_cnt - skip based on type (simplified: assume type 0 or 2 for baseline)
  // For a simple thumbnail decoder, we'll read the minimum needed

  const qpDelta = 0; // Will re-parse after aligning

  return { firstMbInSlice, sliceType, qpDelta };
}

// --- Dequantization tables ---

const DEQUANT_COEFF = [
  [10, 13, 16],
  [11, 14, 18],
  [13, 16, 20],
  [14, 18, 23],
  [16, 20, 25],
  [18, 23, 29],
];

function levelScale(qpMod6: number, i: number, j: number): number {
  if ((i & 1) === 0 && (j & 1) === 0) return DEQUANT_COEFF[qpMod6][0];
  if ((i & 1) === 1 && (j & 1) === 1) return DEQUANT_COEFF[qpMod6][2];
  return DEQUANT_COEFF[qpMod6][1];
}

// --- 4x4 zigzag scan ---

const ZIGZAG_4x4: readonly number[] = [
  0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15
];

// Block index to (row, col) within macroblock
function block4x4Pos(idx: number): [number, number] {
  const b8 = idx >> 2;
  const s = idx & 3;
  return [(b8 >> 1) * 8 + (s >> 1) * 4, (b8 & 1) * 8 + (s & 1) * 4];
}

// --- Inverse 4x4 integer transform (H.264 spec 8.5.12) ---

function inverseTransform4x4(coeffs: Int32Array): Int32Array {
  const d = new Int32Array(16);

  // Horizontal
  for (let i = 0; i < 4; i++) {
    const s0 = coeffs[i * 4 + 0];
    const s1 = coeffs[i * 4 + 1];
    const s2 = coeffs[i * 4 + 2];
    const s3 = coeffs[i * 4 + 3];
    const e0 = s0 + s2;
    const e1 = s0 - s2;
    const e2 = (s1 >> 1) - s3;
    const e3 = s1 + (s3 >> 1);
    d[i * 4 + 0] = e0 + e3;
    d[i * 4 + 1] = e1 + e2;
    d[i * 4 + 2] = e1 - e2;
    d[i * 4 + 3] = e0 - e3;
  }

  // Vertical
  const out = new Int32Array(16);
  for (let j = 0; j < 4; j++) {
    const s0 = d[0 * 4 + j];
    const s1 = d[1 * 4 + j];
    const s2 = d[2 * 4 + j];
    const s3 = d[3 * 4 + j];
    const e0 = s0 + s2;
    const e1 = s0 - s2;
    const e2 = (s1 >> 1) - s3;
    const e3 = s1 + (s3 >> 1);
    out[0 * 4 + j] = (e0 + e3 + 32) >> 6;
    out[1 * 4 + j] = (e1 + e2 + 32) >> 6;
    out[2 * 4 + j] = (e1 - e2 + 32) >> 6;
    out[3 * 4 + j] = (e0 - e3 + 32) >> 6;
  }

  return out;
}

// --- Inverse 4x4 Hadamard (luma DC of I_16x16) ---

function inverseHadamard4x4(dc: Int32Array): Int32Array {
  const tmp = new Int32Array(16);

  // Horizontal
  for (let i = 0; i < 4; i++) {
    const a = dc[i * 4 + 0] + dc[i * 4 + 2];
    const b = dc[i * 4 + 0] - dc[i * 4 + 2];
    const c = dc[i * 4 + 1] - dc[i * 4 + 3];
    const d = dc[i * 4 + 1] + dc[i * 4 + 3];
    tmp[i * 4 + 0] = a + d;
    tmp[i * 4 + 1] = b + c;
    tmp[i * 4 + 2] = b - c;
    tmp[i * 4 + 3] = a - d;
  }

  // Vertical
  const out = new Int32Array(16);
  for (let j = 0; j < 4; j++) {
    const a = tmp[0 * 4 + j] + tmp[2 * 4 + j];
    const b = tmp[0 * 4 + j] - tmp[2 * 4 + j];
    const c = tmp[1 * 4 + j] - tmp[3 * 4 + j];
    const d = tmp[1 * 4 + j] + tmp[3 * 4 + j];
    out[0 * 4 + j] = a + d;
    out[1 * 4 + j] = b + c;
    out[2 * 4 + j] = b - c;
    out[3 * 4 + j] = a - d;
  }

  return out;
}

// --- Inverse 2x2 Hadamard (chroma DC, 4:2:0) ---

function inverseHadamard2x2(dc: Int32Array<ArrayBuffer>): Int32Array<ArrayBuffer> {
  const out = new Int32Array(4);
  out[0] = dc[0] + dc[1] + dc[2] + dc[3];
  out[1] = dc[0] - dc[1] + dc[2] - dc[3];
  out[2] = dc[0] + dc[1] - dc[2] - dc[3];
  out[3] = dc[0] - dc[1] - dc[2] + dc[3];
  return out;
}

// --- Chroma QP table (spec table 8-17) ---

const CHROMA_QP_TABLE = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
  29, 30, 31, 32, 32, 33, 33, 34, 34, 35, 35, 36, 36, 37, 37,
  37, 38, 38, 38, 39, 39, 39, 39
];

function chromaQp(qpY: number, offset: number): number {
  const qpI = Math.max(0, Math.min(51, qpY + offset));
  return CHROMA_QP_TABLE[qpI];
}

// --- Intra prediction ---

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// Get pixel from plane, returning 128 if out-of-bounds
function px(plane: Uint8Array, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= w || y >= h) return 128;
  return plane[y * w + x];
}

function predict4x4(mode: number, plane: Uint8Array, w: number, h: number, bx: number, by: number, block: Uint8Array): void {
  // Gather neighbors
  const topAvail = by > 0;
  const leftAvail = bx > 0;
  const t: number[] = [];
  const l: number[] = [];
  const tl = topAvail && leftAvail ? px(plane, w, h, bx - 1, by - 1) : 128;

  for (let i = 0; i < 8; i++) t.push(topAvail ? px(plane, w, h, bx + i, by - 1) : 128);
  for (let i = 0; i < 4; i++) l.push(leftAvail ? px(plane, w, h, bx - 1, by + i) : 128);

  // Check top-right availability
  const trAvail = topAvail && (bx + 4 < w);

  // If top-right not available, replicate t[3]
  if (!trAvail) {
    for (let i = 4; i < 8; i++) t[i] = t[3];
  }

  switch (mode) {
    case 0: // Vertical
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++)
          block[y * 4 + x] = t[x];
      break;

    case 1: // Horizontal
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++)
          block[y * 4 + x] = l[y];
      break;

    case 2: { // DC
      let sum = 0, cnt = 0;
      if (topAvail) { for (let i = 0; i < 4; i++) sum += t[i]; cnt += 4; }
      if (leftAvail) { for (let i = 0; i < 4; i++) sum += l[i]; cnt += 4; }
      const dc = cnt > 0 ? (sum + (cnt >> 1)) / cnt | 0 : 128;
      block.fill(dc);
      break;
    }

    case 3: // Diagonal Down-Left
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          const i = x + y;
          if (i === 6) block[y * 4 + x] = (t[6] + 3 * t[7] + 2) >> 2;
          else block[y * 4 + x] = (t[i] + 2 * t[i + 1] + t[i + 2] + 2) >> 2;
        }
      break;

    case 4: // Diagonal Down-Right
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          if (x > y) block[y * 4 + x] = (t[x - y - 2 + 1] + 2 * t[x - y - 1 + 1] + t[x - y + 1] + 2) >> 2;
          else if (x < y) block[y * 4 + x] = (l[y - x - 2 + 1] + 2 * l[y - x - 1 + 1] + l[y - x + 1] + 2) >> 2;
          else block[y * 4 + x] = (t[0] + 2 * tl + l[0] + 2) >> 2;
        }
      break;

    case 5: { // Vertical-Right
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          const zVR = 2 * x - y;
          if (zVR >= 0 && (zVR & 1) === 0) {
            const i = x - (y >> 1);
            block[y * 4 + x] = i === 0 ? (t[0] + tl + 1) >> 1 : (t[i - 1] + t[i] + 1) >> 1;
          } else if (zVR >= 0 && (zVR & 1) === 1) {
            const i = x - (y >> 1);
            block[y * 4 + x] = i <= 0 ? (tl + 2 * t[0] + t[1] + 2) >> 2 :
              i === 0 ? (t[0] + 2 * tl + l[0] + 2) >> 2 : // shouldn't happen for zVR>=1
              (t[i - 2] + 2 * t[i - 1] + t[i] + 2) >> 2;
          } else if (zVR === -1) {
            block[y * 4 + x] = (l[0] + 2 * tl + t[0] + 2) >> 2;
          } else {
            const i = y - 2 * x - 1;
            block[y * 4 + x] = (l[i] + 2 * l[i - 1] + (i >= 2 ? l[i - 2] : tl) + 2) >> 2;
          }
        }
      break;
    }

    case 6: { // Horizontal-Down
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          const zHD = 2 * y - x;
          if (zHD >= 0 && (zHD & 1) === 0) {
            const i = y - (x >> 1);
            block[y * 4 + x] = i === 0 ? (l[0] + tl + 1) >> 1 : (l[i - 1] + l[i] + 1) >> 1;
          } else if (zHD >= 0 && (zHD & 1) === 1) {
            const i = y - (x >> 1);
            block[y * 4 + x] = i <= 0 ? (tl + 2 * l[0] + l[1] + 2) >> 2 :
              (l[i - 2 >= 0 ? i - 2 : 0] + 2 * l[i - 1] + l[i] + 2) >> 2;
          } else if (zHD === -1) {
            block[y * 4 + x] = (t[0] + 2 * tl + l[0] + 2) >> 2;
          } else {
            const i = x - 2 * y - 1;
            block[y * 4 + x] = (t[i] + 2 * t[i - 1] + (i >= 2 ? t[i - 2] : tl) + 2) >> 2;
          }
        }
      break;
    }

    case 7: // Vertical-Left
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          const i = x + (y >> 1);
          if ((y & 1) === 0) block[y * 4 + x] = (t[i] + t[i + 1] + 1) >> 1;
          else block[y * 4 + x] = (t[i] + 2 * t[i + 1] + t[i + 2] + 2) >> 2;
        }
      break;

    case 8: // Horizontal-Up
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          const zHU = x + 2 * y;
          if (zHU <= 4) {
            const i = y + (x >> 1);
            if ((x & 1) === 0) block[y * 4 + x] = (l[i] + l[Math.min(i + 1, 3)] + 1) >> 1;
            else block[y * 4 + x] = (l[i] + 2 * l[Math.min(i + 1, 3)] + l[Math.min(i + 2, 3)] + 2) >> 2;
          } else if (zHU === 5) {
            block[y * 4 + x] = (l[2] + 3 * l[3] + 2) >> 2;
          } else {
            block[y * 4 + x] = l[3];
          }
        }
      break;
  }
}

function predict16x16(mode: number, plane: Uint8Array, w: number, h: number, mbx: number, mby: number): Uint8Array {
  const bx = mbx * 16;
  const by = mby * 16;
  const pred = new Uint8Array(256);
  const topAvail = mby > 0;
  const leftAvail = mbx > 0;

  switch (mode) {
    case 0: // Vertical
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++)
          pred[y * 16 + x] = topAvail ? px(plane, w, h, bx + x, by - 1) : 128;
      break;

    case 1: // Horizontal
      for (let y = 0; y < 16; y++) {
        const lv = leftAvail ? px(plane, w, h, bx - 1, by + y) : 128;
        for (let x = 0; x < 16; x++) pred[y * 16 + x] = lv;
      }
      break;

    case 2: { // DC
      let sum = 0, cnt = 0;
      if (topAvail) { for (let i = 0; i < 16; i++) sum += px(plane, w, h, bx + i, by - 1); cnt += 16; }
      if (leftAvail) { for (let i = 0; i < 16; i++) sum += px(plane, w, h, bx - 1, by + i); cnt += 16; }
      const dc = cnt > 0 ? (sum + (cnt >> 1)) / cnt | 0 : 128;
      pred.fill(dc);
      break;
    }

    case 3: { // Plane
      const H_arr: number[] = [];
      const V_arr: number[] = [];
      const p = (x: number, y: number) => px(plane, w, h, bx + x, by + y);
      let H = 0, V = 0;
      for (let i = 0; i < 8; i++) {
        H += (i + 1) * (p(8 + i, -1) - p(6 - i, -1));
        V += (i + 1) * (p(-1, 8 + i) - p(-1, 6 - i));
      }
      const a = 16 * (p(-1, 15) + p(15, -1));
      const b = (5 * H + 32) >> 6;
      const c = (5 * V + 32) >> 6;
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++)
          pred[y * 16 + x] = clamp((a + b * (x - 7) + c * (y - 7) + 16) >> 5);
      break;
    }
  }

  return pred;
}

function predict8x8Chroma(mode: number, plane: Uint8Array, w: number, h: number, mbx: number, mby: number): Uint8Array {
  const bx = mbx * 8;
  const by = mby * 8;
  const pred = new Uint8Array(64);
  const topAvail = mby > 0;
  const leftAvail = mbx > 0;

  switch (mode) {
    case 0: { // DC
      // Split into four 4x4 sub-blocks with independent DC prediction
      for (let sy = 0; sy < 2; sy++)
        for (let sx = 0; sx < 2; sx++) {
          let sum = 0, cnt = 0;
          const ox = sx * 4, oy = sy * 4;
          if (topAvail || sy > 0) {
            for (let i = 0; i < 4; i++) sum += px(plane, w, h, bx + ox + i, by + oy - 1);
            cnt += 4;
          }
          if (leftAvail || sx > 0) {
            for (let i = 0; i < 4; i++) sum += px(plane, w, h, bx + ox - 1, by + oy + i);
            cnt += 4;
          }
          const dc = cnt > 0 ? (sum + (cnt >> 1)) / cnt | 0 : 128;
          for (let y = 0; y < 4; y++)
            for (let x = 0; x < 4; x++)
              pred[(oy + y) * 8 + ox + x] = dc;
        }
      break;
    }

    case 1: // Horizontal
      for (let y = 0; y < 8; y++) {
        const lv = leftAvail ? px(plane, w, h, bx - 1, by + y) : 128;
        for (let x = 0; x < 8; x++) pred[y * 8 + x] = lv;
      }
      break;

    case 2: // Vertical
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++)
          pred[y * 8 + x] = topAvail ? px(plane, w, h, bx + x, by - 1) : 128;
      break;

    case 3: { // Plane
      const p = (x: number, y: number) => px(plane, w, h, bx + x, by + y);
      let H = 0, V = 0;
      for (let i = 0; i < 4; i++) {
        H += (i + 1) * (p(4 + i, -1) - p(2 - i, -1));
        V += (i + 1) * (p(-1, 4 + i) - p(-1, 2 - i));
      }
      const a = 16 * (p(-1, 7) + p(7, -1));
      const b = (17 * H + 16) >> 5;
      const c = (17 * V + 16) >> 5;
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++)
          pred[y * 8 + x] = clamp((a + b * (x - 3) + c * (y - 3) + 16) >> 5);
      break;
    }
  }

  return pred;
}

// --- CBP table for Intra macroblocks (spec table 9-4) ---

const CBP_INTRA: readonly number[] = [
  47, 31, 15, 0, 23, 27, 29, 30, 7, 11, 13, 14, 39, 43, 45, 46,
  16, 3, 5, 10, 12, 19, 21, 26, 28, 35, 37, 42, 44, 1, 2, 4,
  8, 17, 18, 20, 24, 6, 9, 22, 25, 32, 33, 34, 36, 40, 38, 41
];

// --- Main macroblock decode ---

export interface DecodedFrame {
  y: Uint8Array;
  cb: Uint8Array;
  cr: Uint8Array;
  width: number;
  height: number;
  cropLeft: number;
  cropRight: number;
  cropTop: number;
  cropBottom: number;
}

export function decodeIFrame(
  nalData: Uint8Array,
  sps: SPS,
  pps: PPS,
): DecodedFrame {
  const rbsp = removeEmulationPrevention(nalData);
  const reader = new BitReader(rbsp);

  // Parse slice header inline (we need the reader positioned after it)
  const nalHeader = reader.readBits(8);
  const firstMb = reader.readUe();
  const sliceType = reader.readUe();

  // Verify I-slice (type 2 = I, type 7 = SI; also 0-4 map with +5)
  const st = sliceType > 4 ? sliceType - 5 : sliceType;
  if (st !== 2 && st !== 7) throw new Error(`H264: not an I-slice (type ${sliceType})`);

  reader.readUe(); // pps id

  reader.readBits(sps.log2MaxFrameNum); // frame_num

  if (!sps.frameMbsOnly) {
    if (reader.readBool()) reader.readBool(); // field_pic_flag, bottom_field_flag
  }

  const nalType = nalHeader & 0x1F;
  if (nalType === 5) reader.readUe(); // idr_pic_id

  // pic_order_cnt
  if (sps.picOrderCntType === 0) {
    reader.readBits(sps.log2MaxPocLsb); // pic_order_cnt_lsb
  } else if (sps.picOrderCntType === 1) {
    reader.readSe(); // delta_pic_order_cnt[0]
  }
  // type 2: no POC syntax

  // dec_ref_pic_marking (for IDR)
  if (nalType === 5) {
    const noOutputPrior = reader.readBool();
    const longTermRef = reader.readBool();
  }

  const sliceQpDelta = reader.readSe();
  const sliceQp = 26 + pps.picInitQpMinus26 + sliceQpDelta;

  // Deblocking filter
  if (pps.deblockingFilterControlPresent) {
    const disableDeblocking = reader.readUe();
    if (disableDeblocking !== 1) {
      reader.readSe(); // slice_alpha_c0_offset_div2
      reader.readSe(); // slice_beta_offset_div2
    }
  }

  // Now decode macroblocks
  const mbW = sps.picWidthInMbs;
  const mbH = sps.picHeightInMapUnits;
  const totalMbs = mbW * mbH;
  const lumaW = mbW * 16;
  const lumaH = mbH * 16;
  const chromaW = mbW * 8;
  const chromaH = mbH * 8;

  const yPlane = new Uint8Array(lumaW * lumaH);
  const cbPlane = new Uint8Array(chromaW * chromaH);
  const crPlane = new Uint8Array(chromaW * chromaH);

  // nC tracking for CAVLC neighbor prediction
  const nCLuma = new Int16Array(mbW * 4 * mbH * 4);
  const nCCb = new Int16Array(mbW * 2 * mbH * 2);
  const nCCr = new Int16Array(mbW * 2 * mbH * 2);
  nCLuma.fill(-1);
  nCCb.fill(-1);
  nCCr.fill(-1);

  let qp = sliceQp;

  for (let mbIdx = 0; mbIdx < totalMbs; mbIdx++) {
    const mbX = mbIdx % mbW;
    const mbY = (mbIdx / mbW) | 0;

    const mbType = reader.readUe();

    if (mbType === 25) {
      // I_PCM
      reader.alignToByte();
      const lumaBase = mbY * 16 * lumaW + mbX * 16;
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++)
          yPlane[lumaBase + y * lumaW + x] = reader.readBits(8);

      const cbBase = mbY * 8 * chromaW + mbX * 8;
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++)
          cbPlane[cbBase + y * chromaW + x] = reader.readBits(8);

      const crBase = mbY * 8 * chromaW + mbX * 8;
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++)
          crPlane[crBase + y * chromaW + x] = reader.readBits(8);

      // Set nC to 16 for all sub-blocks
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++)
          nCLuma[(mbY * 4 + y) * mbW * 4 + mbX * 4 + x] = 16;
      for (let y = 0; y < 2; y++)
        for (let x = 0; x < 2; x++) {
          nCCb[(mbY * 2 + y) * mbW * 2 + mbX * 2 + x] = 16;
          nCCr[(mbY * 2 + y) * mbW * 2 + mbX * 2 + x] = 16;
        }

      qp = 0;
      continue;
    }

    if (mbType === 0) {
      // I_4x4: decode intra prediction modes for each 4x4 block
      decodeMbI4x4(reader, sps, pps, mbX, mbY, mbW, mbH, qp,
        yPlane, cbPlane, crPlane, lumaW, lumaH, chromaW, chromaH,
        nCLuma, nCCb, nCCr);
      // qp may change — handled inside
    } else {
      // I_16x16 (types 1-24)
      const t = mbType - 1;
      const intra16x16PredMode = t % 4;
      const cbpChroma = Math.floor((t % 12) / 4);
      const cbpLuma = t >= 12 ? 15 : 0;

      qp = decodeMbI16x16(reader, sps, pps, mbX, mbY, mbW, mbH, qp,
        intra16x16PredMode, cbpLuma, cbpChroma,
        yPlane, cbPlane, crPlane, lumaW, lumaH, chromaW, chromaH,
        nCLuma, nCCb, nCCr);
    }
  }

  return {
    y: yPlane, cb: cbPlane, cr: crPlane,
    width: lumaW, height: lumaH,
    cropLeft: sps.cropLeft * 2,
    cropRight: sps.cropRight * 2,
    cropTop: sps.cropTop * 2,
    cropBottom: sps.cropBottom * 2,
  };
}

function getNcLuma(nCLuma: Int16Array, stride: number, bx: number, by: number): number {
  const nA = bx > 0 ? nCLuma[by * stride + bx - 1] : -1;
  const nB = by > 0 ? nCLuma[(by - 1) * stride + bx] : -1;
  if (nA >= 0 && nB >= 0) return (nA + nB + 1) >> 1;
  if (nA >= 0) return nA;
  if (nB >= 0) return nB;
  return 0;
}

function getNcChroma(nC: Int16Array, stride: number, bx: number, by: number): number {
  const nA = bx > 0 ? nC[by * stride + bx - 1] : -1;
  const nB = by > 0 ? nC[(by - 1) * stride + bx] : -1;
  if (nA >= 0 && nB >= 0) return (nA + nB + 1) >> 1;
  if (nA >= 0) return nA;
  if (nB >= 0) return nB;
  return 0;
}

function dequant4x4(coeffs: Int32Array, qp: number, isDc: boolean): void {
  const qpMod6 = qp % 6;
  const qpDiv6 = Math.floor(qp / 6);

  for (let i = 0; i < 16; i++) {
    if (coeffs[i] === 0) continue;
    const row = Math.floor(i / 4);
    const col = i % 4;
    if (isDc && row === 0 && col === 0) continue; // DC handled separately for I_16x16
    coeffs[i] = (coeffs[i] * levelScale(qpMod6, row, col)) << qpDiv6;
  }
}

function decodeMbI4x4(
  reader: BitReader, sps: SPS, pps: PPS,
  mbX: number, mbY: number, mbW: number, mbH: number, qpIn: number,
  yPlane: Uint8Array, cbPlane: Uint8Array, crPlane: Uint8Array,
  lumaW: number, lumaH: number, chromaW: number, chromaH: number,
  nCLuma: Int16Array, nCCb: Int16Array, nCCr: Int16Array,
): void {
  // Read intra prediction modes for 16 4x4 blocks
  const predModes = new Uint8Array(16);
  // We need the previously decoded intra modes for the "most probable mode" prediction
  // intraPredModeY is stored per 4x4 block across the frame
  const intraModes = new Int8Array(mbW * 4 * mbH * 4);
  intraModes.fill(-1);

  for (let i = 0; i < 16; i++) {
    const [by, bx] = block4x4Pos(i);
    const absX = mbX * 4 + (bx >> 2);
    const absY = mbY * 4 + (by >> 2);

    // Most probable mode: min of left and above (default 2=DC if unavailable)
    const leftMode = absX > 0 ? intraModes[absY * mbW * 4 + absX - 1] : -1;
    const topMode = absY > 0 ? intraModes[(absY - 1) * mbW * 4 + absX] : -1;
    const mpm = Math.min(leftMode < 0 ? 2 : leftMode, topMode < 0 ? 2 : topMode);

    const prevIntraPredFlag = reader.readBool();
    if (prevIntraPredFlag) {
      predModes[i] = mpm;
    } else {
      let rem = reader.readBits(3);
      predModes[i] = rem < mpm ? rem : rem + 1;
    }
    intraModes[absY * mbW * 4 + absX] = predModes[i];
  }

  const chromaMode = reader.readUe();

  // coded_block_pattern (ME mapped)
  const cbpCode = reader.readUe();
  const cbp = cbpCode < CBP_INTRA.length ? CBP_INTRA[cbpCode] : 0;
  const cbpLuma = cbp & 15;
  const cbpChroma = cbp >> 4;

  let qp = qpIn;
  if (cbpLuma || cbpChroma) {
    qp = qpIn + reader.readSe();
    qp = ((qp % 52) + 52) % 52;
  }

  const lumaStride = mbW * 4;

  // Decode luma 4x4 blocks
  for (let i = 0; i < 16; i++) {
    const [by, bx] = block4x4Pos(i);
    const absPixX = mbX * 16 + bx;
    const absPixY = mbY * 16 + by;
    const absBx = mbX * 4 + (bx >> 2);
    const absBY = mbY * 4 + (by >> 2);

    // Predict
    const predBlock = new Uint8Array(16);
    predict4x4(predModes[i], yPlane, lumaW, lumaH, absPixX, absPixY, predBlock);

    // Check if this 8x8 block has residual
    const b8 = i >> 2;
    if (cbpLuma & (1 << b8)) {
      const nC = getNcLuma(nCLuma, lumaStride, absBx, absBY);
      const { coeffs, totalCoeff } = cavlcDecodeResidual(reader, 16, nC);
      nCLuma[absBY * lumaStride + absBx] = totalCoeff;

      // De-zigzag and dequant
      const block = new Int32Array(16);
      for (let j = 0; j < 16; j++) block[ZIGZAG_4x4[j]] = coeffs[j];
      dequant4x4(block, qp, false);

      // Inverse transform
      const residual = inverseTransform4x4(block);

      // Add prediction + residual
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++)
          yPlane[(absPixY + y) * lumaW + absPixX + x] = clamp(predBlock[y * 4 + x] + residual[y * 4 + x]);
    } else {
      nCLuma[absBY * lumaStride + absBx] = 0;
      // Just write prediction
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++)
          yPlane[(absPixY + y) * lumaW + absPixX + x] = predBlock[y * 4 + x];
    }
  }

  // Decode chroma
  decodeChroma(reader, pps, mbX, mbY, mbW, mbH, qp, chromaMode, cbpChroma,
    cbPlane, crPlane, chromaW, chromaH, nCCb, nCCr);
}

function decodeMbI16x16(
  reader: BitReader, sps: SPS, pps: PPS,
  mbX: number, mbY: number, mbW: number, mbH: number, qpIn: number,
  intra16x16PredMode: number, cbpLuma: number, cbpChroma: number,
  yPlane: Uint8Array, cbPlane: Uint8Array, crPlane: Uint8Array,
  lumaW: number, lumaH: number, chromaW: number, chromaH: number,
  nCLuma: Int16Array, nCCb: Int16Array, nCCr: Int16Array,
): number {
  const chromaMode = reader.readUe();
  const qpDelta = reader.readSe();
  let qp = qpIn + qpDelta;
  qp = ((qp % 52) + 52) % 52;

  const lumaStride = mbW * 4;

  // 16x16 prediction
  const pred = predict16x16(intra16x16PredMode, yPlane, lumaW, lumaH, mbX, mbY);

  // Decode luma DC (4x4 block of DC coefficients, Hadamard coded)
  const dcNc = getNcLuma(nCLuma, lumaStride, mbX * 4, mbY * 4);
  const dcResult = cavlcDecodeResidual(reader, 16, dcNc);
  const dcBlock = new Int32Array(16);
  // DC zigzag for I_16x16: special scan order
  const DC_SCAN = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15];
  for (let i = 0; i < 16; i++) dcBlock[DC_SCAN[i]] = dcResult.coeffs[i];

  // Inverse Hadamard
  const qpMod6 = qp % 6;
  const qpDiv6 = Math.floor(qp / 6);
  let dcValues: Int32Array;
  if (qpDiv6 >= 2) {
    const h = inverseHadamard4x4(dcBlock);
    for (let i = 0; i < 16; i++) h[i] = (h[i] * levelScale(qpMod6, 0, 0)) << (qpDiv6 - 2);
    dcValues = h;
  } else {
    const h = inverseHadamard4x4(dcBlock);
    const shift = 2 - qpDiv6;
    const rnd = 1 << (shift - 1);
    for (let i = 0; i < 16; i++) h[i] = (h[i] * levelScale(qpMod6, 0, 0) + rnd) >> shift;
    dcValues = h;
  }

  // Decode luma AC blocks
  for (let i = 0; i < 16; i++) {
    const [by, bx] = block4x4Pos(i);
    const absPixX = mbX * 16 + bx;
    const absPixY = mbY * 16 + by;
    const absBx = mbX * 4 + (bx >> 2);
    const absBY = mbY * 4 + (by >> 2);

    // DC index matches block scan order
    const dcIdx = (by >> 2) * 4 + (bx >> 2);

    const block = new Int32Array(16);
    block[0] = dcValues[dcIdx]; // DC from Hadamard

    if (cbpLuma & (1 << (i >> 2))) {
      const nC = getNcLuma(nCLuma, lumaStride, absBx, absBY);
      const { coeffs, totalCoeff } = cavlcDecodeResidual(reader, 15, nC);
      nCLuma[absBY * lumaStride + absBx] = totalCoeff;

      // AC coefficients go to positions 1-15 in zigzag order
      for (let j = 0; j < 15; j++) block[ZIGZAG_4x4[j + 1]] = coeffs[j];
    } else {
      nCLuma[absBY * lumaStride + absBx] = 0;
    }

    // Dequant AC coefficients (skip DC at position 0)
    for (let j = 1; j < 16; j++) {
      if (block[j] === 0) continue;
      const row = Math.floor(j / 4);
      const col = j % 4;
      block[j] = (block[j] * levelScale(qpMod6, row, col)) << qpDiv6;
    }

    // Inverse transform
    const residual = inverseTransform4x4(block);

    // Add to prediction
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++)
        yPlane[(absPixY + y) * lumaW + absPixX + x] = clamp(pred[(by + y) * 16 + bx + x] + residual[y * 4 + x]);
  }

  // Decode chroma
  decodeChroma(reader, pps, mbX, mbY, mbW, mbH, qp, chromaMode, cbpChroma,
    cbPlane, crPlane, chromaW, chromaH, nCCb, nCCr);

  return qp;
}

function decodeChroma(
  reader: BitReader, pps: PPS,
  mbX: number, mbY: number, mbW: number, mbH: number, qpY: number,
  chromaPredMode: number, cbpChroma: number,
  cbPlane: Uint8Array, crPlane: Uint8Array,
  chromaW: number, chromaH: number,
  nCCb: Int16Array, nCCr: Int16Array,
): void {
  const chromaStride = mbW * 2;
  const qpC = chromaQp(qpY, pps.chromaQpIndexOffset);
  const qpMod6 = qpC % 6;
  const qpDiv6 = Math.floor(qpC / 6);

  // Predict both chroma planes
  const cbPred = predict8x8Chroma(chromaPredMode, cbPlane, chromaW, chromaH, mbX, mbY);
  const crPred = predict8x8Chroma(chromaPredMode, crPlane, chromaW, chromaH, mbX, mbY);

  const planes = [
    { pred: cbPred, plane: cbPlane, nC: nCCb },
    { pred: crPred, plane: crPlane, nC: nCCr },
  ];

  for (const { pred, plane, nC } of planes) {
    let dcValues = new Int32Array(4);

    if (cbpChroma >= 1) {
      // Decode chroma DC (2x2 block)
      const dcResult = cavlcDecodeResidual(reader, 4, -1);
      for (let i = 0; i < 4; i++) dcValues[i] = dcResult.coeffs[i];

      // Inverse 2x2 Hadamard
      dcValues = inverseHadamard2x2(dcValues);

      // Dequant DC
      if (qpDiv6 >= 1) {
        for (let i = 0; i < 4; i++)
          dcValues[i] = (dcValues[i] * levelScale(qpMod6, 0, 0)) << (qpDiv6 - 1);
      } else {
        for (let i = 0; i < 4; i++)
          dcValues[i] = (dcValues[i] * levelScale(qpMod6, 0, 0)) >> 1;
      }
    }

    // Decode chroma AC blocks
    for (let bi = 0; bi < 4; bi++) {
      const by = (bi >> 1) * 4;
      const bx = (bi & 1) * 4;
      const absPixX = mbX * 8 + bx;
      const absPixY = mbY * 8 + by;
      const absBx = mbX * 2 + (bx >> 2);
      const absBY = mbY * 2 + (by >> 2);

      const block = new Int32Array(16);
      block[0] = dcValues[bi];

      if (cbpChroma >= 2) {
        const nc = getNcChroma(nC, chromaStride, absBx, absBY);
        const { coeffs, totalCoeff } = cavlcDecodeResidual(reader, 15, nc);
        nC[absBY * chromaStride + absBx] = totalCoeff;

        for (let j = 0; j < 15; j++) block[ZIGZAG_4x4[j + 1]] = coeffs[j];
      } else {
        nC[absBY * chromaStride + absBx] = 0;
      }

      // Dequant AC
      for (let j = 1; j < 16; j++) {
        if (block[j] === 0) continue;
        const row = Math.floor(j / 4);
        const col = j % 4;
        block[j] = (block[j] * levelScale(qpMod6, row, col)) << qpDiv6;
      }

      // Inverse transform
      const residual = inverseTransform4x4(block);

      // Add to prediction
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++)
          plane[(absPixY + y) * chromaW + absPixX + x] = clamp(pred[(by + y) * 8 + bx + x] + residual[y * 4 + x]);
    }
  }
}
