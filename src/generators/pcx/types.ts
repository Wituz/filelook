export interface PcxHeader {
  version: number;
  encoding: number;
  bitsPerPixel: number;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  width: number;
  height: number;
  numPlanes: number;
  bytesPerLine: number;
  paletteType: number;
  // 16-color palette from header bytes 16–63
  egaPalette: Uint8Array;
}

export const VALID_VERSIONS = [0, 2, 3, 4, 5] as const;
export const VALID_BPP = [1, 2, 4, 8] as const;
