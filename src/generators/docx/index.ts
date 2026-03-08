import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodeDocx } from './decoder.ts';

const CONTENT_TYPES = [0x5B, 0x43, 0x6F, 0x6E, 0x74, 0x65, 0x6E, 0x74, 0x5F, 0x54, 0x79, 0x70, 0x65, 0x73, 0x5D]; // [Content_Types]

export class DocxGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['docx'];
  readonly signatures: readonly MagicSignature[] = [];

  detectFromHeader(header: Uint8Array): FileType | null {
    if (header.length < 45) return null;
    // PK\x03\x04
    if (header[0] !== 0x50 || header[1] !== 0x4B || header[2] !== 0x03 || header[3] !== 0x04) return null;
    // First entry filename starts at offset 30 — check for [Content_Types]
    for (let i = 0; i < CONTENT_TYPES.length; i++) {
      if (header[30 + i] !== CONTENT_TYPES[i]) return null;
    }
    return 'docx';
  }

  decode(data: Uint8Array): PixelGrid {
    return decodeDocx(data);
  }
}
