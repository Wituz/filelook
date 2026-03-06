export interface BmpHeader {
  dataOffset: number;
  width: number;
  height: number;
  bitsPerPixel: number;
  compression: number;
  // Negative height means top-down row order
  topDown: boolean;
}

// BI_RGB = uncompressed, BI_BITFIELDS = channel masks
export const BI_RGB = 0;
export const BI_BITFIELDS = 3;
