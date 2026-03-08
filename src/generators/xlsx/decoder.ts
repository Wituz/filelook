import type { PixelGrid } from '../../types.ts';
import type { Matrix, Path, RGBA } from '../pdf/types.ts';
import { fillPath, strokePath, identity } from '../pdf/rasterizer.ts';
import { getGlyphOutline, getFallbackWidth } from '../pdf/font.ts';
import { decodeJpeg } from '../jpeg/decoder.ts';
import { decodePng } from '../png/decoder.ts';
import { decodeGif } from '../gif/decoder.ts';
import { extractFiles } from '../docx/zip.ts';
import { parseXlsxModel } from './model.ts';
import { parseChart, renderChart } from './chart.ts';
import type {
  XlsxWorkbook, XlsxSheet, XlsxCell, XlsxStyles, XlsxFont,
  XlsxFill, XlsxBorder, XlsxBorderEdge, XlsxCellXf, XlsxAlignment,
  XlsxMergeCell, XlsxDrawing, XlsxTheme,
} from './types.ts';

const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const MAX_DIM = 1024;
const CELL_PAD = 2;
const DEFAULT_COL_WIDTH_PT = 64; // ~8.43 chars * 7 + 5

function colWidthToPt(chars: number): number {
  return chars * 7 + 5;
}

function parseHexColor(hex: string | null): RGBA {
  if (!hex || hex.length < 6) return { r: 0, g: 0, b: 0, a: 255 };
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return { r: isNaN(r) ? 0 : r, g: isNaN(g) ? 0 : g, b: isNaN(b) ? 0 : b, a: 255 };
}

export interface SpreadsheetRenderResult {
  pixels: PixelGrid;
  colPositions: number[];
  rowPositions: number[];
  scale: number;
  buffer: Uint8Array;
  width: number;
  height: number;
}

export function renderSpreadsheet(workbook: XlsxWorkbook): SpreadsheetRenderResult {
  if (workbook.sheets.length === 0) throw new Error('Invalid spreadsheet: no sheets');
  const sheet = workbook.sheets[0];

  const scaleX = MAX_DIM / PAGE_WIDTH;
  const scaleY = MAX_DIM / PAGE_HEIGHT;
  const scale = Math.min(scaleX, scaleY);
  const width = Math.round(PAGE_WIDTH * scale);
  const height = Math.round(PAGE_HEIGHT * scale);
  const buffer = new Uint8Array(width * height * 4);

  // White background
  buffer.fill(255);

  // Compute column widths in points
  const colWidths = computeColWidths(sheet);
  const rowHeights = computeRowHeights(sheet);

  // Build cumulative positions
  const colPositions = buildCumulative(colWidths);
  const rowPositions = buildCumulative(rowHeights);

  // Find visible range that fits the page
  const visibleCols = findVisibleCount(colPositions, PAGE_WIDTH);
  const visibleRows = findVisibleCount(rowPositions, PAGE_HEIGHT);

  // Build cell lookup
  const cellMap = buildCellMap(sheet);
  const mergeMap = buildMergeMap(sheet.mergeCells);

  // 1. Grid lines
  if (sheet.showGridLines) {
    renderGridLines(buffer, width, height, scale, colPositions, rowPositions, visibleCols, visibleRows);
  }

  // 2. Cell backgrounds
  renderCellBackgrounds(buffer, width, height, scale, sheet, workbook.styles, colPositions, rowPositions, visibleCols, visibleRows, cellMap, mergeMap);

  // 3. Cell borders
  renderCellBorders(buffer, width, height, scale, sheet, workbook.styles, colPositions, rowPositions, visibleCols, visibleRows, cellMap, mergeMap);

  // 4. Cell text
  renderCellText(buffer, width, height, scale, sheet, workbook, colPositions, rowPositions, visibleCols, visibleRows, cellMap, mergeMap);

  // 5. Embedded images
  for (const drawing of sheet.drawings) {
    if (drawing.type === 'image') {
      renderEmbeddedImage(buffer, width, height, scale, drawing, workbook.images, colPositions, rowPositions);
    }
  }

  return { pixels: { width, height, data: buffer }, colPositions, rowPositions, scale, buffer, width, height };
}

