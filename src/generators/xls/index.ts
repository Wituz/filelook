import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodeXls } from './decoder.ts';

export class XlsGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['xls'];
  readonly signatures: readonly MagicSignature[] = [
    { type: 'xls', bytes: [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1], offset: 0 },
  ];

  decode(data: Uint8Array): PixelGrid {
    return decodeXls(data);
  }
}
