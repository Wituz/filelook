import type { Mp4Box, TrackInfo, SttsEntry, StscEntry } from './types.ts';

function readU16(d: Uint8Array, o: number): number {
  return (d[o] << 8) | d[o + 1];
}

function readU32(d: Uint8Array, o: number): number {
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
}

function readU64(d: Uint8Array, o: number): number {
  // JS can't handle full 64-bit, but file offsets rarely exceed 2^53
  const hi = readU32(d, o);
  const lo = readU32(d, o + 4);
  return hi * 0x100000000 + lo;
}

function boxType(d: Uint8Array, o: number): string {
  return String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);
}

function* iterateBoxes(data: Uint8Array, start: number, end: number): Generator<Mp4Box> {
  let pos = start;
  while (pos + 8 <= end) {
    let size = readU32(data, pos);
    const type = boxType(data, pos + 4);
    let dataOffset = pos + 8;

    if (size === 1) {
      if (pos + 16 > end) break;
      size = readU64(data, pos + 8);
      dataOffset = pos + 16;
    } else if (size === 0) {
      size = end - pos;
    }

    if (size < 8 || pos + size > end) break;
    yield { type, offset: pos, size, dataOffset };
    pos += size;
  }
}

function findBox(data: Uint8Array, start: number, end: number, type: string): Mp4Box | null {
  for (const box of iterateBoxes(data, start, end)) {
    if (box.type === type) return box;
  }
  return null;
}

function findAllBoxes(data: Uint8Array, start: number, end: number, type: string): Mp4Box[] {
  const result: Mp4Box[] = [];
  for (const box of iterateBoxes(data, start, end)) {
    if (box.type === type) result.push(box);
  }
  return result;
}

export function parseVideoTrack(data: Uint8Array): TrackInfo {
  const moov = findBox(data, 0, data.length, 'moov');
  if (!moov) throw new Error('MP4: no moov box');

  const moovEnd = moov.offset + moov.size;
  const traks = findAllBoxes(data, moov.dataOffset, moovEnd, 'trak');

  for (const trak of traks) {
    const trakEnd = trak.offset + trak.size;
    const mdia = findBox(data, trak.dataOffset, trakEnd, 'mdia');
    if (!mdia) continue;
    const mdiaEnd = mdia.offset + mdia.size;

    // Check handler type
    const hdlr = findBox(data, mdia.dataOffset, mdiaEnd, 'hdlr');
    if (!hdlr) continue;
    const handlerType = boxType(data, hdlr.dataOffset + 8);
    if (handlerType !== 'vide') continue;

    // Parse mdhd for timescale/duration
    const mdhd = findBox(data, mdia.dataOffset, mdiaEnd, 'mdhd');
    if (!mdhd) throw new Error('MP4: no mdhd');
    const mdhdVersion = data[mdhd.dataOffset];
    let timescale: number, duration: number;
    if (mdhdVersion === 0) {
      timescale = readU32(data, mdhd.dataOffset + 12);
      duration = readU32(data, mdhd.dataOffset + 16);
    } else {
      timescale = readU32(data, mdhd.dataOffset + 20);
      duration = readU64(data, mdhd.dataOffset + 24);
    }

    // Find stbl
    const minf = findBox(data, mdia.dataOffset, mdiaEnd, 'minf');
    if (!minf) throw new Error('MP4: no minf');
    const stbl = findBox(data, minf.dataOffset, minf.offset + minf.size, 'stbl');
    if (!stbl) throw new Error('MP4: no stbl');
    const stblEnd = stbl.offset + stbl.size;

    // Parse stsd → avc1 → avcC
    const stsd = findBox(data, stbl.dataOffset, stblEnd, 'stsd');
    if (!stsd) throw new Error('MP4: no stsd');
    // stsd: version(4) + entry_count(4) + entries
    const entryOffset = stsd.dataOffset + 8;
    const entrySize = readU32(data, entryOffset);
    const codec = boxType(data, entryOffset + 4);
    if (codec !== 'avc1' && codec !== 'avc3') {
      throw new Error(`Unsupported codec: ${codec}`);
    }

    // avc1 box: 8-byte header + 78 bytes of visual sample entry fields to reach child boxes
    const avc1DataStart = entryOffset + 8 + 78;
    const avc1End = entryOffset + entrySize;
    const width = readU16(data, entryOffset + 8 + 24);
    const height = readU16(data, entryOffset + 8 + 26);

    const avcC = findBox(data, avc1DataStart, avc1End, 'avcC');
    if (!avcC) throw new Error('MP4: no avcC');

    const c = avcC.dataOffset;
    const nalLengthSize = (data[c + 4] & 3) + 1;
    const numSps = data[c + 5] & 0x1F;
    const sps: Uint8Array[] = [];
    let pos = c + 6;
    for (let i = 0; i < numSps; i++) {
      const len = readU16(data, pos);
      pos += 2;
      sps.push(data.slice(pos, pos + len));
      pos += len;
    }
    const numPps = data[pos++];
    const pps: Uint8Array[] = [];
    for (let i = 0; i < numPps; i++) {
      const len = readU16(data, pos);
      pos += 2;
      pps.push(data.slice(pos, pos + len));
      pos += len;
    }

    // Parse sample tables
    const stts = parseStts(data, stbl.dataOffset, stblEnd);
    const stss = parseStss(data, stbl.dataOffset, stblEnd);
    const stsc = parseStsc(data, stbl.dataOffset, stblEnd);
    const stsz = parseStsz(data, stbl.dataOffset, stblEnd);
    const chunkOffsets = parseChunkOffsets(data, stbl.dataOffset, stblEnd);

    return {
      timescale, duration, codec, width, height,
      sps, pps, nalLengthSize,
      stts, stss, stsc, stsz, chunkOffsets,
    };
  }

  throw new Error('MP4: no video track found');
}

