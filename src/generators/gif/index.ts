import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodeGif } from './decoder.ts';

export class GifGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['gif'];

  readonly signatures: readonly MagicSignature[] = [
    { type: 'gif', bytes: [0x47, 0x49, 0x46, 0x38, 0x39], offset: 0 }, // GIF89a
    { type: 'gif', bytes: [0x47, 0x49, 0x46, 0x38, 0x37], offset: 0 }, // GIF87a
  ];

  decode(data: Uint8Array): PixelGrid {
    return decodeGif(data);
  }
}
