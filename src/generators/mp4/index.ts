import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodeMp4 } from './decoder.ts';

export class Mp4Generator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['mp4'];
  readonly signatures: readonly MagicSignature[] = [
    // 'ftyp' at offset 4
    { type: 'mp4', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  ];

  decode(data: Uint8Array): PixelGrid {
    return decodeMp4(data);
  }
}
