// BIFF8 record reader with CONTINUE handling

import type { BiffRecord } from './types.ts';

const CONTINUE = 0x003C;

function readU16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}

export function readBiffRecords(data: Uint8Array): BiffRecord[] {
  const records: BiffRecord[] = [];
  let pos = 0;

  while (pos + 4 <= data.length) {
    const type = readU16(data, pos);
    const size = readU16(data, pos + 2);
    pos += 4;

    if (pos + size > data.length) break;
    let recData = data.subarray(pos, pos + size);
    pos += size;

    const continueBoundaries: number[] = [];

    // Merge CONTINUE records
    while (pos + 4 <= data.length && readU16(data, pos) === CONTINUE) {
      const contSize = readU16(data, pos + 2);
      pos += 4;
      if (pos + contSize > data.length) break;
      continueBoundaries.push(recData.length);
      const merged = new Uint8Array(recData.length + contSize);
      merged.set(recData, 0);
      merged.set(data.subarray(pos, pos + contSize), recData.length);
      recData = merged;
      pos += contSize;
    }

    records.push({ type, data: recData, continueBoundaries });
  }

  return records;
}