function parseStts(data: Uint8Array, start: number, end: number): SttsEntry[] {
  const box = findBox(data, start, end, 'stts');
  if (!box) throw new Error('MP4: no stts');
  const count = readU32(data, box.dataOffset + 4);
  const entries: SttsEntry[] = [];
  let pos = box.dataOffset + 8;
  for (let i = 0; i < count; i++) {
    entries.push({ sampleCount: readU32(data, pos), sampleDelta: readU32(data, pos + 4) });
    pos += 8;
  }
  return entries;
}

function parseStss(data: Uint8Array, start: number, end: number): number[] {
  const box = findBox(data, start, end, 'stss');
  if (!box) return []; // No stss = all samples are sync
  const count = readU32(data, box.dataOffset + 4);
  const entries: number[] = [];
  let pos = box.dataOffset + 8;
  for (let i = 0; i < count; i++) {
    entries.push(readU32(data, pos));
    pos += 4;
  }
  return entries;
}

function parseStsc(data: Uint8Array, start: number, end: number): StscEntry[] {
  const box = findBox(data, start, end, 'stsc');
  if (!box) throw new Error('MP4: no stsc');
  const count = readU32(data, box.dataOffset + 4);
  const entries: StscEntry[] = [];
  let pos = box.dataOffset + 8;
  for (let i = 0; i < count; i++) {
    entries.push({
      firstChunk: readU32(data, pos),
      samplesPerChunk: readU32(data, pos + 4),
      sampleDescriptionIndex: readU32(data, pos + 8),
    });
    pos += 12;
  }
  return entries;
}

function parseStsz(data: Uint8Array, start: number, end: number): number[] {
  const box = findBox(data, start, end, 'stsz');
  if (!box) throw new Error('MP4: no stsz');
  const sampleSize = readU32(data, box.dataOffset + 4);
  const count = readU32(data, box.dataOffset + 8);
  const entries: number[] = [];
  if (sampleSize !== 0) {
    for (let i = 0; i < count; i++) entries.push(sampleSize);
  } else {
    let pos = box.dataOffset + 12;
    for (let i = 0; i < count; i++) {
      entries.push(readU32(data, pos));
      pos += 4;
    }
  }
  return entries;
}

function parseChunkOffsets(data: Uint8Array, start: number, end: number): number[] {
  const co64 = findBox(data, start, end, 'co64');
  if (co64) {
    const count = readU32(data, co64.dataOffset + 4);
    const entries: number[] = [];
    let pos = co64.dataOffset + 8;
    for (let i = 0; i < count; i++) {
      entries.push(readU64(data, pos));
      pos += 8;
    }
    return entries;
  }
  const stco = findBox(data, start, end, 'stco');
  if (!stco) throw new Error('MP4: no stco/co64');
  const count = readU32(data, stco.dataOffset + 4);
  const entries: number[] = [];
  let pos = stco.dataOffset + 8;
  for (let i = 0; i < count; i++) {
    entries.push(readU32(data, pos));
    pos += 4;
  }
  return entries;
}

export function locateKeyframe(data: Uint8Array, track: TrackInfo): { offset: number; size: number } {
  // Calculate total sample count and find sample at ~10% of duration
  let totalSamples = 0;
  for (const e of track.stts) totalSamples += e.sampleCount;

  let targetTime = 0;
  for (const e of track.stts) targetTime += e.sampleCount * e.sampleDelta;
  targetTime = Math.floor(targetTime * 0.1);

  // Walk stts to find sample at target time
  let time = 0;
  let targetSample = 1; // 1-based
  for (const e of track.stts) {
    for (let i = 0; i < e.sampleCount; i++) {
      if (time + e.sampleDelta > targetTime) break;
      time += e.sampleDelta;
      targetSample++;
    }
    if (time >= targetTime) break;
  }
  targetSample = Math.min(targetSample, totalSamples);

  // Find nearest sync sample <= target
  let syncSample = 1;
  if (track.stss.length > 0) {
    for (const ss of track.stss) {
      if (ss <= targetSample) syncSample = ss;
      else break;
    }
  } else {
    syncSample = targetSample; // All samples are sync
  }

  // Map sample number to file offset using stsc + stsz + chunkOffsets
  return sampleToOffset(track, syncSample);
}

function sampleToOffset(track: TrackInfo, sampleNum: number): { offset: number; size: number } {
  // Find which chunk contains this sample
  let sampleIdx = 0; // 0-based cumulative sample count
  const target = sampleNum - 1; // Convert to 0-based

  for (let ci = 0; ci < track.chunkOffsets.length; ci++) {
    const chunkNum = ci + 1; // 1-based
    const samplesInChunk = getSamplesPerChunk(track.stsc, chunkNum, track.chunkOffsets.length);

    if (sampleIdx + samplesInChunk > target) {
      // Sample is in this chunk
      const sampleInChunk = target - sampleIdx;
      let offset = track.chunkOffsets[ci];
      for (let s = 0; s < sampleInChunk; s++) {
        offset += track.stsz[sampleIdx + s];
      }
      return { offset, size: track.stsz[target] };
    }
    sampleIdx += samplesInChunk;
  }

  throw new Error('MP4: sample not found');
}

function getSamplesPerChunk(stsc: StscEntry[], chunkNum: number, totalChunks: number): number {
  let samplesPerChunk = stsc[0].samplesPerChunk;
  for (const entry of stsc) {
    if (entry.firstChunk > chunkNum) break;
    samplesPerChunk = entry.samplesPerChunk;
  }
  return samplesPerChunk;
}
