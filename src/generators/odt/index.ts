import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodeOdt } from './decoder.ts';

export class OdtGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['odt'];
  readonly signatures: readonly MagicSignature[] = [];

  detectFromHeader(header: Uint8Array): FileType | null {
    if (header.length < 60) return null;
    // PK\x03\x04
    if (header[0] !== 0x50 || header[1] !== 0x4B || header[2] !== 0x03 || header[3] !== 0x04) return null;
    // "mimetype" at offset 30
    if (header[30] !== 0x6D || header[31] !== 0x69 || header[32] !== 0x6D || header[33] !== 0x65 ||
        header[34] !== 0x74 || header[35] !== 0x79 || header[36] !== 0x70 || header[37] !== 0x65) return null;
    // Scan for "opendoc" shortly after to confirm ODT (not ODS/ODP)
    for (let i = 38; i < Math.min(header.length - 17, 120); i++) {
      if (header[i] === 0x6F && header[i + 1] === 0x70 && header[i + 2] === 0x65 && header[i + 3] === 0x6E &&
          header[i + 4] === 0x64 && header[i + 5] === 0x6F && header[i + 6] === 0x63) {
        // Verify ".text" follows "opendocument"
        for (let j = i + 7; j < Math.min(header.length - 5, i + 30); j++) {
          if (header[j] === 0x2E && header[j + 1] === 0x74 && header[j + 2] === 0x65 &&
              header[j + 3] === 0x78 && header[j + 4] === 0x74) return 'odt';
        }
        return null;
      }
    }
    return null;
  }

  decode(data: Uint8Array): PixelGrid {
    return decodeOdt(data);
  }
}
