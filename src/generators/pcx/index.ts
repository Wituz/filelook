import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodePcx } from './decoder.ts';
import { VALID_VERSIONS, VALID_BPP } from './types.ts';

export class PcxGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['pcx'];
  readonly signatures: readonly MagicSignature[] = [];

  // PCX magic byte (0x0A) is too weak on its own — use heuristic
  detectFromHeader(header: Uint8Array): FileType | null {
    if (header.length < 4) return null;
    if (header[0] !== 0x0A) return null;
    if (!(VALID_VERSIONS as readonly number[]).includes(header[1])) return null;
    if (header[2] !== 0 && header[2] !== 1) return null;
    if (!(VALID_BPP as readonly number[]).includes(header[3])) return null;
    return 'pcx';
  }

  decode(data: Uint8Array): PixelGrid {
    return decodePcx(data);
  }
}
