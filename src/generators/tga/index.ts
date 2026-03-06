import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodeTga } from './decoder.ts';
import { VALID_IMAGE_TYPES } from './types.ts';

export class TgaGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['tga'];
  readonly signatures: readonly MagicSignature[] = [];

  // TGA has no magic bytes — use heuristic header analysis
  detectFromHeader(header: Uint8Array): FileType | null {
    if (header.length < 16) return null;

    const colorMapType = header[1];
    if (colorMapType !== 0 && colorMapType !== 1) return null;

    const imageType = header[2];
    if (!(VALID_IMAGE_TYPES as readonly number[]).includes(imageType)) return null;

    const width = header[12] | (header[13] << 8);
    const height = header[14] | (header[15] << 8);
    if (width === 0 || height === 0) return null;

    return 'tga';
  }

  decode(data: Uint8Array): PixelGrid {
    return decodeTga(data);
  }
}
