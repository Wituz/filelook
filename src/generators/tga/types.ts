export interface TgaHeader {
  idLength: number;
  colorMapType: number;
  imageType: number;
  colorMapFirstIndex: number;
  colorMapLength: number;
  colorMapEntrySize: number;
  width: number;
  height: number;
  pixelDepth: number;
  // Bit 5: top-to-bottom row order
  descriptor: number;
}

// Uncompressed
export const IMAGE_TYPE_COLOR_MAPPED = 1;
export const IMAGE_TYPE_TRUE_COLOR = 2;
export const IMAGE_TYPE_GRAYSCALE = 3;

// RLE-compressed
export const IMAGE_TYPE_RLE_COLOR_MAPPED = 9;
export const IMAGE_TYPE_RLE_TRUE_COLOR = 10;
export const IMAGE_TYPE_RLE_GRAYSCALE = 11;

export const VALID_IMAGE_TYPES = [
  IMAGE_TYPE_COLOR_MAPPED, IMAGE_TYPE_TRUE_COLOR, IMAGE_TYPE_GRAYSCALE,
  IMAGE_TYPE_RLE_COLOR_MAPPED, IMAGE_TYPE_RLE_TRUE_COLOR, IMAGE_TYPE_RLE_GRAYSCALE,
] as const;