export function decodeXlsx(data: Uint8Array): PixelGrid {
  const files = extractFiles(data);
  const workbook = parseXlsxModel(files);

  const result = renderSpreadsheet(workbook);

  // Charts (XLSX-specific, requires ZIP files)
  for (const chartRef of workbook.charts) {
    try {
      const chart = parseChart(files, chartRef.chartPath, workbook.theme);
      if (!chart) continue;
      const pos = drawingPosition(chartRef.drawing, result.colPositions, result.rowPositions);
      chart.x = pos.x;
      chart.y = pos.y;
      chart.width = pos.width;
      chart.height = pos.height;
      renderChart(result.buffer, result.width, result.height, chart, result.scale);
    } catch {
      // Silently skip corrupted charts
    }
  }

  return result.pixels;
}

// --- Column/Row sizing ---

function computeColWidths(sheet: XlsxSheet): number[] {
  // Find max column used
  let maxCol = 0;
  for (const row of sheet.rows) {
    for (const cell of row.cells) {
      if (cell.col > maxCol) maxCol = cell.col;
    }
  }
  for (const mc of sheet.mergeCells) {
    if (mc.endCol > maxCol) maxCol = mc.endCol;
  }
  for (const d of sheet.drawings) {
    if (d.toCol > maxCol) maxCol = d.toCol;
  }

  const defaultPt = colWidthToPt(sheet.defaultColWidth);
  const widths: number[] = [];
  for (let c = 0; c <= maxCol; c++) {
    let w = defaultPt;
    for (const col of sheet.columns) {
      if (c >= col.min && c <= col.max) {
        w = col.hidden ? 0 : colWidthToPt(col.widthChars);
        break;
      }
    }
    widths.push(w);
  }
  return widths;
}

function computeRowHeights(sheet: XlsxSheet): number[] {
  let maxRow = 0;
  for (const row of sheet.rows) {
    if (row.index > maxRow) maxRow = row.index;
  }
  for (const mc of sheet.mergeCells) {
    if (mc.endRow > maxRow) maxRow = mc.endRow;
  }
  for (const d of sheet.drawings) {
    if (d.toRow > maxRow) maxRow = d.toRow;
  }

  const heights: number[] = [];
  const rowMap = new Map<number, number>();
  const hiddenRows = new Set<number>();
  for (const row of sheet.rows) {
    rowMap.set(row.index, row.height);
    if (row.hidden) hiddenRows.add(row.index);
  }
  for (let r = 0; r <= maxRow; r++) {
    if (hiddenRows.has(r)) {
      heights.push(0);
    } else {
      heights.push(rowMap.get(r) ?? sheet.defaultRowHeight);
    }
  }
  return heights;
}

function buildCumulative(sizes: number[]): number[] {
  const positions = [0];
  for (let i = 0; i < sizes.length; i++) {
    positions.push(positions[i] + sizes[i]);
  }
  return positions;
}

function findVisibleCount(positions: number[], maxSize: number): number {
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] > maxSize) return i;
  }
  return positions.length - 1;
}

// --- Cell lookups ---

function cellKey(col: number, row: number): string {
  return `${col},${row}`;
}

function buildCellMap(sheet: XlsxSheet): Map<string, XlsxCell> {
  const map = new Map<string, XlsxCell>();
  for (const row of sheet.rows) {
    for (const cell of row.cells) {
      map.set(cellKey(cell.col, cell.row), cell);
    }
  }
  return map;
}

function buildMergeMap(mergeCells: XlsxMergeCell[]): Map<string, XlsxMergeCell> {
  const map = new Map<string, XlsxMergeCell>();
  for (const mc of mergeCells) {
    for (let r = mc.startRow; r <= mc.endRow; r++) {
      for (let c = mc.startCol; c <= mc.endCol; c++) {
        map.set(cellKey(c, r), mc);
      }
    }
  }
  return map;
}

// --- Drawing positions ---

function drawingPosition(
  drawing: XlsxDrawing, colPositions: number[], rowPositions: number[],
): { x: number; y: number; width: number; height: number } {
  const x = (colPositions[drawing.fromCol] ?? 0) + emuToPt(drawing.fromColOff);
  const y = (rowPositions[drawing.fromRow] ?? 0) + emuToPt(drawing.fromRowOff);
  const x2 = (colPositions[drawing.toCol] ?? colPositions[colPositions.length - 1] ?? 0) + emuToPt(drawing.toColOff);
  const y2 = (rowPositions[drawing.toRow] ?? rowPositions[rowPositions.length - 1] ?? 0) + emuToPt(drawing.toRowOff);
  return { x, y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) };
}

