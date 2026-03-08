import type { PixelGrid } from '../../types.ts';
import { extractOle2Streams } from '../xls/ole2.ts';
import { renderDocumentToPixels } from '../docx/decoder.ts';
import type {
  DocxDocument, DocxBlock, DocxParagraph, DocxRun, DocxRunProps,
  DocxParagraphProps, DocxFloatingImage, DocxInlineImage,
} from '../docx/types.ts';
import { DEFAULT_PARA_PROPS, DEFAULT_RUN_PROPS } from '../docx/types.ts';
import type { FibFields, PieceDescriptor, CharProps, ParaProps } from './types.ts';
import {
  SPRM_C_FBOLD, SPRM_C_FITALIC, SPRM_C_HPS, SPRM_C_ICO,
  SPRM_C_FSPEC, SPRM_C_PIC_LOCATION, SPRM_C_KUL,
  SPRM_P_JC80, SPRM_P_DYA_BEFORE, SPRM_P_DYA_AFTER,
  SPRM_P_DXA_LEFT, SPRM_P_DXA_RIGHT, SPRM_P_DXA_LEFT1,
  DOC_COLORS,
} from './types.ts';

function readU16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}

function readU32(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

function readI32(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
}

// --- FIB parsing ---

function parseFib(wordDoc: Uint8Array): FibFields {
  if (wordDoc.length < 0x200) throw new Error('Invalid DOC: WordDocument too short');
  const wIdent = readU16(wordDoc, 0);
  if (wIdent !== 0xA5EC) throw new Error(`Invalid DOC: bad wIdent 0x${wIdent.toString(16)}`);
  const nFib = readU16(wordDoc, 2);
  if (nFib < 0x00C1 && nFib !== 0x0065 && nFib !== 0x0067) {
    throw new Error(`Unsupported DOC version: nFib=0x${nFib.toString(16)}`);
  }

  const flags = readU16(wordDoc, 0x000A);
  const fWhichTblStm = (flags & 0x0200) !== 0;

  // FibRgLw97 — ccpText at fixed offset
  const ccpText = readU32(wordDoc, 0x004C);

  // FibRgFcLcb97 — fc/lcb pairs at fixed offsets
  return {
    fWhichTblStm,
    ccpText,
    fcClx: readU32(wordDoc, 0x01A2),
    lcbClx: readU32(wordDoc, 0x01A6),
    fcPlcfBteChpx: readU32(wordDoc, 0x00FA),
    lcbPlcfBteChpx: readU32(wordDoc, 0x00FE),
    fcPlcfBtePapx: readU32(wordDoc, 0x0102),
    lcbPlcfBtePapx: readU32(wordDoc, 0x0106),
    fcDggInfo: readU32(wordDoc, 0x01EA),
    lcbDggInfo: readU32(wordDoc, 0x01EE),
    fcPlcSpaMom: readU32(wordDoc, 0x01DA),
    lcbPlcSpaMom: readU32(wordDoc, 0x01DE),
  };
}

// --- Piece table ---

function parsePieceTable(tableStream: Uint8Array, fib: FibFields): PieceDescriptor[] {
  if (fib.lcbClx === 0) throw new Error('Invalid DOC: no CLX');
  let pos = fib.fcClx;
  const end = pos + fib.lcbClx;
  if (end > tableStream.length) throw new Error('Invalid DOC: CLX out of bounds');

  // Skip Prc entries (type 0x01)
  while (pos < end && tableStream[pos] === 0x01) {
    const cbGrpprl = readU16(tableStream, pos + 1);
    pos += 3 + cbGrpprl;
  }

  // Expect Pcdt (type 0x02)
  if (pos >= end || tableStream[pos] !== 0x02) {
    throw new Error('Invalid DOC: no Pcdt in CLX');
  }
  pos++;
  const lcb = readU32(tableStream, pos);
  pos += 4;

  // PlcPcd: n = (lcb - 4) / 12
  const n = Math.floor((lcb - 4) / 12);
  if (n <= 0) throw new Error('Invalid DOC: empty piece table');

  const pieces: PieceDescriptor[] = [];
  const cpBase = pos;
  const pdBase = cpBase + (n + 1) * 4;

  for (let i = 0; i < n; i++) {
    const cpStart = readU32(tableStream, cpBase + i * 4);
    const cpEnd = readU32(tableStream, cpBase + (i + 1) * 4);
    // Piece descriptor: 2 byte flags, 4 byte fc, 2 byte prm
    const fcRaw = readU32(tableStream, pdBase + i * 8 + 2);
    const isAnsi = (fcRaw & 0x40000000) !== 0;
    const fc = isAnsi ? (fcRaw & 0x3FFFFFFF) : fcRaw;
    pieces.push({ cpStart, cpEnd, fc, isAnsi });
  }

  return pieces;
}

// --- Text extraction ---

function extractText(wordDoc: Uint8Array, pieces: PieceDescriptor[], ccpText: number): string {
  let text = '';
  let totalCp = 0;

  for (const piece of pieces) {
    const cpCount = piece.cpEnd - piece.cpStart;
    const remaining = ccpText - totalCp;
    if (remaining <= 0) break;
    const count = Math.min(cpCount, remaining);

    if (piece.isAnsi) {
      const byteOff = piece.fc;
      for (let i = 0; i < count; i++) {
        const idx = byteOff + i;
        text += idx < wordDoc.length ? String.fromCharCode(wordDoc[idx]) : '\x00';
      }
    } else {
      const byteOff = piece.fc;
      for (let i = 0; i < count; i++) {
        const idx = byteOff + i * 2;
        text += idx + 1 < wordDoc.length ? String.fromCharCode(readU16(wordDoc, idx)) : '\x00';
      }
    }
    totalCp += count;
  }

  return text;
}

// --- FC ↔ CP mapping ---

function fcToCp(fc: number, pieces: PieceDescriptor[]): number {
  for (const p of pieces) {
    const bytesPerChar = p.isAnsi ? 1 : 2;
    const pieceByteLen = (p.cpEnd - p.cpStart) * bytesPerChar;
    if (fc >= p.fc && fc < p.fc + pieceByteLen) {
      return p.cpStart + (fc - p.fc) / bytesPerChar;
    }
  }
  return -1;
}

// --- Sprm parsing ---

function sprmOperandSize(opcode: number): number {
  const spra = (opcode >> 13) & 0x7;
  switch (spra) {
    case 0: case 1: return 1;
    case 2: case 4: case 5: return 2;
    case 3: return 4;
    case 7: return 3;
    case 6: return -1; // variable
    default: return 1;
  }
}

function parseSprms(grpprl: Uint8Array, offset: number, len: number, charResult?: CharProps, paraResult?: ParaProps): void {
  let pos = offset;
  const end = offset + len;

  while (pos + 2 <= end) {
    const opcode = readU16(grpprl, pos);
    pos += 2;
    if (opcode === 0) break;

    let operandSize = sprmOperandSize(opcode);
    if (operandSize === -1) {
      // Variable length: next byte is size
      if (pos >= end) break;
      operandSize = grpprl[pos];
      pos++;
    }
    if (pos + operandSize > end) break;

    if (charResult) {
      switch (opcode) {
        case SPRM_C_FBOLD:
          charResult.bold = grpprl[pos] !== 0;
          break;
        case SPRM_C_FITALIC:
          charResult.italic = grpprl[pos] !== 0;
          break;
        case SPRM_C_HPS:
          charResult.fontSize = readU16(grpprl, pos) / 2;
          break;
        case SPRM_C_ICO:
          charResult.colorIndex = grpprl[pos];
          break;
        case SPRM_C_FSPEC:
          charResult.isSpecial = grpprl[pos] !== 0;
          break;
        case SPRM_C_PIC_LOCATION:
          charResult.picLocation = readI32(grpprl, pos);
          break;
        case SPRM_C_KUL:
          charResult.underline = grpprl[pos] !== 0;
          break;
      }
    }

    if (paraResult) {
      switch (opcode) {
        case SPRM_P_JC80:
          paraResult.alignment = grpprl[pos] & 0x03;
          break;
        case SPRM_P_DYA_BEFORE:
          paraResult.spaceBefore = readU16(grpprl, pos);
          break;
        case SPRM_P_DYA_AFTER:
          paraResult.spaceAfter = readU16(grpprl, pos);
          break;
        case SPRM_P_DXA_LEFT:
          paraResult.indentLeft = readU16(grpprl, pos);
          break;
        case SPRM_P_DXA_RIGHT:
          paraResult.indentRight = readU16(grpprl, pos);
          break;
        case SPRM_P_DXA_LEFT1:
          paraResult.indentFirstLine = readI32(grpprl, pos) >> 16; // actually i16
          break;
      }
    }

    pos += operandSize;
  }
}

// --- Character properties ---

function parseCharProperties(tableStream: Uint8Array, wordDoc: Uint8Array, fib: FibFields, pieces: PieceDescriptor[]): CharProps[] {
  if (fib.lcbPlcfBteChpx === 0) return [];
  const results: CharProps[] = [];

  const plcBase = fib.fcPlcfBteChpx;
  const n = Math.floor((fib.lcbPlcfBteChpx - 4) / 8);
  if (n <= 0) return [];

  // FC values
  const fcValues: number[] = [];
  for (let i = 0; i <= n; i++) {
    fcValues.push(readU32(tableStream, plcBase + i * 4));
  }
  // Page numbers (u32 each, after FC values)
  const pnBase = plcBase + (n + 1) * 4;

  for (let i = 0; i < n; i++) {
    const pn = readU32(tableStream, pnBase + i * 4);
    const fkpOff = pn * 512;
    if (fkpOff + 512 > wordDoc.length) continue;

    const crun = wordDoc[fkpOff + 511];
    for (let r = 0; r < crun; r++) {
      const fcStart = readU32(wordDoc, fkpOff + r * 4);
      const fcEnd = readU32(wordDoc, fkpOff + (r + 1) * 4);
      const chpxOffset = wordDoc[fkpOff + (crun + 1) * 4 + r];

      const cp: CharProps = {
        cpStart: 0, cpEnd: 0,
        bold: false, italic: false, fontSize: 12,
        colorIndex: 0, underline: false,
        isSpecial: false, picLocation: -1,
      };

      if (chpxOffset !== 0) {
        const chpxPos = fkpOff + chpxOffset * 2;
        if (chpxPos < fkpOff + 512) {
          const cb = wordDoc[chpxPos];
          if (cb > 0 && chpxPos + 1 + cb <= fkpOff + 512) {
            parseSprms(wordDoc, chpxPos + 1, cb, cp, undefined);
          }
        }
      }

      // Map FC range to CP range
      const cpStart = fcToCp(fcStart, pieces);
      const cpEnd = fcToCp(fcEnd, pieces);
      if (cpStart < 0 || cpEnd < 0) continue;
      cp.cpStart = cpStart;
      cp.cpEnd = Math.max(cpEnd, cpStart + 1);
      results.push(cp);
    }
  }

  return results;
}

// --- Paragraph properties ---

function parseParaProperties(tableStream: Uint8Array, wordDoc: Uint8Array, fib: FibFields, pieces: PieceDescriptor[]): ParaProps[] {
  if (fib.lcbPlcfBtePapx === 0) return [];
  const results: ParaProps[] = [];

  const plcBase = fib.fcPlcfBtePapx;
  const n = Math.floor((fib.lcbPlcfBtePapx - 4) / 8);
  if (n <= 0) return [];

  const fcValues: number[] = [];
  for (let i = 0; i <= n; i++) {
    fcValues.push(readU32(tableStream, plcBase + i * 4));
  }
  const pnBase = plcBase + (n + 1) * 4;

  for (let i = 0; i < n; i++) {
    const pn = readU32(tableStream, pnBase + i * 4);
    const fkpOff = pn * 512;
    if (fkpOff + 512 > wordDoc.length) continue;

    const crun = wordDoc[fkpOff + 511];
    for (let r = 0; r < crun; r++) {
      const fcStart = readU32(wordDoc, fkpOff + r * 4);
      const fcEnd = readU32(wordDoc, fkpOff + (r + 1) * 4);
      // PAPX: BX entry is 13 bytes (1 byte offset + 12 bytes PHE)
      const bxOff = fkpOff + (crun + 1) * 4 + r * 13;
      if (bxOff >= fkpOff + 512) continue;
      const papxOffset = wordDoc[bxOff];

      const pp: ParaProps = {
        cpStart: 0, cpEnd: 0,
        alignment: 0, spaceBefore: 0, spaceAfter: 0,
        indentLeft: 0, indentRight: 0, indentFirstLine: 0,
      };

      if (papxOffset !== 0) {
        const papxPos = fkpOff + papxOffset * 2;
        if (papxPos < fkpOff + 512) {
          let cb2 = wordDoc[papxPos];
          let grpprlOff: number;
          if (cb2 === 0) {
            // cb2 is 0: next byte is actual cb, then 2 byte istd, then sprms
            const cb = wordDoc[papxPos + 1];
            grpprlOff = papxPos + 4; // skip cb2(1) + cb(1) + istd(2)
            const grpprlLen = cb > 2 ? cb * 2 - 2 - 2 : 0; // cb is in words; subtract istd
            if (grpprlLen > 0 && grpprlOff + grpprlLen <= fkpOff + 512) {
              parseSprms(wordDoc, grpprlOff, grpprlLen, undefined, pp);
            }
          } else {
            // cb2 is count of bytes (including istd)
            grpprlOff = papxPos + 1 + 2; // skip cb2(1) + istd(2)
            const grpprlLen = cb2 > 2 ? (cb2 * 2) - 2 : 0;
            if (grpprlLen > 0 && grpprlOff + grpprlLen <= fkpOff + 512) {
              parseSprms(wordDoc, grpprlOff, grpprlLen, undefined, pp);
            }
          }
        }
      }

      const cpStart = fcToCp(fcStart, pieces);
      const cpEnd = fcToCp(fcEnd, pieces);
      if (cpStart < 0 || cpEnd < 0) continue;
      pp.cpStart = cpStart;
      pp.cpEnd = Math.max(cpEnd, cpStart + 1);
      results.push(pp);
    }
  }

  return results;
}

// --- Inline images ---

function extractInlineImages(
  dataStream: Uint8Array | null,
  charProps: CharProps[],
  text: string,
): Map<string, Uint8Array> {
  const images = new Map<string, Uint8Array>();
  if (!dataStream) return images;

  let imgIdx = 0;
  for (const cp of charProps) {
    if (!cp.isSpecial || cp.picLocation < 0) continue;
    for (let c = cp.cpStart; c < cp.cpEnd && c < text.length; c++) {
      if (text.charCodeAt(c) !== 0x01) continue;

      try {
        const pic = extractBlipFromPicf(dataStream, cp.picLocation);
        if (pic) {
          images.set(`doc-img-${imgIdx}`, pic);
          imgIdx++;
        }
      } catch {
        // Skip corrupted images
      }
    }
  }
  return images;
}

function extractBlipFromPicf(dataStream: Uint8Array, offset: number): Uint8Array | null {
  if (offset + 4 > dataStream.length) return null;
  const lcb = readU32(dataStream, offset);
  if (lcb < 4 || offset + lcb > dataStream.length) return null;

  const cbHeader = readU16(dataStream, offset + 2);
  let pos = offset + cbHeader;
  const end = offset + lcb;

  return findBlipInRecords(dataStream, pos, end);
}

function findBlipInRecords(data: Uint8Array, pos: number, end: number): Uint8Array | null {
  while (pos + 8 <= end) {
    const verInst = readU16(data, pos);
    const type = readU16(data, pos + 2);
    const len = readU32(data, pos + 4);
    const ver = verInst & 0xF;
    pos += 8;

    if (pos + len > end + 8) break;

    if (ver === 0xF) {
      // Container — descend
      const result = findBlipInRecords(data, pos, pos + len);
      if (result) return result;
    } else if (type === 0xF01D || type === 0xF01B) {
      // JPEG BLIP
      const inst = (verInst >> 4) & 0xFFF;
      const uidSize = (inst === 0x46B || inst === 0x6E3) ? 32 : 16;
      const skip = uidSize + 1; // UIDs + tag byte
      if (pos + skip < pos + len) {
        return data.slice(pos + skip, pos + len);
      }
    } else if (type === 0xF01E || type === 0xF01C) {
      // PNG BLIP
      const inst = (verInst >> 4) & 0xFFF;
      const uidSize = (inst === 0x6E1 || inst === 0x6E0) ? 32 : 16;
      const skip = uidSize + 1;
      if (pos + skip < pos + len) {
        return data.slice(pos + skip, pos + len);
      }
    }

    pos += len;
  }
  return null;
}

// --- Floating images (best-effort) ---

function extractFloatingImages(
  tableStream: Uint8Array,
  fib: FibFields,
): { floats: DocxFloatingImage[]; floatImages: Map<string, Uint8Array> } {
  const floats: DocxFloatingImage[] = [];
  const floatImages = new Map<string, Uint8Array>();

  try {
    if (fib.lcbDggInfo === 0) return { floats, floatImages };

    // Extract blips from OfficeArt DggContainer
    const blips: Uint8Array[] = [];
    const dggStart = fib.fcDggInfo;
    const dggEnd = dggStart + fib.lcbDggInfo;
    if (dggEnd <= tableStream.length) {
      collectBlips(tableStream, dggStart, dggEnd, blips);
    }

    if (blips.length === 0 || fib.lcbPlcSpaMom === 0) return { floats, floatImages };

    // Parse PlcfSpa
    const spaBase = fib.fcPlcSpaMom;
    const spaEnd = spaBase + fib.lcbPlcSpaMom;
    if (spaEnd > tableStream.length) return { floats, floatImages };

    const n = Math.floor((fib.lcbPlcSpaMom - 4) / 30); // (n+1)*4 CPs + n*26 SPAs = lcb
    if (n <= 0) return { floats, floatImages };

    for (let i = 0; i < n && i < blips.length; i++) {
      const spaOff = spaBase + (n + 1) * 4 + i * 26;
      if (spaOff + 26 > spaEnd) break;

      const left = readI32(tableStream, spaOff + 6) / 20;
      const top = readI32(tableStream, spaOff + 10) / 20;
      const right = readI32(tableStream, spaOff + 14) / 20;
      const bottom = readI32(tableStream, spaOff + 18) / 20;

      const rId = `doc-float-${i}`;
      floatImages.set(rId, blips[i]);
      floats.push({
        rId,
        widthPt: Math.abs(right - left),
        heightPt: Math.abs(bottom - top),
        x: left,
        y: top,
        wrapMode: 'none',
      });
    }
  } catch {
    // Degrade gracefully
  }

  return { floats, floatImages };
}

function collectBlips(data: Uint8Array, pos: number, end: number, blips: Uint8Array[]): void {
  while (pos + 8 <= end) {
    const verInst = readU16(data, pos);
    const type = readU16(data, pos + 2);
    const len = readU32(data, pos + 4);
    const ver = verInst & 0xF;
    pos += 8;

    if (pos + len > end) break;

    if (ver === 0xF) {
      collectBlips(data, pos, pos + len, blips);
    } else if (type >= 0xF018 && type <= 0xF01F) {
      // BLIP record — extract raw image data
      const inst = (verInst >> 4) & 0xFFF;
      let uidSize = 16;
      // 2-UID variants
      if (type === 0xF01B && (inst === 0x46B || inst === 0x6E3)) uidSize = 32;
      if (type === 0xF01D && (inst === 0x46B || inst === 0x6E3)) uidSize = 32;
      if (type === 0xF01C && (inst === 0x6E1 || inst === 0x6E0)) uidSize = 32;
      if (type === 0xF01E && (inst === 0x6E1 || inst === 0x6E0)) uidSize = 32;

      const skip = uidSize + 1;
      if (skip < len) {
        blips.push(data.slice(pos + skip, pos + len));
      }
    }

    pos += len;
  }
}

// --- Model assembly ---

function buildDocxDocument(
  text: string,
  charPropsArr: CharProps[],
  paraPropsArr: ParaProps[],
  inlineImages: Map<string, Uint8Array>,
  floatingResult: { floats: DocxFloatingImage[]; floatImages: Map<string, Uint8Array> },
): { doc: DocxDocument; floats: DocxFloatingImage[] } {
  const paragraphs: DocxParagraph[] = [];
  const allImages = new Map(inlineImages);
  for (const [k, v] of floatingResult.floatImages) allImages.set(k, v);

  // Split text into paragraphs on 0x0D
  let paraStart = 0;
  let imgIdx = 0;

  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 0x0D) {
      const paraEnd = i;
      const paraText = text.substring(paraStart, paraEnd);

      // Find matching ParaProps
      const pp = findParaProps(paraPropsArr, paraStart, paraEnd);
      const alignment = (['left', 'center', 'right', 'justify'] as const)[pp.alignment & 3] ?? 'left';

      const props: DocxParagraphProps = {
        ...DEFAULT_PARA_PROPS,
        alignment,
        spaceBefore: pp.spaceBefore / 20,
        spaceAfter: pp.spaceAfter / 20 || DEFAULT_PARA_PROPS.spaceAfter,
        indentLeft: pp.indentLeft / 20,
        indentRight: pp.indentRight / 20,
        indentFirstLine: pp.indentFirstLine / 20,
      };

      // Build runs
      const runs: DocxRun[] = [];
      let runStart = paraStart;

      for (let c = paraStart; c < paraEnd; c++) {
        const ch = text.charCodeAt(c);
        const cp = findCharProps(charPropsArr, c);

        if (ch === 0x01 && cp.isSpecial && cp.picLocation >= 0) {
          // Flush any text before this
          if (c > runStart) {
            runs.push(...makeTextRuns(text, runStart, c, charPropsArr));
          }
          // Image run
          const rId = `doc-img-${imgIdx}`;
          if (allImages.has(rId)) {
            const image: DocxInlineImage = { rId, widthPt: 100, heightPt: 100 };
            runs.push({
              type: 'image',
              text: '',
              props: { ...DEFAULT_RUN_PROPS },
              image,
            });
          }
          imgIdx++;
          runStart = c + 1;
        }
      }

      // Flush remaining text
      if (paraEnd > runStart) {
        runs.push(...makeTextRuns(text, runStart, paraEnd, charPropsArr));
      }

      // If empty paragraph, add empty text run
      if (runs.length === 0) {
        runs.push({ type: 'text', text: '', props: { ...DEFAULT_RUN_PROPS } });
      }

      paragraphs.push({ type: 'paragraph', props, runs });
      paraStart = i + 1;
    }
  }

  const body: DocxBlock[] = paragraphs;

  const doc: DocxDocument = {
    body,
    styles: new Map(),
    defaults: DEFAULT_PARA_PROPS,
    defaultRunProps: DEFAULT_RUN_PROPS,
    relationships: new Map(),
    images: allImages,
    pageWidth: 612,
    pageHeight: 792,
    marginTop: 72,
    marginBottom: 72,
    marginLeft: 72,
    marginRight: 72,
  };

  return { doc, floats: floatingResult.floats };
}

