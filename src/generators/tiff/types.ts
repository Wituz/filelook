export const enum Tag {
  ImageWidth = 256,
  ImageLength = 257,
  BitsPerSample = 258,
  Compression = 259,
  PhotometricInterpretation = 262,
  StripOffsets = 273,
  SamplesPerPixel = 277,
  RowsPerStrip = 278,
  StripByteCounts = 279,
  PlanarConfiguration = 284,
  ColorMap = 320,
  ExtraSamples = 338,
}

export const enum Compression {
  None = 1,
  LZW = 5,
  Deflate = 8,
  AdobeDeflate = 32946,
  PackBits = 32773,
}

export const enum Photometric {
  WhiteIsZero = 0,
  BlackIsZero = 1,
  RGB = 2,
  Palette = 3,
}

export const enum FieldType {
  BYTE = 1,
  ASCII = 2,
  SHORT = 3,
  LONG = 4,
  RATIONAL = 5,
}

export const FIELD_TYPE_SIZE: Record<number, number> = {
  [FieldType.BYTE]: 1,
  [FieldType.ASCII]: 1,
  [FieldType.SHORT]: 2,
  [FieldType.LONG]: 4,
  [FieldType.RATIONAL]: 8,
};

export interface TiffHeader {
  readonly littleEndian: boolean;
  readonly ifdOffset: number;
}

export interface IfdEntry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  readonly valueOffset: number; // byte position of the 4-byte value field in the file
}

export interface TiffInfo {
  readonly width: number;
  readonly height: number;
  readonly bitsPerSample: number[];
  readonly compression: Compression;
  readonly photometric: Photometric;
  readonly stripOffsets: number[];
  readonly samplesPerPixel: number;
  readonly rowsPerStrip: number;
  readonly stripByteCounts: number[];
  readonly colorMap: Uint16Array | null;
  readonly extraSamples: number | null;
}
