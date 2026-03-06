export interface PsdHeader {
  version: number;
  channels: number;
  height: number;
  width: number;
  depth: number; // bits per channel: 1, 8, 16, 32
  colorMode: number;
}

export const COLOR_MODE_GRAYSCALE = 1;
export const COLOR_MODE_RGB = 3;
export const COLOR_MODE_CMYK = 4;
