import type { PixelGrid, FileType } from './types.ts';

export interface MagicSignature {
  readonly type: FileType;
  readonly bytes: readonly number[];
  readonly offset: number;
}

export abstract class Generator {
  abstract readonly supportedTypes: readonly FileType[];
  abstract readonly signatures: readonly MagicSignature[];

  abstract decode(data: Uint8Array): PixelGrid;

  canHandle(type: FileType): boolean {
    return this.supportedTypes.includes(type);
  }

  detectFromHeader(header: Uint8Array): FileType | null {
    for (const sig of this.signatures) {
      if (header.length < sig.offset + sig.bytes.length) continue;
      if (sig.bytes.every((b, i) => header[sig.offset + i] === b)) {
        return sig.type;
      }
    }
    return null;
  }
}
