import type { PixelGrid } from '../../types.ts';
import { extractOle2Streams } from '../xls/ole2.ts';
import { renderSlideToPixels } from '../pptx/decoder.ts';
import type { PptxSlide, PptxShape, PptxTextShape, PptxPictureShape, PptxParagraph, PptxRun } from '../pptx/types.ts';
import type { PptRecord, PptShapeInfo } from './types.ts';
import {
  RT_DOCUMENT, RT_DOCUMENT_ATOM, RT_SLIDE, RT_DRAWING,
  RT_SLIDE_LIST_WITH_TEXT, RT_SLIDE_PERSIST_ATOM,
  RT_TEXT_HEADER_ATOM, RT_TEXT_CHARS_ATOM, RT_TEXT_BYTES_ATOM,
  RT_STYLE_TEXT_PROP_ATOM,
  ESCHER_DG_CONTAINER, ESCHER_SPGR_CONTAINER, ESCHER_SP_CONTAINER,
  ESCHER_FSP, ESCHER_FOPT, ESCHER_CLIENT_ANCHOR, ESCHER_CLIENT_TEXTBOX,
  FOPT_PIC_ID, FOPT_FILL_COLOR,
} from './types.ts';

function readU16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}

function readU32(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

function readI16(buf: Uint8Array, off: number): number {
  const v = buf[off] | (buf[off + 1] << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}

function readI32(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
}

// --- Record tree parser ---

function parseRecords(data: Uint8Array, start: number, end: number): PptRecord[] {
  const records: PptRecord[] = [];
  let pos = start;

  while (pos + 8 <= end) {
    const verInst = readU16(data, pos);
    const recType = readU16(data, pos + 2);
    const recLen = readU32(data, pos + 4);
    const recVer = verInst & 0xF;
    const recInstance = (verInst >> 4) & 0xFFF;

    pos += 8;
    const dataEnd = Math.min(pos + recLen, end);

    const rec: PptRecord = { recVer, recInstance, recType, recLen, offset: pos };

    if (recVer === 0xF) {
      // Container — recurse
      rec.children = parseRecords(data, pos, dataEnd);
    }

    records.push(rec);
    pos = dataEnd;
  }

  return records;
}

function findRecord(records: PptRecord[], type: number): PptRecord | null {
  for (const r of records) {
    if (r.recType === type) return r;
  }
  return null;
}

function findRecords(records: PptRecord[], type: number): PptRecord[] {
  return records.filter(r => r.recType === type);
}

// --- Slide dimensions ---

function parseSlideDimensions(data: Uint8Array, docRecord: PptRecord): { width: number; height: number } {
  const atom = findRecord(docRecord.children ?? [], RT_DOCUMENT_ATOM);
  if (atom && atom.recLen >= 8) {
    const sx = readI32(data, atom.offset);
    const sy = readI32(data, atom.offset + 4);
    return { width: sx / 8, height: sy / 8 };
  }
  return { width: 720, height: 540 };
}

// --- Escher shape parsing ---

function parseEscherShapes(data: Uint8Array, drawingRecord: PptRecord): PptShapeInfo[] {
  const shapes: PptShapeInfo[] = [];
  const children = drawingRecord.children ?? [];

  // Find OfficeArtDgContainer
  const dgContainer = findRecord(children, ESCHER_DG_CONTAINER);
  if (!dgContainer?.children) return shapes;

  // Find OfficeArtSpgrContainer
  const spgrContainer = findRecord(dgContainer.children, ESCHER_SPGR_CONTAINER);
  if (!spgrContainer?.children) return shapes;

  // Each SpContainer is a shape
  for (const spContainer of findRecords(spgrContainer.children, ESCHER_SP_CONTAINER)) {
    const info = parseSpContainer(data, spContainer);
    if (info) shapes.push(info);
  }

  return shapes;
}

function parseSpContainer(data: Uint8Array, container: PptRecord): PptShapeInfo | null {
  const children = container.children ?? [];

  let shapeType = 0;
  let anchor: PptShapeInfo['anchor'] = null;
  const foptProps = new Map<number, number>();
  const textboxRecords: PptRecord[] = [];

  for (const child of children) {
    switch (child.recType) {
      case ESCHER_FSP:
        shapeType = child.recInstance;
        break;

      case ESCHER_CLIENT_ANCHOR:
        anchor = parseClientAnchor(data, child);
        break;

      case ESCHER_FOPT:
        parseFopt(data, child, foptProps);
        break;

      case ESCHER_CLIENT_TEXTBOX:
        if (child.children) {
          textboxRecords.push(...child.children);
        } else {
          // Parse atoms inside ClientTextbox data range
          const tbRecords = parseRecords(data, child.offset, child.offset + child.recLen);
          textboxRecords.push(...tbRecords);
        }
        break;
    }
  }

  return { anchor, shapeType, foptProps, textboxRecords };
}

function parseClientAnchor(data: Uint8Array, rec: PptRecord): PptShapeInfo['anchor'] {
  const off = rec.offset;
  if (rec.recLen >= 16) {
    // Large rect (i32)
    const top = readI32(data, off);
    const left = readI32(data, off + 4);
    const right = readI32(data, off + 8);
    const bottom = readI32(data, off + 12);
    return {
      x: left / 8,
      y: top / 8,
      width: (right - left) / 8,
      height: (bottom - top) / 8,
    };
  } else if (rec.recLen >= 8) {
    // Small rect (i16)
    const top = readI16(data, off);
    const left = readI16(data, off + 2);
    const right = readI16(data, off + 4);
    const bottom = readI16(data, off + 6);
    return {
      x: left / 8,
      y: top / 8,
      width: (right - left) / 8,
      height: (bottom - top) / 8,
    };
  }
  return null;
}

function parseFopt(data: Uint8Array, rec: PptRecord, props: Map<number, number>): void {
  const count = rec.recInstance;
  let pos = rec.offset;
  const end = rec.offset + rec.recLen;

  // First pass: read simple properties (6 bytes each)
  for (let i = 0; i < count && pos + 6 <= end; i++) {
    const propId = readU16(data, pos);
    const value = readU32(data, pos + 2);
    const isComplex = (propId & 0x4000) !== 0;
    const id = propId & 0x3FFF;
    if (!isComplex) {
      props.set(id, value);
    }
    pos += 6;
  }
  // Complex data area follows simple entries — skipped
}

// --- Text extraction from ClientTextbox ---

interface TextBlock {
  textType: number; // 0=title, 1=body, 5=center body, 6=center title
  text: string;
  paraRuns: ParaRun[];
  charRuns: CharRun[];
}

interface ParaRun {
  charCount: number;
  alignment: number; // 0=left, 1=center, 2=right, 3=justify
}

interface CharRun {
  charCount: number;
  bold: boolean;
  italic: boolean;
  fontSize: number;
  color: string | null;
}

function extractTextBlocks(data: Uint8Array, records: PptRecord[]): TextBlock[] {
  const blocks: TextBlock[] = [];
  let i = 0;

  while (i < records.length) {
    const rec = records[i];
    if (rec.recType === RT_TEXT_HEADER_ATOM && rec.recLen >= 4) {
      const textType = readU32(data, rec.offset);
      let text = '';
      const paraRuns: ParaRun[] = [];
      const charRuns: CharRun[] = [];

      // Next record should be text
      if (i + 1 < records.length) {
        const textRec = records[i + 1];
        if (textRec.recType === RT_TEXT_CHARS_ATOM) {
          text = readUtf16(data, textRec.offset, textRec.recLen);
          i += 2;
        } else if (textRec.recType === RT_TEXT_BYTES_ATOM) {
          text = readAnsi(data, textRec.offset, textRec.recLen);
          i += 2;
        } else {
          i++;
          blocks.push({ textType, text, paraRuns, charRuns });
          continue;
        }
      } else {
        i++;
        blocks.push({ textType, text, paraRuns, charRuns });
        continue;
      }

      // Check for StyleTextPropAtom
      if (i < records.length && records[i].recType === RT_STYLE_TEXT_PROP_ATOM) {
        try {
          parseStyleTextProps(data, records[i], text.length, paraRuns, charRuns);
        } catch {
          // Fall back to defaults
        }
        i++;
      }

      blocks.push({ textType, text, paraRuns, charRuns });
    } else {
      i++;
    }
  }

  return blocks;
}

function readUtf16(data: Uint8Array, offset: number, len: number): string {
  let s = '';
  const end = offset + len;
  for (let p = offset; p + 1 < end; p += 2) {
    s += String.fromCharCode(readU16(data, p));
  }
  return s;
}

function readAnsi(data: Uint8Array, offset: number, len: number): string {
  let s = '';
  const end = offset + len;
  for (let p = offset; p < end; p++) {
    s += String.fromCharCode(data[p]);
  }
  return s;
}

// --- StyleTextPropAtom parsing ---

function parseStyleTextProps(
  data: Uint8Array, rec: PptRecord, textLen: number,
  paraRuns: ParaRun[], charRuns: CharRun[],
): void {
  let pos = rec.offset;
  const end = rec.offset + rec.recLen;
  const targetCount = textLen + 1;

  // Paragraph runs
  let paraCharSum = 0;
  while (paraCharSum < targetCount && pos + 4 <= end) {
    const charCount = readU32(data, pos); pos += 4;
    if (pos + 2 > end) break;
    const indentLevel = readU16(data, pos); pos += 2;
    if (pos + 4 > end) break;
    const mask = readU32(data, pos); pos += 4;

    let alignment = 0;
    pos = skipParaMaskFields(data, pos, end, mask, (field, value) => {
      if (field === 'alignment') alignment = value;
    });

    paraRuns.push({ charCount, alignment });
    paraCharSum += charCount;
  }

  // Character runs
  let charCharSum = 0;
  while (charCharSum < targetCount && pos + 4 <= end) {
    const charCount = readU32(data, pos); pos += 4;
    if (pos + 4 > end) break;
    const mask = readU32(data, pos); pos += 4;

    let bold = false;
    let italic = false;
    let fontSize = 0;
    let color: string | null = null;

    // mask & 0x0001 → charFlags (u16)
    if (mask & 0x0001) {
      if (pos + 2 > end) break;
      const flags = readU16(data, pos); pos += 2;
      bold = (flags & 0x01) !== 0;
      italic = (flags & 0x02) !== 0;
    }
    // mask & 0x0002 → fontRef (u16)
    if (mask & 0x0002) {
      if (pos + 2 > end) break;
      pos += 2;
    }
    // mask & 0x0004 → oldEAFontRef (u16)
    if (mask & 0x0004) {
      if (pos + 2 > end) break;
      pos += 2;
    }
    // mask & 0x0008 → ansiFontRef (u16)
    if (mask & 0x0008) {
      if (pos + 2 > end) break;
      pos += 2;
    }
    // mask & 0x0010 → fontSize (u16)
    if (mask & 0x0010) {
      if (pos + 2 > end) break;
      fontSize = readU16(data, pos); pos += 2;
    }
    // mask & 0x0020 → color (u32)
    if (mask & 0x0020) {
      if (pos + 4 > end) break;
      const colorVal = readU32(data, pos); pos += 4;
      const isScheme = (colorVal & 0x01000000) !== 0;
      if (!isScheme) {
        const r = colorVal & 0xFF;
        const g = (colorVal >> 8) & 0xFF;
        const b = (colorVal >> 16) & 0xFF;
        color = r.toString(16).padStart(2, '0') +
                g.toString(16).padStart(2, '0') +
                b.toString(16).padStart(2, '0');
      }
    }
    // mask & 0x0040 → position (u16)
    if (mask & 0x0040) {
      if (pos + 2 > end) break;
      pos += 2;
    }

    charRuns.push({ charCount, bold, italic, fontSize, color });
    charCharSum += charCount;
  }
}

function skipParaMaskFields(
  data: Uint8Array, pos: number, end: number, mask: number,
  cb: (field: string, value: number) => void,
): number {
  // mask & 0x000F → bulletFlags (u16)
  if (mask & 0x000F) {
    if (pos + 2 > end) return pos;
    pos += 2;
  }
  // mask & 0x0080 → bulletChar (u16)
  if (mask & 0x0080) {
    if (pos + 2 > end) return pos;
    pos += 2;
  }
  // mask & 0x0010 → bulletFontRef (u16)
  if (mask & 0x0010) {
    if (pos + 2 > end) return pos;
    pos += 2;
  }
  // mask & 0x0040 → bulletSize (u16)
  if (mask & 0x0040) {
    if (pos + 2 > end) return pos;
    pos += 2;
  }
  // mask & 0x0020 → bulletColor (u32)
  if (mask & 0x0020) {
    if (pos + 4 > end) return pos;
    pos += 4;
  }
  // mask & 0x0800 → alignment (u16)
  if (mask & 0x0800) {
    if (pos + 2 > end) return pos;
    const v = readU16(data, pos); pos += 2;
    cb('alignment', v);
  }
  // mask & 0x1000 → lineSpacing (u16)
  if (mask & 0x1000) {
    if (pos + 2 > end) return pos;
    pos += 2;
  }
  // mask & 0x2000 → spaceBefore (u16)
  if (mask & 0x2000) {
    if (pos + 2 > end) return pos;
    pos += 2;
  }
  // mask & 0x4000 → spaceAfter (u16)
  if (mask & 0x4000) {
    if (pos + 2 > end) return pos;
    pos += 2;
  }
  // mask & 0x0100 → textDirection (u16)
  if (mask & 0x0100) {
    if (pos + 2 > end) return pos;
    pos += 2;
  }
  // mask & 0x0200
  if (mask & 0x0200) {
    if (pos + 2 > end) return pos;
    pos += 2;
  }
  // mask & 0x0400
  if (mask & 0x0400) {
    if (pos + 2 > end) return pos;
    pos += 2;
  }
  // mask & 0x8000 → leftMargin (u16)
  if (mask & 0x8000) {
    if (pos + 2 > end) return pos;
    pos += 2;
  }
  // mask & 0x10000 → indent (u16)
  if (mask & 0x10000) {
    if (pos + 2 > end) return pos;
    pos += 2;
  }
  // mask & 0x20000 → defaultTabSize (u16)
  if (mask & 0x20000) {
    if (pos + 2 > end) return pos;
    pos += 2;
  }
  // mask & 0xF0000 (bits 18-21) → tabStops (variable)
  // Actually tabStops is mask & 0x100000 — skip entire tab array
  if (mask & 0x100000) {
    if (pos + 2 > end) return pos;
    const tabCount = readU16(data, pos); pos += 2;
    pos += tabCount * 4; // each tab is 4 bytes
  }
  // mask & 0x200000 → fontAlign (u16)
  if (mask & 0x200000) {
    if (pos + 2 > end) return pos;
    pos += 2;
  }
  // mask & 0xC00000 (bits 22-23) → wrapFlags (u16)
  if (mask & 0x400000) {
    if (pos + 2 > end) return pos;
    pos += 2;
  }
  // mask & 0x2000000 → textDirection2 (u16)
  if (mask & 0x2000000) {
    if (pos + 2 > end) return pos;
    pos += 2;
  }

  return pos;
}

// --- SlideListWithText fallback ---

function parseSLwTTextBlocks(data: Uint8Array, docRecord: PptRecord): TextBlock[][] {
  const slides: TextBlock[][] = [];
  const slwtRecords = findRecords(docRecord.children ?? [], RT_SLIDE_LIST_WITH_TEXT);

  // Instance 0 = slide text
  const slideSlwt = slwtRecords.find(r => r.recInstance === 0);
  if (!slideSlwt?.children) return slides;

  let currentSlideBlocks: PptRecord[] = [];
  let slideCount = 0;

  for (const child of slideSlwt.children) {
    if (child.recType === RT_SLIDE_PERSIST_ATOM) {
      if (slideCount > 0) {
        slides.push(extractTextBlocks(data, currentSlideBlocks));
        currentSlideBlocks = [];
      }
      slideCount++;
    } else {
      currentSlideBlocks.push(child);
    }
  }
  // Push last slide
  if (currentSlideBlocks.length > 0) {
    slides.push(extractTextBlocks(data, currentSlideBlocks));
  }

  return slides;
}

// --- Pictures stream (BLIPs) ---

function extractBlips(picturesStream: Uint8Array): Uint8Array[] {
  const blips: Uint8Array[] = [];
  let pos = 0;
  const end = picturesStream.length;

  while (pos + 8 <= end) {
    const verInst = readU16(picturesStream, pos);
    const type = readU16(picturesStream, pos + 2);
    const len = readU32(picturesStream, pos + 4);
    pos += 8;

    if (pos + len > end) break;

    if (type >= 0xF018 && type <= 0xF01F) {
      const inst = (verInst >> 4) & 0xFFF;
      let uidSize = 16;
      // 2-UID variants
      if (type === 0xF01B && (inst === 0x46B || inst === 0x6E3)) uidSize = 32;
      if (type === 0xF01D && (inst === 0x46B || inst === 0x6E3)) uidSize = 32;
      if (type === 0xF01C && (inst === 0x6E1 || inst === 0x6E0)) uidSize = 32;
      if (type === 0xF01E && (inst === 0x6E1 || inst === 0x6E0)) uidSize = 32;

      const skip = uidSize + 1; // UIDs + tag byte
      if (skip < len) {
        blips.push(picturesStream.slice(pos + skip, pos + len));
      }
    }

    pos += len;
  }

  return blips;
}

// --- Model assembly ---

function buildSlideModel(
  shapes: PptShapeInfo[],
  slwtBlocks: TextBlock[],
  blips: Uint8Array[],
  slideWidth: number,
  slideHeight: number,
  data: Uint8Array,
): { slide: PptxSlide; images: Map<string, Uint8Array> } {
  const pptxShapes: PptxShape[] = [];
  const images = new Map<string, Uint8Array>();
  let imgIdx = 0;
  let textBlockIdx = 0;
  let background: string | null = null;

  for (let si = 0; si < shapes.length; si++) {
    const shape = shapes[si];
    if (!shape.anchor) continue;

    // First shape is often the group shape — check for background fill
    if (si === 0) {
      const fillColor = shape.foptProps.get(FOPT_FILL_COLOR);
      if (fillColor !== undefined) {
        const b = (fillColor >> 16) & 0xFF;
        const g = (fillColor >> 8) & 0xFF;
        const r = fillColor & 0xFF;
        background = r.toString(16).padStart(2, '0') +
                     g.toString(16).padStart(2, '0') +
                     b.toString(16).padStart(2, '0');
      }
    }

    const pib = shape.foptProps.get(FOPT_PIC_ID);
    if (pib !== undefined && pib > 0 && pib <= blips.length) {
      // Picture shape
      const rId = `ppt-img-${imgIdx}`;
      images.set(rId, blips[pib - 1]);
      imgIdx++;
      pptxShapes.push({
        type: 'picture',
        x: shape.anchor.x,
        y: shape.anchor.y,
        width: shape.anchor.width,
        height: shape.anchor.height,
        rId,
      } as PptxPictureShape);
      continue;
    }

    // Text shape — try ClientTextbox first, then SLwT fallback
    let textBlocks = extractTextBlocks(data, shape.textboxRecords);
    if (textBlocks.length === 0 && textBlockIdx < slwtBlocks.length) {
      textBlocks = [slwtBlocks[textBlockIdx]];
      textBlockIdx++;
    }

    if (textBlocks.length === 0) continue;

    const textShape = buildTextShape(shape, textBlocks);
    if (textShape) pptxShapes.push(textShape);
  }

  return {
    slide: { width: slideWidth, height: slideHeight, background, shapes: pptxShapes },
    images,
  };
}

function buildTextShape(shape: PptShapeInfo, textBlocks: TextBlock[]): PptxTextShape | null {
  if (!shape.anchor) return null;

  const paragraphs: PptxParagraph[] = [];
  let isTitle = false;
  let isCenterType = false;

  for (const block of textBlocks) {
    if (block.textType === 0 || block.textType === 6) isTitle = true;
    if (block.textType === 5 || block.textType === 6) isCenterType = true;

    const defaultFontSize = isTitle ? 44 : 18;
    const defaultAlign = (isTitle || isCenterType) ? 'center' as const : 'left' as const;

    // Split text into lines on \r or \n
    const lines = block.text.split(/\r|\n/);
    let charOffset = 0;

    for (const line of lines) {
      const runs: PptxRun[] = [];

      if (line.length === 0) {
        runs.push({ text: '', fontSize: defaultFontSize, bold: false, color: null, shadow: false });
      } else {
        // Apply character runs
        let linePos = 0;
        for (const cr of block.charRuns) {
          if (linePos >= line.length) break;
          const crStart = charOffset;
          const crEnd = charOffset; // charRuns are cumulative from the block start, not per-line
          // We need to map the char run to this line
        }

        // If we have char runs, map them
        if (block.charRuns.length > 0) {
          let globalPos = charOffset;
          let lineLocalPos = 0;

          for (const cr of block.charRuns) {
            if (lineLocalPos >= line.length) break;
            // How many chars of this run overlap with current line?
            // Char run covers [crGlobalStart, crGlobalStart + charCount)
            // We don't have crGlobalStart directly — charRuns are sequential
          }

          // Simpler approach: walk char runs with cumulative position
          runs.push(...mapCharRunsToLine(line, charOffset, block.charRuns, defaultFontSize));
        } else {
          runs.push({ text: line, fontSize: defaultFontSize, bold: false, color: null, shadow: false });
        }
      }

      // Find paragraph alignment
      let alignment: 'left' | 'center' | 'right' = defaultAlign;
      if (block.paraRuns.length > 0) {
        const paraRun = findParaRunAtOffset(charOffset, block.paraRuns);
        if (paraRun) {
          const aligns = ['left', 'center', 'right', 'left'] as const;
          alignment = aligns[paraRun.alignment & 3] ?? defaultAlign;
        }
      }

      paragraphs.push({ alignment, runs, spaceBefore: 0, spaceAfter: 0, bullet: null });
      charOffset += line.length + 1; // +1 for the delimiter
    }
  }

  // Skip if no actual text
  const hasText = paragraphs.some(p => p.runs.some(r => r.text.length > 0));
  if (!hasText) return null;

  const anchor = (isTitle || isCenterType) ? 'ctr' as const : 't' as const;

  return {
    type: 'text',
    x: shape.anchor.x,
    y: shape.anchor.y,
    width: shape.anchor.width,
    height: shape.anchor.height,
    fill: null,
    anchor,
    paragraphs,
  };
}

function mapCharRunsToLine(
  line: string, lineGlobalStart: number, charRuns: CharRun[], defaultFontSize: number,
): PptxRun[] {
  const runs: PptxRun[] = [];
  let crGlobalPos = 0;
  let lineLocalPos = 0;

  for (const cr of charRuns) {
    if (lineLocalPos >= line.length) break;

    const crGlobalEnd = crGlobalPos + cr.charCount;
    const lineGlobalEnd = lineGlobalStart + line.length;

    // Overlap between [crGlobalPos, crGlobalEnd) and [lineGlobalStart, lineGlobalEnd)
    const overlapStart = Math.max(crGlobalPos, lineGlobalStart);
    const overlapEnd = Math.min(crGlobalEnd, lineGlobalEnd);

    if (overlapStart < overlapEnd) {
      const localStart = overlapStart - lineGlobalStart;
      const localEnd = overlapEnd - lineGlobalStart;
      const text = line.substring(localStart, localEnd);

      if (text.length > 0) {
        runs.push({
          text,
          fontSize: cr.fontSize > 0 ? cr.fontSize : defaultFontSize,
          bold: cr.bold,
          color: cr.color,
          shadow: false,
        });
      }
      lineLocalPos = localEnd;
    }

    crGlobalPos = crGlobalEnd;
  }

  // If no char runs covered this line, emit default
  if (runs.length === 0 && line.length > 0) {
    runs.push({ text: line, fontSize: defaultFontSize, bold: false, color: null, shadow: false });
  }

  return runs;
}

function findParaRunAtOffset(offset: number, paraRuns: ParaRun[]): ParaRun | null {
  let pos = 0;
  for (const pr of paraRuns) {
    if (offset >= pos && offset < pos + pr.charCount) return pr;
    pos += pr.charCount;
  }
  return paraRuns[0] ?? null;
}

// --- Main entry ---

export function decodePpt(data: Uint8Array): PixelGrid {
  const streams = extractOle2Streams(data);
  const pptStream = streams.get('PowerPoint Document');
  if (!pptStream) throw new Error('Invalid PPT: no PowerPoint Document stream');

  const records = parseRecords(pptStream, 0, pptStream.length);

  // Find RT_Document
  const docRecord = findRecord(records, RT_DOCUMENT);
  if (!docRecord) throw new Error('Invalid PPT: no Document record');

  // Slide dimensions
  const { width: slideWidth, height: slideHeight } = parseSlideDimensions(pptStream, docRecord);

  // Find first RT_Slide
  const slideRecord = findRecord(records, RT_SLIDE);
  if (!slideRecord) throw new Error('Invalid PPT: no Slide record');

  // Parse Escher shapes from RT_Drawing
  const drawingRecord = findRecord(slideRecord.children ?? [], RT_DRAWING);
  const shapes = drawingRecord ? parseEscherShapes(pptStream, drawingRecord) : [];

  // Parse SLwT fallback text
  const slwtSlides = parseSLwTTextBlocks(pptStream, docRecord);
  const slwtBlocks = slwtSlides[0] ?? [];

  // Extract BLIPs from Pictures stream
  const picturesStream = streams.get('Pictures');
  const blips = picturesStream ? extractBlips(picturesStream) : [];

  // Build model and render
  const { slide, images } = buildSlideModel(
    shapes, slwtBlocks, blips, slideWidth, slideHeight, pptStream,
  );

  return renderSlideToPixels(slide, images);
}
