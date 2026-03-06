import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodeDds } from './decoder.ts';

export class DdsGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['dds'];

  readonly signatures: readonly MagicSignature[] = [
    { type: 'dds', bytes: [0x44, 0x44, 0x53, 0x20], offset: 0 },
  ];

  decode(data: Uint8Array): PixelGrid {
    return decodeDds(data);
  }
}
