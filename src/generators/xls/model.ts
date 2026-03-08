// Parse BIFF8 records into XlsxWorkbook model

import type { BiffRecord } from './types.ts';
import type {
  XlsxWorkbook, XlsxSheet, XlsxCell, XlsxStyles, XlsxFont,
  XlsxFill, XlsxBorder, XlsxBorderEdge, XlsxCellXf, XlsxRow,
  XlsxMergeCell, XlsxColumn,
} from '../xlsx/types.ts';

// BIFF8 record types
const BOF = 0x0809;
const EOF_REC = 0x000A;
const SST = 0x00FC;
const BOUNDSHEET = 0x0085;
const XF = 0x00E0;
const FONT = 0x0031;
const FORMAT = 0x041E;
const PALETTE = 0x0092;
const LABELSST = 0x00FD;
const NUMBER = 0x0203;
const RK = 0x027E;
const MULRK = 0x00BD;
const BOOLERR = 0x0205;
const FORMULA = 0x0006;
const MERGEDCELLS = 0x00E5;
const DEFCOLWIDTH = 0x0055;
const DEFAULTROWHEIGHT = 0x0225;
const COLINFO = 0x007D;
const ROW_REC = 0x0208;

function readU16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}

function readI16(buf: Uint8Array, off: number): number {
  const v = buf[off] | (buf[off + 1] << 8);
  return v > 0x7FFF ? v - 0x10000 : v;
}

function readU32(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

function readI32(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
}

function readFloat64(buf: Uint8Array, off: number): number {
  const view = new DataView(buf.buffer, buf.byteOffset + off, 8);
  return view.getFloat64(0, true);
}

function decodeRk(raw: number): number {
  const isInt = (raw & 2) !== 0;
  const div100 = (raw & 1) !== 0;

  let result: number;
  if (isInt) {
    result = raw >> 2; // signed arithmetic shift
  } else {
    // Float64 with low 32 bits zeroed
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint32(0, 0, true);
    view.setUint32(4, raw & 0xFFFFFFFC, true);
    result = view.getFloat64(0, true);
  }

  if (div100) result /= 100;
  return result;
}

// Default color palette (indices 0x08-0x3F)
const DEFAULT_PALETTE: string[] = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];

// System colors (indices 0x00-0x07)
const SYSTEM_COLORS = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
];

function colorIndexToHex(idx: number, palette: string[]): string | null {
  if (idx >= 0x00 && idx <= 0x07) return SYSTEM_COLORS[idx];
  if (idx >= 0x08 && idx <= 0x3F) return palette[idx - 0x08] ?? null;
  if (idx === 0x40) return '000000'; // default foreground
  if (idx === 0x41) return 'FFFFFF'; // default background
  if (idx === 0x7FFF || idx === 0x40 || idx === 64) return '000000'; // auto
  return null;
}

// Read BIFF8 Unicode string
interface SstReadResult {
  value: string;
  bytesConsumed: number;
}

function readBiffString(buf: Uint8Array, off: number, continueBoundaries: number[]): SstReadResult {
  if (off + 3 > buf.length) return { value: '', bytesConsumed: 0 };

  const charCount = readU16(buf, off);
  const flags = buf[off + 2];
  const isUtf16 = (flags & 0x01) !== 0;
  const hasRichText = (flags & 0x08) !== 0;
  const hasExtSt = (flags & 0x04) !== 0;

  let pos = off + 3;
  let richRunCount = 0;
  let extStSize = 0;

  if (hasRichText) {
    richRunCount = readU16(buf, pos);
    pos += 2;
  }
  if (hasExtSt) {
    extStSize = readI32(buf, pos);
    pos += 4;
  }

  // Read character data, handling CONTINUE boundaries
  let result = '';
  let charsRead = 0;
  let currentIsUtf16 = isUtf16;

  // Create a set for O(1) boundary lookups
  const boundarySet = new Set(continueBoundaries);

  while (charsRead < charCount && pos < buf.length) {
    // Check for CONTINUE boundary — re-read encoding flag
    if (boundarySet.has(pos)) {
      currentIsUtf16 = (buf[pos] & 0x01) !== 0;
      pos++;
    }

    if (currentIsUtf16) {
      if (pos + 2 > buf.length) break;
      result += String.fromCharCode(readU16(buf, pos));
      pos += 2;
    } else {
      result += String.fromCharCode(buf[pos]);
      pos += 1;
    }
    charsRead++;

    // Check for CONTINUE boundary mid-character read
    if (charsRead < charCount && boundarySet.has(pos)) {
      currentIsUtf16 = (buf[pos] & 0x01) !== 0;
      pos++;
    }
  }

  // Skip rich text runs (4 bytes each)
  pos += richRunCount * 4;
  // Skip ext st data
  pos += extStSize;

  return { value: result, bytesConsumed: pos - off };
}

