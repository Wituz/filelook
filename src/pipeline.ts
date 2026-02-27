import { readFileSync } from 'node:fs';
import type { ThumbnailInput, ThumbnailOptions, ResolvedOptions } from './types.ts';
import { detectType } from './detect.ts';
import { resize } from './resize.ts';
import { encodePng } from './encode-png.ts';
import { Generator } from './generator.ts';
import { JpegGenerator } from './generators/jpeg/index.ts';
import { PngGenerator } from './generators/png/index.ts';

const generators: readonly Generator[] = [
  new JpegGenerator(),
  new PngGenerator(),
];

const DEFAULTS: ResolvedOptions = {
  width: 256,
  height: 256,
  type: null,
  fit: 'cover',
};

function resolveOptions(options?: ThumbnailOptions): ResolvedOptions {
  return {
    width: options?.width ?? DEFAULTS.width,
    height: options?.height ?? DEFAULTS.height,
    type: options?.type ?? DEFAULTS.type,
    fit: options?.fit ?? DEFAULTS.fit,
  };
}

function loadInput(input: ThumbnailInput): Uint8Array {
  if (Buffer.isBuffer(input)) return new Uint8Array(input);
  if (typeof input === 'string') return new Uint8Array(readFileSync(input));
  throw new Error('Input must be a file path (string) or Buffer');
}

export function generateThumbnail(input: ThumbnailInput, options?: ThumbnailOptions): Buffer {
  const resolved = resolveOptions(options);
  const data = loadInput(input);

  const type = resolved.type ?? detectType(data.subarray(0, 16), generators);
  if (!type) throw new Error('Could not detect file type');

  const generator = generators.find(g => g.canHandle(type));
  if (!generator) throw new Error(`No generator for type: ${type}`);

  const pixels = generator.decode(data);
  const resized = resize(pixels, resolved.width, resolved.height, resolved.fit);
  return Buffer.from(encodePng(resized));
}