function emuToPt(emu: number): number { return emu / 12700; }

// --- Grid lines ---

function renderGridLines(
  buffer: Uint8Array, w: number, h: number, scale: number,
  colPos: number[], rowPos: number[], visCols: number, visRows: number,
): void {
  const gridColor: RGBA = { r: 208, g: 208, b: 208, a: 255 };
  const lineWidth = 0.5 * scale;

  // Horizontal lines
  for (let r = 0; r <= visRows; r++) {
    const y = (rowPos[r] ?? 0) * scale;
    const maxX = (colPos[visCols] ?? 0) * scale;
    const path: Path = {
      subpaths: [{ segments: [
        { type: 'move', x: 0, y },
        { type: 'line', x: maxX, y },
      ], closed: false }],
    };
    strokePath(buffer, w, h, path, identity(), gridColor, lineWidth);
  }

  // Vertical lines
  for (let c = 0; c <= visCols; c++) {
    const x = (colPos[c] ?? 0) * scale;
    const maxY = (rowPos[visRows] ?? 0) * scale;
    const path: Path = {
      subpaths: [{ segments: [
        { type: 'move', x, y: 0 },
        { type: 'line', x, y: maxY },
      ], closed: false }],
    };
    strokePath(buffer, w, h, path, identity(), gridColor, lineWidth);
  }
}

// --- Cell backgrounds ---

function renderCellBackgrounds(
  buffer: Uint8Array, w: number, h: number, scale: number,
  sheet: XlsxSheet, styles: XlsxStyles,
  colPos: number[], rowPos: number[], visCols: number, visRows: number,
  cellMap: Map<string, XlsxCell>, mergeMap: Map<string, XlsxMergeCell>,
): void {
  for (let r = 0; r < visRows; r++) {
    for (let c = 0; c < visCols; c++) {
      const key = cellKey(c, r);
      const mc = mergeMap.get(key);
      // Skip non-origin cells in merged ranges
      if (mc && (c !== mc.startCol || r !== mc.startRow)) continue;

      const cell = cellMap.get(key);
      if (!cell) continue;

      const xf = styles.cellXfs[cell.styleIndex];
      if (!xf) continue;
      const fill = styles.fills[xf.fillId];
      if (!fill || fill.patternType !== 'solid' || !fill.fgColor) continue;

      const x0 = colPos[c] * scale;
      const y0 = rowPos[r] * scale;
      let x1: number, y1: number;
      if (mc) {
        x1 = (colPos[Math.min(mc.endCol + 1, colPos.length - 1)] ?? colPos[colPos.length - 1]) * scale;
        y1 = (rowPos[Math.min(mc.endRow + 1, rowPos.length - 1)] ?? rowPos[rowPos.length - 1]) * scale;
      } else {
        x1 = (colPos[c + 1] ?? colPos[colPos.length - 1]) * scale;
        y1 = (rowPos[r + 1] ?? rowPos[rowPos.length - 1]) * scale;
      }

      fillRect(buffer, w, h, x0, y0, x1 - x0, y1 - y0, parseHexColor(fill.fgColor));
    }
  }
}

// --- Cell borders ---