// Short string (used in BOUNDSHEET, etc.)
function readShortString(buf: Uint8Array, off: number): string {
  if (off + 2 > buf.length) return '';
  const charCount = buf[off];
  const flags = buf[off + 1];
  const isUtf16 = (flags & 0x01) !== 0;

  let pos = off + 2;
  // hasRichText/hasExtSt possible but rare in short strings
  const hasRichText = (flags & 0x08) !== 0;
  const hasExtSt = (flags & 0x04) !== 0;
  let richRunCount = 0;
  let extStSize = 0;
  if (hasRichText) { richRunCount = readU16(buf, pos); pos += 2; }
  if (hasExtSt) { extStSize = readI32(buf, pos); pos += 4; }

  let result = '';
  for (let i = 0; i < charCount && pos < buf.length; i++) {
    if (isUtf16) {
      result += String.fromCharCode(readU16(buf, pos));
      pos += 2;
    } else {
      result += String.fromCharCode(buf[pos]);
      pos += 1;
    }
  }

  return result;
}

function parseSst(rec: BiffRecord): string[] {
  const d = rec.data;
  if (d.length < 8) return [];

  const uniqueCount = readU32(d, 4);
  const strings: string[] = [];
  let pos = 8;

  for (let i = 0; i < uniqueCount && pos < d.length; i++) {
    const { value, bytesConsumed } = readBiffString(d, pos, rec.continueBoundaries);
    strings.push(value);
    pos += bytesConsumed;
  }

  return strings;
}

// Border style from nibble value
function borderStyleName(val: number): string | null {
  const styles = ['none', 'thin', 'medium', 'dashed', 'dotted', 'thick', 'double', 'hair',
    'mediumDashed', 'dashDot', 'mediumDashDot', 'dashDotDot', 'mediumDashDotDot', 'slantDashDot'];
  return styles[val] ?? null;
}

