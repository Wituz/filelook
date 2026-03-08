export interface BiffRecord {
  type: number;
  data: Uint8Array;
  continueBoundaries: number[]; // offsets where CONTINUE records begin
}
