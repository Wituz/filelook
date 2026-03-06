export interface GifHeader {
  width: number;
  height: number;
  hasGlobalTable: boolean;
  globalTableSize: number;
  bgColorIndex: number;
}

export interface GifFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  hasLocalTable: boolean;
  localTableSize: number;
  interlaced: boolean;
}