function renderCellBorders(
  buffer: Uint8Array, w: number, h: number, scale: number,
  sheet: XlsxSheet, styles: XlsxStyles,
  colPos: number[], rowPos: number[], visCols: number, visRows: number,
  cellMap: Map<string, XlsxCell>, mergeMap: Map<string, XlsxMergeCell>,
): void {
  for (let r = 0; r < visRows; r++) {
    for (let c = 0; c < visCols; c++) {
      const key = cellKey(c, r);
      const cell = cellMap.get(key);
      if (!cell) continue;

      const xf = styles.cellXfs[cell.styleIndex];
      if (!xf) continue;
      const border = styles.borders[xf.borderId];
      if (!border) continue;

      const mc = mergeMap.get(key);
      if (mc && (c !== mc.startCol || r !== mc.startRow)) continue;

      const x0 = colPos[c] * scale;
      const y0 = rowPos[r] * scale;
      let x1: number, y1: number;
      if (mc) {
        x1 = (colPos[Math.min(mc.endCol + 1, colPos.length - 1)] ?? colPos[colPos.length - 1]) * scale;
        y1 = (rowPos[Math.min(mc.endRow + 1, rowPos.length - 1)] ?? rowPos[rowPos.length - 1]) * scale;
      } else {
        x1 = (colPos[c + 1] ?? colPos[colPos.length - 1]) * scale;
        y1 = (rowPos[r + 1] ?? rowPos[rowPos.length - 1]) * scale;
      }

      renderBorderEdge(buffer, w, h, border.top, x0, y0, x1, y0, scale);
      renderBorderEdge(buffer, w, h, border.bottom, x0, y1, x1, y1, scale);
      renderBorderEdge(buffer, w, h, border.left, x0, y0, x0, y1, scale);
      renderBorderEdge(buffer, w, h, border.right, x1, y0, x1, y1, scale);
    }
  }
}

function borderWidth(style: string): number {
  if (style === 'medium' || style === 'mediumDashed') return 1.5;
  if (style === 'thick') return 2.5;
  return 0.5; // thin, hair, dashed, dotted, etc.
}

function renderBorderEdge(
  buffer: Uint8Array, w: number, h: number,
  edge: XlsxBorderEdge | null,
  x0: number, y0: number, x1: number, y1: number, scale: number,
): void {
  if (!edge) return;
  const color = parseHexColor(edge.color);
  const lw = borderWidth(edge.style) * scale;
  const path: Path = {
    subpaths: [{ segments: [
      { type: 'move', x: x0, y: y0 },
      { type: 'line', x: x1, y: y1 },
    ], closed: false }],
  };
  strokePath(buffer, w, h, path, identity(), color, lw);
}

// --- Cell text ---

function renderCellText(
  buffer: Uint8Array, w: number, h: number, scale: number,
  sheet: XlsxSheet, workbook: XlsxWorkbook,
  colPos: number[], rowPos: number[], visCols: number, visRows: number,
  cellMap: Map<string, XlsxCell>, mergeMap: Map<string, XlsxMergeCell>,
): void {
  for (let r = 0; r < visRows; r++) {
    for (let c = 0; c < visCols; c++) {
      const key = cellKey(c, r);
      const mc = mergeMap.get(key);
      if (mc && (c !== mc.startCol || r !== mc.startRow)) continue;

      const cell = cellMap.get(key);
      if (!cell) continue;

      // Resolve display value
      let displayValue = resolveDisplayValue(cell, workbook);
      if (!displayValue) continue;

      // Get style
      const xf = workbook.styles.cellXfs[cell.styleIndex];
      const font = xf ? (workbook.styles.fonts[xf.fontId] ?? null) : null;
      const fontSize = font?.size ?? 11;
      const bold = font?.bold ?? false;
      const fontColor = font?.color ?? null;
      const alignment = xf?.alignment ?? { horizontal: 'general', vertical: 'bottom', wrapText: false };

      // Cell bounds
      const x0 = colPos[c];
      const y0 = rowPos[r];
      let cellW: number, cellH: number;
      if (mc) {
        cellW = (colPos[Math.min(mc.endCol + 1, colPos.length - 1)] ?? colPos[colPos.length - 1]) - x0;
        cellH = (rowPos[Math.min(mc.endRow + 1, rowPos.length - 1)] ?? rowPos[rowPos.length - 1]) - y0;
      } else {
        cellW = (colPos[c + 1] ?? colPos[colPos.length - 1]) - x0;
        cellH = (rowPos[r + 1] ?? rowPos[rowPos.length - 1]) - y0;
      }

      // Extend into adjacent empty cells for text overflow (like Excel)
      const textWidth = measureText(displayValue, fontSize, bold);
      let effectiveW = cellW;
      if (!mc && textWidth > cellW - CELL_PAD * 2) {
        for (let nc = c + 1; nc < visCols; nc++) {
          if (mergeMap.has(cellKey(nc, r))) break;
          const neighbor = cellMap.get(cellKey(nc, r));
          if (neighbor && resolveDisplayValue(neighbor, workbook)) break;
          effectiveW = (colPos[nc + 1] ?? colPos[colPos.length - 1]) - x0;
          if (textWidth <= effectiveW - CELL_PAD * 2) break;
        }
      }

      const maxTextWidth = effectiveW - CELL_PAD * 2;
      if (maxTextWidth <= 0) continue;

      // Truncate
      displayValue = truncateText(displayValue, fontSize, bold, maxTextWidth);

      // Horizontal alignment
      let hAlign = alignment.horizontal;
      if (hAlign === 'general') {
        hAlign = isNumericType(cell.type) ? 'right' : 'left';
      }

      const textW = measureText(displayValue, fontSize, bold);
      let textX: number;
      if (hAlign === 'center') {
        textX = x0 + CELL_PAD + (maxTextWidth - textW) / 2;
      } else if (hAlign === 'right') {
        textX = x0 + cellW - CELL_PAD - textW;
      } else {
        textX = x0 + CELL_PAD;
      }

      // Vertical: baseline near bottom by default
      const textY = y0 + cellH - CELL_PAD - (fontSize * 0.2);

      renderText(buffer, w, h, displayValue, textX * scale, textY * scale, fontSize, bold, parseHexColor(fontColor), scale);
    }
  }
}

