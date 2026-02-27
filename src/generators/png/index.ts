import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodePng } from './decoder.ts';

export class PngGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['png'];

  readonly signatures: readonly MagicSignature[] = [
    { type: 'png', bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], offset: 0 },
  ];

  decode(data: Uint8Array): PixelGrid {
    return decodePng(data);
  }
}
