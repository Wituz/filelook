import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodeQoi } from './decoder.ts';

export class QoiGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['qoi'];

  readonly signatures: readonly MagicSignature[] = [
    { type: 'qoi', bytes: [0x71, 0x6F, 0x69, 0x66], offset: 0 },
  ];

  decode(data: Uint8Array): PixelGrid {
    return decodeQoi(data);
  }
}