function findParaProps(paraPropsArr: ParaProps[], cpStart: number, cpEnd: number): ParaProps {
  for (const pp of paraPropsArr) {
    if (pp.cpStart <= cpStart && pp.cpEnd > cpStart) return pp;
  }
  return { cpStart, cpEnd, alignment: 0, spaceBefore: 0, spaceAfter: 0, indentLeft: 0, indentRight: 0, indentFirstLine: 0 };
}

function findCharProps(charPropsArr: CharProps[], cp: number): CharProps {
  for (const cp2 of charPropsArr) {
    if (cp2.cpStart <= cp && cp2.cpEnd > cp) return cp2;
  }
  return { cpStart: cp, cpEnd: cp + 1, bold: false, italic: false, fontSize: 12, colorIndex: 0, underline: false, isSpecial: false, picLocation: -1 };
}

function makeTextRuns(text: string, start: number, end: number, charPropsArr: CharProps[]): DocxRun[] {
  const runs: DocxRun[] = [];
  let currentProps: CharProps | null = null;
  let runText = '';

  for (let c = start; c < end; c++) {
    const ch = text.charCodeAt(c);
    // Skip special chars
    if (ch === 0x08 || ch === 0x07) continue;
    const cp = findCharProps(charPropsArr, c);

    if (currentProps && propsMatch(currentProps, cp)) {
      runText += ch === 0x09 ? '\t' : String.fromCodePoint(ch);
    } else {
      if (runText.length > 0 && currentProps) {
        runs.push({ type: 'text', text: runText, props: toRunProps(currentProps) });
      }
      currentProps = cp;
      runText = ch === 0x09 ? '\t' : String.fromCodePoint(ch);
    }
  }

  if (runText.length > 0 && currentProps) {
    runs.push({ type: 'text', text: runText, props: toRunProps(currentProps) });
  }

  return runs;
}

