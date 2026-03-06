// WebP decoder using libwebp compiled to WASM (Apache 2.0, via jSquash)

import { readFileSync } from 'node:fs';
import type { PixelGrid } from '../../types.ts';
import type { WebPModule } from './webp_dec.d.ts';
import moduleFactory from './webp_dec.js';

const wasmBinary = readFileSync(new URL('./webp_dec.wasm', import.meta.url));
const wasmModule = new WebAssembly.Module(wasmBinary);

// The emscripten module factory mutates the passed-in object, so after it
// returns (with synchronous WASM instantiation), module.decode is available.
const module: Record<string, unknown> = {
  instantiateWasm(
    imports: WebAssembly.Imports,
    callback: (instance: WebAssembly.Instance) => void,
  ) {
    const instance = new WebAssembly.Instance(wasmModule, imports);
    callback(instance);
    return instance.exports;
  },
};
moduleFactory(module);

function readU32LE(d: Uint8Array, o: number): number {
  return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
}

function readTag(d: Uint8Array, o: number): string {
  return String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);
}

// For animated VP8X files, extract the first frame's VP8/VP8L bitstream
// and wrap it in a simple RIFF/WEBP container that WebPDecodeRGBA can handle.
function extractFirstFrame(data: Uint8Array): Uint8Array {
  if (data.length < 20 || readTag(data, 0) !== 'RIFF' || readTag(data, 8) !== 'WEBP') {
    return data;
  }

  const innerTag = readTag(data, 12);
  // Simple VP8/VP8L files — decode directly
  if (innerTag === 'VP8 ' || innerTag === 'VP8L') return data;
  // Not VP8X extended — try as-is
  if (innerTag !== 'VP8X') return data;

  // Walk chunks inside the RIFF container to find ANMF (animation frame)
  let pos = 12 + 4 + 4 + readU32LE(data, 16); // skip VP8X chunk
  if (pos % 2 !== 0) pos++; // chunks are 2-byte aligned

  while (pos + 8 <= data.length) {
    const tag = readTag(data, pos);
    const size = readU32LE(data, pos + 4);

    if (tag === 'ANMF') {
      // ANMF payload: 16 bytes header, then a VP8/VP8L sub-chunk
      const frameStart = pos + 8 + 16;
      if (frameStart + 8 > data.length) break;
      const subTag = readTag(data, frameStart);
      const subSize = readU32LE(data, frameStart + 4);

      if (subTag === 'VP8 ' || subTag === 'VP8L') {
        // Build a simple RIFF WEBP container: RIFF + fileSize + WEBP + subchunk
        const fileSize = 4 + 8 + subSize; // "WEBP" + chunk header + chunk data
        const out = new Uint8Array(8 + fileSize);
        out[0] = 0x52; out[1] = 0x49; out[2] = 0x46; out[3] = 0x46; // RIFF
        out[4] = fileSize & 0xFF; out[5] = (fileSize >> 8) & 0xFF;
        out[6] = (fileSize >> 16) & 0xFF; out[7] = (fileSize >> 24) & 0xFF;
        out[8] = 0x57; out[9] = 0x45; out[10] = 0x42; out[11] = 0x50; // WEBP
        out.set(data.subarray(frameStart, frameStart + 8 + subSize), 12);
        return out;
      }
      break;
    }

    pos += 8 + size;
    if (pos % 2 !== 0) pos++;
  }

  return data;
}

export function decodeWebp(data: Uint8Array): PixelGrid {
  const frame = extractFirstFrame(data);
  const decode = module['decode'] as WebPModule['decode'];
  const result = decode(frame.buffer as ArrayBuffer);
  if (!result) throw new Error('Failed to decode WebP image');
  return {
    width: result.width,
    height: result.height,
    data: new Uint8Array(result.data.buffer),
  };
}
