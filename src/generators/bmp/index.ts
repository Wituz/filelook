import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodeBmp } from './decoder.ts';

export class BmpGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['bmp'];

  readonly signatures: readonly MagicSignature[] = [
    { type: 'bmp', bytes: [0x42, 0x4D], offset: 0 },
  ];

  decode(data: Uint8Array): PixelGrid {
    return decodeBmp(data);
  }
}