function propsMatch(a: CharProps, b: CharProps): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.fontSize === b.fontSize &&
         a.colorIndex === b.colorIndex && a.underline === b.underline;
}

function toRunProps(cp: CharProps): DocxRunProps {
  return {
    fontSize: cp.fontSize || 12,
    bold: cp.bold,
    italic: cp.italic,
    underline: cp.underline,
    color: cp.colorIndex > 0 && cp.colorIndex < DOC_COLORS.length ? (DOC_COLORS[cp.colorIndex] ?? null) : null,
    styleId: null,
  };
}

// --- Main entry ---

export function decodeDoc(data: Uint8Array): PixelGrid {
  const streams = extractOle2Streams(data);
  const wordDoc = streams.get('WordDocument');
  if (!wordDoc) throw new Error('Invalid DOC: no WordDocument stream');

  const fib = parseFib(wordDoc);
  const tableName = fib.fWhichTblStm ? '1Table' : '0Table';
  const tableStream = streams.get(tableName);
  if (!tableStream) throw new Error(`Invalid DOC: no ${tableName} stream`);

  const dataStream = streams.get('Data') ?? null;
  const pieces = parsePieceTable(tableStream, fib);
  const text = extractText(wordDoc, pieces, fib.ccpText);
  const charProps = parseCharProperties(tableStream, wordDoc, fib, pieces);
  const paraProps = parseParaProperties(tableStream, wordDoc, fib, pieces);
  const inlineImages = extractInlineImages(dataStream, charProps, text);
  const floatingResult = extractFloatingImages(tableStream, fib);

  const { doc, floats } = buildDocxDocument(text, charProps, paraProps, inlineImages, floatingResult);
  return renderDocumentToPixels(doc, floats);
}
