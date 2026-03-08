import { Generator, type MagicSignature } from '../../generator.ts';
import type { PixelGrid, FileType } from '../../types.ts';
import { decodeCsv } from './decoder.ts';

export class CsvGenerator extends Generator {
  readonly supportedTypes: readonly FileType[] = ['csv'];
  readonly signatures: readonly MagicSignature[] = [];

  detectFromHeader(header: Uint8Array): FileType | null {
    // CSV has no magic bytes — use content heuristics
    if (header.length < 4) return null;

    // Must look like text: no binary control chars (except \t, \r, \n)
    const checkLen = Math.min(header.length, 512);
    let hasDelimiter = false;
    let hasNewline = false;

    for (let i = 0; i < checkLen; i++) {
      const b = header[i];
      if (b === 0x2C || b === 0x3B || b === 0x7C) hasDelimiter = true; // , ; |
      if (b === 0x09) hasDelimiter = true; // tab
      if (b === 0x0A) hasNewline = true;
      if (b === 0x0D) continue; // CR is fine
      if (b < 0x09 || (b > 0x0D && b < 0x20 && b !== 0x1B)) return null; // binary
    }

    if (!hasDelimiter || !hasNewline) return null;

    // Check that first two lines have the same delimiter count
    const text = new TextDecoder('utf-8').decode(header.subarray(0, checkLen));
    const lines = text.split(/\r?\n/).filter(l => l.length > 0);
    if (lines.length < 2) return null;

    const delimiters = [',', '\t', ';', '|'];
    for (const d of delimiters) {
      const count0 = countChar(lines[0], d);
      const count1 = countChar(lines[1], d);
      if (count0 > 0 && count0 === count1) return 'csv';
    }

    return null;
  }

  decode(data: Uint8Array): PixelGrid {
    return decodeCsv(data);
  }
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) n++;
  }
  return n;
}
