import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodeWebp } from './decoder.ts';

export class WebpGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['webp'];

  readonly signatures: readonly MagicSignature[] = [
    { type: 'webp', bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 }, // "WEBP" at offset 8
  ];

  decode(data: Uint8Array): PixelGrid {
    return decodeWebp(data);
  }
}