function isNumericType(type: string): boolean {
  return type === 'n' || type === '';
}

function resolveDisplayValue(cell: XlsxCell, workbook: XlsxWorkbook): string {
  if (cell.type === 's') {
    const idx = parseInt(cell.value, 10);
    if (!isNaN(idx) && idx >= 0 && idx < workbook.sharedStrings.length) {
      return workbook.sharedStrings[idx];
    }
    return '';
  }
  if (cell.type === 'b') return cell.value === '1' ? 'TRUE' : 'FALSE';
  if (cell.type === 'inlineStr' || cell.type === 'str') return cell.value;

  // Numeric — apply basic number format
  if (!cell.value) return '';
  const xf = workbook.styles.cellXfs[cell.styleIndex];
  const numFmtId = xf?.numFmtId ?? 0;
  return formatNumber(cell.value, numFmtId, workbook.styles.numFmts);
}

function formatNumber(value: string, numFmtId: number, customFmts: Map<number, string>): string {
  const num = parseFloat(value);
  if (isNaN(num)) return value;

  // General
  if (numFmtId <= 1) {
    if (Number.isInteger(num)) return num.toString();
    const s = num.toPrecision(10);
    return parseFloat(s).toString();
  }
  // Fixed decimal
  if (numFmtId >= 2 && numFmtId <= 4) return num.toFixed(numFmtId);
  // Currency
  if (numFmtId >= 5 && numFmtId <= 8) return '$' + num.toFixed(2);
  // Percentage
  if (numFmtId === 9) return Math.round(num * 100) + '%';
  if (numFmtId === 10) return (num * 100).toFixed(2) + '%';
  // Date range — just show the number
  if (numFmtId >= 14 && numFmtId <= 22) return value;
  // Comma style
  if (numFmtId === 3 || numFmtId === 4 || numFmtId === 37 || numFmtId === 38 || numFmtId === 39 || numFmtId === 40) {
    return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  // Check custom format
  const customFmt = customFmts.get(numFmtId);
  if (customFmt) {
    if (customFmt.includes('$')) return '$' + num.toFixed(2);
    if (customFmt.includes('%')) return (num * 100).toFixed(2) + '%';
    if (customFmt.includes(',')) return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (customFmt.includes('0.00')) return num.toFixed(2);
  }

  // Fallback
  if (Number.isInteger(num)) return num.toString();
  return num.toFixed(2);
}

// --- Embedded images ---

function renderEmbeddedImage(
  buffer: Uint8Array, w: number, h: number, scale: number,
  drawing: XlsxDrawing, images: Map<string, Uint8Array>,
  colPos: number[], rowPos: number[],
): void {
  const imageData = images.get(drawing.rId);
  if (!imageData) return;

  let decoded: PixelGrid;
  try {
    decoded = decodeEmbeddedImage(imageData);
  } catch {
    return;
  }

  const pos = drawingPosition(drawing, colPos, rowPos);
  const dx = Math.round(pos.x * scale);
  const dy = Math.round(pos.y * scale);
  const dw = Math.round(pos.width * scale);
  const dh = Math.round(pos.height * scale);

  compositeImage(buffer, w, h, decoded, dx, dy, dw, dh);
}

function decodeEmbeddedImage(data: Uint8Array): PixelGrid {
  if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return decodeJpeg(data);
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) return decodePng(data);
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return decodeGif(data);
  throw new Error('Unsupported embedded image format');
}

