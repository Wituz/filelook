// OLE2/CFB (Compound File Binary) container parser

const ENDOFCHAIN = -2;
const FREESECT = -1;
const MINI_STREAM_CUTOFF = 4096;
const MINI_SECTOR_SIZE = 64;

function readU16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}

function readU32(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

function readI32(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
}

interface DirEntry {
  name: string;
  type: number; // 1=storage, 2=stream, 5=root
  startSector: number;
  size: number;
}

export function extractOle2Streams(data: Uint8Array): Map<string, Uint8Array> {
  if (data.length < 512) throw new Error('Invalid OLE2: too short');

  // Verify magic
  if (data[0] !== 0xD0 || data[1] !== 0xCF || data[2] !== 0x11 || data[3] !== 0xE0 ||
      data[4] !== 0xA1 || data[5] !== 0xB1 || data[6] !== 0x1A || data[7] !== 0xE1) {
    throw new Error('Invalid OLE2: bad magic');
  }

  const sectorSizePow = readU16(data, 0x1E);
  const sectorSize = 1 << sectorSizePow;
  const firstDirSector = readI32(data, 0x30);
  const firstMiniFatSector = readI32(data, 0x3C);
  const numMiniFatSectors = readU32(data, 0x40);
  const firstDifatSector = readI32(data, 0x44);
  const numDifatSectors = readU32(data, 0x48);

  // Sector offset helper
  const sectorOffset = (s: number) => 512 + s * sectorSize;

  // Read DIFAT: first 109 entries in header, then chained DIFAT sectors
  const difat: number[] = [];
  for (let i = 0; i < 109; i++) {
    const v = readI32(data, 0x4C + i * 4);
    if (v < 0) break;
    difat.push(v);
  }
  if (numDifatSectors > 0) {
    let difSec = firstDifatSector;
    for (let d = 0; d < numDifatSectors && difSec >= 0; d++) {
      const off = sectorOffset(difSec);
      const entriesPerSec = sectorSize / 4 - 1;
      for (let i = 0; i < entriesPerSec; i++) {
        const v = readI32(data, off + i * 4);
        if (v < 0) break;
        difat.push(v);
      }
      difSec = readI32(data, off + entriesPerSec * 4);
    }
  }

  // Build FAT from DIFAT sectors
  const entriesPerFatSec = sectorSize / 4;
  const fat: number[] = [];
  for (const fatSec of difat) {
    const off = sectorOffset(fatSec);
    for (let i = 0; i < entriesPerFatSec; i++) {
      fat.push(readI32(data, off + i * 4));
    }
  }

  // Follow a FAT chain
  function followChain(start: number, maxSectors = 100000): number[] {
    const chain: number[] = [];
    let s = start;
    while (s >= 0 && s !== ENDOFCHAIN && s !== FREESECT && chain.length < maxSectors) {
      chain.push(s);
      s = fat[s] ?? ENDOFCHAIN;
    }
    return chain;
  }

  // Read stream data from FAT chain
  function readStream(start: number, size: number): Uint8Array {
    const chain = followChain(start);
    const result = new Uint8Array(size);
    let written = 0;
    for (const sec of chain) {
      const off = sectorOffset(sec);
      const toCopy = Math.min(sectorSize, size - written);
      if (toCopy <= 0) break;
      result.set(data.subarray(off, off + toCopy), written);
      written += toCopy;
    }
    return result;
  }

  // Read directory entries
  const dirChain = followChain(firstDirSector);
  const entries: DirEntry[] = [];
  for (const sec of dirChain) {
    const base = sectorOffset(sec);
    const count = sectorSize / 128;
    for (let i = 0; i < count; i++) {
      const entryOff = base + i * 128;
      const nameLen = readU16(data, entryOff + 0x40);
      if (nameLen === 0) continue;
      const type = data[entryOff + 0x42];
      if (type === 0) continue;

      // UTF-16LE name (nameLen includes null terminator, 2 bytes each)
      let name = '';
      const charCount = Math.max(0, nameLen / 2 - 1);
      for (let c = 0; c < charCount; c++) {
        name += String.fromCharCode(readU16(data, entryOff + c * 2));
      }

      const startSector = readI32(data, entryOff + 0x74);
      const size = readU32(data, entryOff + 0x78);
      entries.push({ name, type, startSector, size });
    }
  }

  // Root entry is the first entry with type 5
  const rootEntry = entries.find(e => e.type === 5);

  // Build mini-FAT if needed
  let miniFat: number[] = [];
  if (numMiniFatSectors > 0 && firstMiniFatSector >= 0) {
    const miniChain = followChain(firstMiniFatSector);
    for (const sec of miniChain) {
      const off = sectorOffset(sec);
      for (let i = 0; i < entriesPerFatSec; i++) {
        miniFat.push(readI32(data, off + i * 4));
      }
    }
  }

  // Read mini-stream (root entry's stream data)
  let miniStream: Uint8Array | null = null;
  if (rootEntry && rootEntry.startSector >= 0) {
    miniStream = readStream(rootEntry.startSector, rootEntry.size);
  }

  function readMiniStream(start: number, size: number): Uint8Array {
    if (!miniStream) throw new Error('No mini-stream');
    const result = new Uint8Array(size);
    let written = 0;
    let s = start;
    while (s >= 0 && s !== ENDOFCHAIN && written < size) {
      const off = s * MINI_SECTOR_SIZE;
      const toCopy = Math.min(MINI_SECTOR_SIZE, size - written);
      result.set(miniStream.subarray(off, off + toCopy), written);
      written += toCopy;
      s = miniFat[s] ?? ENDOFCHAIN;
    }
    return result;
  }

  // Extract stream entries
  const streams = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (entry.type !== 2) continue; // Only stream entries
    if (entry.startSector < 0) continue;

    if (entry.size < MINI_STREAM_CUTOFF && miniStream) {
      streams.set(entry.name, readMiniStream(entry.startSector, entry.size));
    } else {
      streams.set(entry.name, readStream(entry.startSector, entry.size));
    }
  }

  return streams;
}
