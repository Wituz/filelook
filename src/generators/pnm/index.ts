import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodePnm } from './decoder.ts';

export class PnmGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['pbm', 'pgm', 'ppm'];

  readonly signatures: readonly MagicSignature[] = [
    { type: 'pbm', bytes: [0x50, 0x31], offset: 0 }, // P1
    { type: 'pgm', bytes: [0x50, 0x32], offset: 0 }, // P2
    { type: 'ppm', bytes: [0x50, 0x33], offset: 0 }, // P3
    { type: 'pbm', bytes: [0x50, 0x34], offset: 0 }, // P4
    { type: 'pgm', bytes: [0x50, 0x35], offset: 0 }, // P5
    { type: 'ppm', bytes: [0x50, 0x36], offset: 0 }, // P6
  ];

  decode(data: Uint8Array): PixelGrid {
    return decodePnm(data);
  }
}
