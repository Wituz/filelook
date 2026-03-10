import type { PixelGrid } from '../../types.ts';
import { parseVideoTrack, locateKeyframe } from './mp4-parser.ts';
import { extractNalUnits, parseSPS, parsePPS, decodeIFrame } from './h264.ts';

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

export function decodeMp4(data: Uint8Array): PixelGrid {
  const track = parseVideoTrack(data);

  if (track.sps.length === 0) throw new Error('MP4: no SPS found');
  if (track.pps.length === 0) throw new Error('MP4: no PPS found');

  const sps = parseSPS(track.sps[0]);
  const pps = parsePPS(track.pps[0]);

  if (pps.entropyCodingModeFlag) {
    throw new Error('MP4: CABAC entropy coding not supported (High profile). Only CAVLC (Baseline/Main profile) is supported.');
  }

  // Locate keyframe at ~10% of video
  const { offset, size } = locateKeyframe(data, track);

  // Extract NAL units from the sample
  const nals = extractNalUnits(data, offset, size, track.nalLengthSize);

  // Find IDR slice (type 5) or non-IDR I-slice (type 1)
  let sliceNal: Uint8Array | null = null;
  for (const nal of nals) {
    const nalType = nal[0] & 0x1F;
    if (nalType === 5 || nalType === 1) {
      sliceNal = nal;
      break;
    }
  }
  if (!sliceNal) throw new Error('MP4: no slice NAL found in keyframe');

  // Decode the I-frame
  const frame = decodeIFrame(sliceNal, sps, pps);

  // Apply crop and convert YCbCr → RGBA
  const cropW = frame.width - frame.cropLeft - frame.cropRight;
  const cropH = frame.height - frame.cropTop - frame.cropBottom;
  const width = cropW > 0 ? cropW : frame.width;
  const height = cropH > 0 ? cropH : frame.height;

  const rgba = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcY = y + frame.cropTop;
      const srcX = x + frame.cropLeft;
      const yVal = frame.y[srcY * frame.width + srcX];
      const cbVal = frame.cb[(srcY >> 1) * (frame.width >> 1) + (srcX >> 1)];
      const crVal = frame.cr[(srcY >> 1) * (frame.width >> 1) + (srcX >> 1)];

      // BT.601 YCbCr → RGB
      const c = yVal - 16;
      const d = cbVal - 128;
      const e = crVal - 128;
      rgba[(y * width + x) * 4 + 0] = clamp((298 * c + 409 * e + 128) >> 8);
      rgba[(y * width + x) * 4 + 1] = clamp((298 * c - 100 * d - 208 * e + 128) >> 8);
      rgba[(y * width + x) * 4 + 2] = clamp((298 * c + 516 * d + 128) >> 8);
      rgba[(y * width + x) * 4 + 3] = 255;
    }
  }

  return { width, height, data: rgba };
}
