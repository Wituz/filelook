import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodeTiff } from './decoder.ts';

export class TiffGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['tiff'];

  readonly signatures: readonly MagicSignature[] = [
    { type: 'tiff', bytes: [0x49, 0x49, 0x2A, 0x00], offset: 0 }, // Little-endian
    { type: 'tiff', bytes: [0x4D, 0x4D, 0x00, 0x2A], offset: 0 }, // Big-endian
  ];

  decode(data: Uint8Array): PixelGrid {
    return decodeTiff(data);
  }
}
