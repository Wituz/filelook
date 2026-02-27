import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodeJpeg } from './decoder.ts';

export class JpegGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['jpeg'];

  readonly signatures: readonly MagicSignature[] = [
    { type: 'jpeg', bytes: [0xFF, 0xD8, 0xFF], offset: 0 },
  ];

  decode(data: Uint8Array): PixelGrid {
    return decodeJpeg(data);
  }
}
