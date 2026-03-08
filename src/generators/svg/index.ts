import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodeSvg } from './decoder.ts';

export class SvgGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['svg'];
  readonly signatures: readonly MagicSignature[] = [];

  detectFromHeader(header: Uint8Array): FileType | null {
    const checkLen = Math.min(header.length, 1024);
    for (let i = 0; i < checkLen; i++) {
      const b = header[i];
      if (b < 0x09 || (b > 0x0D && b < 0x20 && b !== 0x1B)) return null;
    }
    const text = new TextDecoder('utf-8').decode(header.subarray(0, checkLen));
    if (/<svg[\s>]/i.test(text)) return 'svg';
    return null;
  }

  decode(data: Uint8Array): PixelGrid {
    return decodeSvg(data);
  }
}
