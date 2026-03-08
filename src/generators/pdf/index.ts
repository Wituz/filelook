import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodePdf } from './decoder.ts';

export class PdfGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['pdf'];

  readonly signatures: readonly MagicSignature[] = [
    { type: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46], offset: 0 }, // %PDF
  ];

  decode(data: Uint8Array): PixelGrid {
    return decodePdf(data);
  }
}