// Y-down compositor (same as PPTX/DOCX)
function compositeImage(
  buffer: Uint8Array, bufW: number, bufH: number,
  image: PixelGrid, dx: number, dy: number, dw: number, dh: number,
): void {
  if (dw <= 0 || dh <= 0) return;
  const x0 = Math.max(0, dx);
  const y0 = Math.max(0, dy);
  const x1 = Math.min(bufW - 1, dx + dw - 1);
  const y1 = Math.min(bufH - 1, dy + dh - 1);

  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const sx = Math.floor((px - dx) * image.width / dw);
      const sy = Math.floor((py - dy) * image.height / dh);
      if (sx < 0 || sx >= image.width || sy < 0 || sy >= image.height) continue;

      const srcOff = (sy * image.width + sx) * 4;
      const dstOff = (py * bufW + px) * 4;
      const sa = image.data[srcOff + 3];
      if (sa === 0) continue;

      if (sa === 255) {
        buffer[dstOff] = image.data[srcOff];
        buffer[dstOff + 1] = image.data[srcOff + 1];
        buffer[dstOff + 2] = image.data[srcOff + 2];
        buffer[dstOff + 3] = 255;
      } else {
        const srcA = sa / 255;
        const invA = 1 - srcA;
        buffer[dstOff] = Math.round(image.data[srcOff] * srcA + buffer[dstOff] * invA);
        buffer[dstOff + 1] = Math.round(image.data[srcOff + 1] * srcA + buffer[dstOff + 1] * invA);
        buffer[dstOff + 2] = Math.round(image.data[srcOff + 2] * srcA + buffer[dstOff + 2] * invA);
        buffer[dstOff + 3] = Math.min(255, Math.round(sa + buffer[dstOff + 3] * invA));
      }
    }
  }
}

// --- Text rendering ---

function measureText(text: string, fontSize: number, bold: boolean): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    w += getFallbackWidth(text.charCodeAt(i)) * fontSize / 1000 * (bold ? 1.05 : 1);
  }
  return w;
}

function truncateText(text: string, fontSize: number, bold: boolean, maxWidth: number): string {
  const fullWidth = measureText(text, fontSize, bold);
  if (fullWidth <= maxWidth) return text;
  const ellipsisWidth = measureText('\u2026', fontSize, bold);
  const target = maxWidth - ellipsisWidth;
  let w = 0;
  let end = 0;
  for (let i = 0; i < text.length; i++) {
    const cw = getFallbackWidth(text.charCodeAt(i)) * fontSize / 1000 * (bold ? 1.05 : 1);
    if (w + cw > target) break;
    w += cw;
    end = i + 1;
  }
  return text.slice(0, end) + '\u2026';
}

function renderText(
  buffer: Uint8Array, w: number, h: number,
  text: string, x: number, baselineY: number,
  fontSize: number, bold: boolean, color: RGBA, scale: number,
): void {
  const glyphScale = fontSize * scale / 1000;
  let curX = x;
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    if (cp === 32 || cp === 0x09) {
      curX += getFallbackWidth(cp) * fontSize * scale / 1000 * (bold ? 1.05 : 1);
      continue;
    }
    const outline = getGlyphOutline(cp);
    const ctm: Matrix = [glyphScale * (bold ? 1.05 : 1), 0, 0, -glyphScale, curX, baselineY];
    fillPath(buffer, w, h, outline, ctm, color, 'nonzero');
    curX += getFallbackWidth(cp) * fontSize * scale / 1000 * (bold ? 1.05 : 1);
  }
}

function fillRect(buffer: Uint8Array, w: number, h: number, x: number, y: number, rw: number, rh: number, color: RGBA): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(w - 1, Math.floor(x + rw));
  const y1 = Math.min(h - 1, Math.floor(y + rh));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const off = (py * w + px) * 4;
      buffer[off] = color.r;
      buffer[off + 1] = color.g;
      buffer[off + 2] = color.b;
      buffer[off + 3] = color.a;
    }
  }
}
