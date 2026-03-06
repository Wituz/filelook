export interface PnmHeader {
  magic: number; // 1–6 (from P1–P6)
  width: number;
  height: number;
  maxval: number; // 1 for PBM, otherwise parsed from header
  dataOffset: number; // byte offset where pixel data begins
}
