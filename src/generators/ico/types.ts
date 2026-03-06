export interface IcoHeader {
  readonly type: number;  // 1 = ICO, 2 = CUR
  readonly count: number;
}

export interface IcoDirEntry {
  readonly width: number;       // 0 in file means 256
  readonly height: number;      // 0 in file means 256
  readonly colorCount: number;
  readonly bitsPerPixel: number; // ICO: bpp, CUR: hotspotY (ignored for selection)
  readonly dataSize: number;
  readonly dataOffset: number;
}
