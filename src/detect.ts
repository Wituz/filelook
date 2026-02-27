import type { FileType } from './types.ts';
import type { Generator } from './generator.ts';

export function detectType(header: Uint8Array, generators: readonly Generator[]): FileType | null {
  for (const gen of generators) {
    const type = gen.detectFromHeader(header);
    if (type) return type;
  }
  return null;
}
