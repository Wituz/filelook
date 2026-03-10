export interface Mp4Box {
  type: string;
  offset: number;
  size: number;
  dataOffset: number;
}

export interface SttsEntry {
  sampleCount: number;
  sampleDelta: number;
}

export interface StscEntry {
  firstChunk: number;
  samplesPerChunk: number;
  sampleDescriptionIndex: number;
}

export interface TrackInfo {
  timescale: number;
  duration: number;
  codec: string;
  width: number;
  height: number;
  sps: Uint8Array[];
  pps: Uint8Array[];
  nalLengthSize: number;
  stts: SttsEntry[];
  stss: number[];
  stsc: StscEntry[];
  stsz: number[];
  chunkOffsets: number[];
}

export interface SPS {
  profileIdc: number;
  levelIdc: number;
  chromaFormatIdc: number;
  bitDepthLuma: number;
  bitDepthChroma: number;
  log2MaxFrameNum: number;
  picOrderCntType: number;
  log2MaxPocLsb: number;
  picWidthInMbs: number;
  picHeightInMapUnits: number;
  frameMbsOnly: boolean;
  cropLeft: number;
  cropRight: number;
  cropTop: number;
  cropBottom: number;
}

export interface PPS {
  entropyCodingModeFlag: boolean;
  picInitQpMinus26: number;
  chromaQpIndexOffset: number;
  deblockingFilterControlPresent: boolean;
  transform8x8ModeFlag: boolean;
  secondChromaQpIndexOffset: number;
}

export interface SliceHeader {
  firstMbInSlice: number;
  sliceType: number;
  qpDelta: number;
}
