import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodePptx } from './decoder.ts';

export class PptxGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['pptx'];
  readonly signatures: readonly MagicSignature[] = [];

  detectFromHeader(header: Uint8Array): FileType | null {
    if (header.length < 34) return null;
    // PK\x03\x04
    if (header[0] !== 0x50 || header[1] !== 0x4B || header[2] !== 0x03 || header[3] !== 0x04) return null;
    // "ppt/" at offset 30
    if (header[30] === 0x70 && header[31] === 0x70 && header[32] === 0x74 && header[33] === 0x2F) return 'pptx';
    return null;
  }

  decode(data: Uint8Array): PixelGrid {
    return decodePptx(data);
  }
}