export function parseXlsModel(records: BiffRecord[]): XlsxWorkbook {
  const fonts: XlsxFont[] = [];
  const xfEntries: XlsxCellXf[] = [];
  const fills: XlsxFill[] = [];
  const borders: XlsxBorder[] = [];
  const numFmts = new Map<number, string>();
  let sharedStrings: string[] = [];
  const boundsheets: { offset: number; name: string }[] = [];
  let palette = [...DEFAULT_PALETTE];

  // Split records into sub-streams by BOF/EOF
  // First pass: find globals and collect global records
  let inGlobals = false;
  let depth = 0;

  for (const rec of records) {
    if (rec.type === BOF) {
      depth++;
      if (depth === 1) {
        const docType = rec.data.length >= 4 ? readU16(rec.data, 2) : 0;
        inGlobals = docType === 0x0005;
      }
      continue;
    }
    if (rec.type === EOF_REC) {
      if (depth === 1) inGlobals = false;
      depth--;
      continue;
    }

    if (!inGlobals || depth !== 1) continue;

    switch (rec.type) {
      case PALETTE: {
        const count = readU16(rec.data, 0);
        palette = [];
        for (let i = 0; i < count && 2 + i * 4 + 3 < rec.data.length; i++) {
          const off = 2 + i * 4;
          const r = rec.data[off].toString(16).padStart(2, '0');
          const g = rec.data[off + 1].toString(16).padStart(2, '0');
          const b = rec.data[off + 2].toString(16).padStart(2, '0');
          palette.push(r + g + b);
        }
        break;
      }

      case FONT: {
        const height = readU16(rec.data, 0);
        const flags = readU16(rec.data, 2);
        const colorIdx = readU16(rec.data, 4);
        const boldWeight = readU16(rec.data, 6);
        const size = height / 20;
        const bold = boldWeight >= 700 || (flags & 0x01) !== 0;
        const italic = (flags & 0x02) !== 0;
        const color = colorIndexToHex(colorIdx, palette);
        fonts.push({ size, bold, italic, color });
        // Font index 4 is skipped in BIFF8
        if (fonts.length === 4) {
          fonts.push({ size: 11, bold: false, italic: false, color: null });
        }
        break;
      }

      case FORMAT: {
        const fmtId = readU16(rec.data, 0);
        const fmtStr = readShortString(rec.data, 2);
        numFmts.set(fmtId, fmtStr);
        break;
      }

      case XF: {
        const d = rec.data;
        const fontId = readU16(d, 0);
        const numFmtId = readU16(d, 2);

        // Alignment from byte 6
        const alignByte = d.length > 6 ? d[6] : 0;
        const hAlignVal = alignByte & 0x07;
        const hAligns = ['general', 'left', 'center', 'right', 'fill', 'justify', 'centerContinuous', 'distributed'];
        const horizontal = hAligns[hAlignVal] ?? 'general';

        const vAlignByte = d.length > 6 ? (alignByte >> 4) & 0x07 : 0;
        const vAligns = ['top', 'center', 'bottom', 'justify', 'distributed'];
        const vertical = vAligns[vAlignByte] ?? 'bottom';

        const wrapText = d.length > 7 ? (d[7] & 0x08) !== 0 : false;

        // Borders — bytes 10-13 contain border styles, bytes 14-17 contain colors
        let left: XlsxBorderEdge | null = null;
        let right: XlsxBorderEdge | null = null;
        let top: XlsxBorderEdge | null = null;
        let bottom: XlsxBorderEdge | null = null;

        if (d.length >= 14) {
          // Byte 10: bits 0-2 left, 3-5 right, 6-8 top (lower of word at 10)
          const borderWord1 = readU16(d, 10);
          const leftStyle = borderWord1 & 0x0F;
          const rightStyle = (borderWord1 >> 4) & 0x0F;
          const topStyle = (borderWord1 >> 8) & 0x0F;
          const bottomStyle = (borderWord1 >> 12) & 0x0F;

          if (d.length >= 20) {
            // Border colors at bytes 16-19
            const colorWord1 = readU16(d, 14);
            const colorWord2 = readU16(d, 18);
            const leftColorIdx = colorWord1 & 0x7F;
            const rightColorIdx = (colorWord1 >> 7) & 0x7F;
            const topColorIdx = colorWord2 & 0x7F;
            const bottomColorIdx = (colorWord2 >> 7) & 0x7F;

            const ls = borderStyleName(leftStyle);
            const rs = borderStyleName(rightStyle);
            const ts = borderStyleName(topStyle);
            const bs = borderStyleName(bottomStyle);

            if (ls && ls !== 'none') left = { style: ls, color: colorIndexToHex(leftColorIdx, palette) };
            if (rs && rs !== 'none') right = { style: rs, color: colorIndexToHex(rightColorIdx, palette) };
            if (ts && ts !== 'none') top = { style: ts, color: colorIndexToHex(topColorIdx, palette) };
            if (bs && bs !== 'none') bottom = { style: bs, color: colorIndexToHex(bottomColorIdx, palette) };
          }
        }

        // Fill — bytes 16-17 contain pattern/colors
        let fgColor: string | null = null;
        let patternType = 'none';

        if (d.length >= 18) {
          const fillPattern = (d[16] >> 2) & 0x3F;
          if (fillPattern === 1) {
            patternType = 'solid';
            const fgIdx = d[17] & 0x7F;
            fgColor = colorIndexToHex(fgIdx, palette);
          }
        }

        const fillId = fills.length;
        fills.push({ fgColor, patternType });

        const borderId = borders.length;
        borders.push({ left, right, top, bottom });

        xfEntries.push({
          fontId,
          fillId,
          borderId,
          numFmtId,
          alignment: { horizontal, vertical, wrapText },
        });
        break;
      }

      case BOUNDSHEET: {
        const offset = readU32(rec.data, 0);
        // visibility at byte 4
        const name = readShortString(rec.data, 6);
        boundsheets.push({ offset, name });
        break;
      }

      case SST: {
        sharedStrings = parseSst(rec);
        break;
      }
    }
  }

  // Parse first sheet
  const sheets: XlsxSheet[] = [];
  if (boundsheets.length > 0) {
    const sheet = parseSheet(records, boundsheets[0].name, palette);
    sheets.push(sheet);
  }

  return {
    sheets,
    sharedStrings,
    styles: {
      fonts,
      fills,
      borders,
      cellXfs: xfEntries,
      numFmts,
    },
    theme: { colors: new Map() },
    images: new Map(),
    charts: [],
  };
}

