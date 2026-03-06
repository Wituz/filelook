import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodeIco, decodeAni } from './decoder.ts';

export class IcoGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['ico', 'cur', 'ani'];

  readonly signatures: readonly MagicSignature[] = [
    { type: 'ico', bytes: [0x00, 0x00, 0x01, 0x00], offset: 0 },
    { type: 'cur', bytes: [0x00, 0x00, 0x02, 0x00], offset: 0 },
    { type: 'ani', bytes: [0x41, 0x43, 0x4F, 0x4E], offset: 8 }, // "ACON" in RIFF
  ];

  decode(data: Uint8Array): PixelGrid {
    // ANI starts with "RIFF", ICO/CUR start with 0x00 0x00
    if (data[0] === 0x52 && data[1] === 0x49) return decodeAni(data);
    return decodeIco(data);
  }
}
