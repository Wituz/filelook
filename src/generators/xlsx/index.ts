import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodeXlsx } from './decoder.ts';

export class XlsxGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['xlsx'];
  readonly signatures: readonly MagicSignature[] = [];

  detectFromHeader(header: Uint8Array): FileType | null {
    if (header.length < 4) return null;
    if (header[0] !== 0x50 || header[1] !== 0x4B || header[2] !== 0x03 || header[3] !== 0x04) return null;
    // Scan for 'xl/' in raw bytes (ZIP filenames are plaintext)
    for (let i = 30; i < header.length - 2; i++) {
      if (header[i] === 0x78 && header[i + 1] === 0x6C && header[i + 2] === 0x2F) return 'xlsx';
    }
    return null;
  }

  decode(data: Uint8Array): PixelGrid {
    return decodeXlsx(data);
  }
}
