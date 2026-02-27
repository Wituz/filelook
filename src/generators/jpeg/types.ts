export interface HuffmanTable {
  // Fast lookup: code length for each symbol index
  readonly minCode: Int32Array;  // min code value per bit length
  readonly maxCode: Int32Array;  // max code value per bit length
  readonly valPtr: Int32Array;   // index into values for each bit length
  readonly values: Uint8Array;
}

export interface QuantizationTable {
  readonly data: Int32Array; // 64 entries in zigzag order
}

export interface FrameComponent {
  readonly id: number;
  readonly hSample: number; // horizontal sampling factor
  readonly vSample: number; // vertical sampling factor
  readonly qtId: number;    // quantization table selector
}

export interface FrameInfo {
  readonly width: number;
  readonly height: number;
  readonly components: FrameComponent[];
  readonly maxH: number; // max horizontal sampling factor
  readonly maxV: number; // max vertical sampling factor
}

export interface ScanComponent {
  readonly compIdx: number; // index into frame components
  readonly dcTableId: number;
  readonly acTableId: number;
}

// Standard JPEG zigzag order
export const ZIGZAG = [
   0,  1,  8, 16,  9,  2,  3, 10,
  17, 24, 32, 25, 18, 11,  4,  5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13,  6,  7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
] as const;
