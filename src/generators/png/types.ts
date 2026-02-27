export const enum ColorType {
  Grayscale = 0,
  RGB = 2,
  Indexed = 3,
  GrayscaleAlpha = 4,
  RGBA = 6,
}

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: ColorType;
  interlace: number;
}

// Bytes per pixel for each color type at 8-bit depth
export function bytesPerPixel(colorType: ColorType): number {
  switch (colorType) {
    case ColorType.Grayscale: return 1;
    case ColorType.RGB: return 3;
    case ColorType.Indexed: return 1;
    case ColorType.GrayscaleAlpha: return 2;
    case ColorType.RGBA: return 4;
  }
}