function parseSheet(records: BiffRecord[], name: string, palette: string[]): XlsxSheet {
  const cells: XlsxCell[] = [];
  const mergeCells: XlsxMergeCell[] = [];
  const columns: XlsxColumn[] = [];
  const rowInfoMap = new Map<number, { height: number; hidden: boolean }>();
  let defaultColWidth = 8.43;
  let defaultRowHeight = 15;

  // Sub-streams are sequential (not nested): globals BOF/EOF, then sheet1 BOF/EOF, etc.
  let inSheet = false;
  let bofCount = 0;

  for (const rec of records) {
    if (rec.type === BOF) {
      bofCount++;
      // First BOF is globals, second BOF is first sheet
      if (bofCount === 2) inSheet = true;
      continue;
    }
    if (rec.type === EOF_REC) {
      if (inSheet) break;
      continue;
    }

    if (!inSheet) continue;

    const d = rec.data;
    switch (rec.type) {
      case DEFCOLWIDTH:
        if (d.length >= 2) defaultColWidth = readU16(d, 0);
        break;

      case DEFAULTROWHEIGHT:
        if (d.length >= 4) defaultRowHeight = readU16(d, 2) / 20;
        break;

      case COLINFO: {
        if (d.length < 6) break;
        const colFirst = readU16(d, 0);
        const colLast = readU16(d, 2);
        const widthRaw = readU16(d, 4); // in 1/256 chars
        const flags = d.length >= 12 ? readU16(d, 10) : 0;
        const hidden = (flags & 0x01) !== 0;
        columns.push({
          min: colFirst,
          max: colLast,
          widthChars: widthRaw / 256,
          hidden,
        });
        break;
      }

      case ROW_REC: {
        if (d.length < 8) break;
        const rowIdx = readU16(d, 0);
        const heightRaw = readU16(d, 6);
        // Bit 15 of height is "custom height" flag
        const height = (heightRaw & 0x7FFF) / 20;
        const flags = d.length >= 12 ? readU32(d, 8) : 0;
        const hidden = (flags & 0x20) !== 0;
        rowInfoMap.set(rowIdx, { height, hidden });
        break;
      }

      case LABELSST: {
        if (d.length < 10) break;
        const row = readU16(d, 0);
        const col = readU16(d, 2);
        const xfIdx = readU16(d, 4);
        const sstIdx = readU32(d, 6);
        cells.push({ ref: cellRef(col, row), col, row, value: sstIdx.toString(), styleIndex: xfIdx, type: 's' });
        break;
      }

      case NUMBER: {
        if (d.length < 14) break;
        const row = readU16(d, 0);
        const col = readU16(d, 2);
        const xfIdx = readU16(d, 4);
        const val = readFloat64(d, 6);
        cells.push({ ref: cellRef(col, row), col, row, value: val.toString(), styleIndex: xfIdx, type: 'n' });
        break;
      }

      case RK: {
        if (d.length < 10) break;
        const row = readU16(d, 0);
        const col = readU16(d, 2);
        const xfIdx = readU16(d, 4);
        const rkVal = readI32(d, 6);
        const val = decodeRk(rkVal);
        cells.push({ ref: cellRef(col, row), col, row, value: val.toString(), styleIndex: xfIdx, type: 'n' });
        break;
      }

      case MULRK: {
        if (d.length < 6) break;
        const row = readU16(d, 0);
        const colFirst = readU16(d, 2);
        const colLast = readU16(d, d.length - 2);
        let pos = 4;
        for (let c = colFirst; c <= colLast && pos + 6 <= d.length - 2; c++) {
          const xfIdx = readU16(d, pos);
          const rkVal = readI32(d, pos + 2);
          const val = decodeRk(rkVal);
          cells.push({ ref: cellRef(c, row), col: c, row, value: val.toString(), styleIndex: xfIdx, type: 'n' });
          pos += 6;
        }
        break;
      }

      case BOOLERR: {
        if (d.length < 8) break;
        const row = readU16(d, 0);
        const col = readU16(d, 2);
        const xfIdx = readU16(d, 4);
        const bVal = d[6];
        const isError = d[7] !== 0;
        if (!isError) {
          cells.push({ ref: cellRef(col, row), col, row, value: bVal ? '1' : '0', styleIndex: xfIdx, type: 'b' });
        }
        break;
      }

      case FORMULA: {
        if (d.length < 14) break;
        const row = readU16(d, 0);
        const col = readU16(d, 2);
        const xfIdx = readU16(d, 4);
        // Cached result in bytes 6-13
        // Check if it's a string result (byte 6=0, byte 12=0xFF, byte 13=0xFF)
        if (d[12] === 0xFF && d[13] === 0xFF) {
          // String/bool/error result — skip for now (STRING record follows for string)
          if (d[6] === 1) {
            // Boolean
            cells.push({ ref: cellRef(col, row), col, row, value: d[8] ? '1' : '0', styleIndex: xfIdx, type: 'b' });
          }
        } else {
          // Numeric result
          const val = readFloat64(d, 6);
          if (!isNaN(val)) {
            cells.push({ ref: cellRef(col, row), col, row, value: val.toString(), styleIndex: xfIdx, type: 'n' });
          }
        }
        break;
      }

      case MERGEDCELLS: {
        if (d.length < 2) break;
        const count = readU16(d, 0);
        for (let i = 0; i < count && 2 + i * 8 + 7 < d.length; i++) {
          const off = 2 + i * 8;
          const rwFirst = readU16(d, off);
          const rwLast = readU16(d, off + 2);
          const colFirst = readU16(d, off + 4);
          const colLast = readU16(d, off + 6);
          mergeCells.push({ startRow: rwFirst, endRow: rwLast, startCol: colFirst, endCol: colLast });
        }
        break;
      }
    }
  }

  // Build rows from cells
  const rowMap = new Map<number, XlsxCell[]>();
  for (const cell of cells) {
    let arr = rowMap.get(cell.row);
    if (!arr) { arr = []; rowMap.set(cell.row, arr); }
    arr.push(cell);
  }

  const rows: XlsxRow[] = [];
  for (const [idx, rowCells] of rowMap) {
    const info = rowInfoMap.get(idx);
    rows.push({
      index: idx,
      height: info?.height ?? defaultRowHeight,
      cells: rowCells,
      hidden: info?.hidden ?? false,
    });
  }
  // Also add rows that have info but no cells
  for (const [idx, info] of rowInfoMap) {
    if (!rowMap.has(idx)) {
      rows.push({ index: idx, height: info.height, cells: [], hidden: info.hidden });
    }
  }

  return {
    name,
    columns,
    rows,
    mergeCells,
    defaultRowHeight,
    defaultColWidth,
    drawings: [],
    showGridLines: true,
  };
}

function cellRef(col: number, row: number): string {
  let ref = '';
  let c = col;
  do {
    ref = String.fromCharCode(65 + (c % 26)) + ref;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return ref + (row + 1);
}
