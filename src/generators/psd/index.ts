import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodePsd } from './decoder.ts';

export class PsdGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['psd'];

  readonly signatures: readonly MagicSignature[] = [
    { type: 'psd', bytes: [0x38, 0x42, 0x50, 0x53], offset: 0 },
  ];

  decode(data: Uint8Array): PixelGrid {
    return decodePsd(data);
  }
}
