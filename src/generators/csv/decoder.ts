import type { PixelGrid } from '../../types.ts';
import type { Matrix, Path, RGBA } from '../pdf/types.ts';
import { fillPath, strokePath, identity } from '../pdf/rasterizer.ts';
import { getGlyphOutline, getFallbackWidth } from '../pdf/font.ts';
import type { CsvData } from './types.ts';

// Landscape A4 in points
const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const MARGIN = 20;
const MAX_DIM = 1024;

const FONT_SIZE = 9;
const HEADER_FONT_SIZE = 9;
const CELL_PAD_X = 6;
const CELL_PAD_Y = 4;
const LINE_HEIGHT = 1.4;
const MIN_COL_WIDTH = 40;
const GRID_WIDTH = 0.5;

// Colors
const HEADER_BG: RGBA = { r: 68, g: 114, b: 196, a: 255 };   // #4472C4
const HEADER_TEXT: RGBA = { r: 255, g: 255, b: 255, a: 255 };
const DATA_TEXT: RGBA = { r: 51, g: 51, b: 51, a: 255 };       // #333333
const EVEN_ROW_BG: RGBA = { r: 255, g: 255, b: 255, a: 255 };
const ODD_ROW_BG: RGBA = { r: 242, g: 246, b: 250, a: 255 };   // #F2F6FA
const GRID_COLOR: RGBA = { r: 217, g: 222, b: 228, a: 255 };   // #D9DEE4

export function decodeCsv(data: Uint8Array): PixelGrid {
  const text = new TextDecoder('utf-8').decode(data);
  const csv = parseCsv(text);
  if (csv.rows.length === 0) throw new Error('Empty CSV file');

  const contentWidth = PAGE_WIDTH - MARGIN * 2;
  const contentHeight = PAGE_HEIGHT - MARGIN * 2;
  const headerRowHeight = HEADER_FONT_SIZE * LINE_HEIGHT + CELL_PAD_Y * 2;
  const dataRowHeight = FONT_SIZE * LINE_HEIGHT + CELL_PAD_Y * 2;

  // Determine how many rows fit
  const maxDataRows = Math.floor((contentHeight - headerRowHeight) / dataRowHeight);
  const numDataRows = Math.min(csv.rows.length - 1, maxDataRows);
  const totalRows = 1 + numDataRows; // header + data
  const visibleRows = csv.rows.slice(0, totalRows);

  // Compute column widths
  const numCols = Math.max(...visibleRows.map(r => r.length));
  const colWidths = computeColumnWidths(visibleRows, numCols, contentWidth);

  // Scale to fit MAX_DIM
  const scaleX = MAX_DIM / PAGE_WIDTH;
  const scaleY = MAX_DIM / PAGE_HEIGHT;
  const scale = Math.min(scaleX, scaleY);
  const width = Math.round(PAGE_WIDTH * scale);
  const height = Math.round(PAGE_HEIGHT * scale);
  const buffer = new Uint8Array(width * height * 4);

  // White background
  buffer.fill(255);

  // Render row backgrounds
  let y = MARGIN;
  for (let row = 0; row < totalRows; row++) {
    const rowH = row === 0 ? headerRowHeight : dataRowHeight;
    const bg = row === 0 ? HEADER_BG : (row % 2 === 0 ? ODD_ROW_BG : EVEN_ROW_BG);
    fillRect(buffer, width, height, MARGIN * scale, y * scale, contentWidth * scale, rowH * scale, bg);
    y += rowH;
  }

  // Render grid lines
  renderGrid(buffer, width, height, scale, colWidths, totalRows, headerRowHeight, dataRowHeight);

  // Render text
  y = MARGIN;
  for (let row = 0; row < totalRows; row++) {
    const rowH = row === 0 ? headerRowHeight : dataRowHeight;
    const cells = visibleRows[row] ?? [];
    const fontSize = row === 0 ? HEADER_FONT_SIZE : FONT_SIZE;
    const bold = row === 0;
    const color = row === 0 ? HEADER_TEXT : DATA_TEXT;

    let x = MARGIN;
    for (let col = 0; col < numCols; col++) {
      const cellText = cells[col] ?? '';
      const colW = colWidths[col];
      const maxTextWidth = colW - CELL_PAD_X * 2;
      const truncated = truncateText(cellText, fontSize, bold, maxTextWidth);
      const textY = y + CELL_PAD_Y + fontSize; // baseline

      renderText(buffer, width, height, truncated, (x + CELL_PAD_X) * scale, textY * scale, fontSize, bold, color, scale);
      x += colW;
    }
    y += rowH;
  }

  return { width, height, data: buffer };
}

// --- CSV Parser (RFC 4180) ---

function parseCsv(text: string): CsvData {
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const { row, next } = parseRow(text, i, delimiter);
    rows.push(row);
    i = next;
  }

  // Remove trailing empty row
  if (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop();
  }

  return { rows, delimiter };
}

function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf('\n') >>> 0 || text.length);
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestCount = 0;
  for (const d of candidates) {
    let count = 0;
    for (let i = 0; i < firstLine.length; i++) {
      if (firstLine[i] === d) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

function parseRow(text: string, start: number, delimiter: string): { row: string[]; next: number } {
  const row: string[] = [];
  let i = start;
  const len = text.length;

  while (i < len) {
    if (text[i] === '"') {
      // Quoted field
      let field = '';
      i++; // skip opening quote
      while (i < len) {
        if (text[i] === '"') {
          if (i + 1 < len && text[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          field += text[i];
          i++;
        }
      }
      row.push(field);
      // Skip delimiter or newline after quoted field
      if (i < len && text[i] === delimiter) {
        i++;
      } else if (i < len && text[i] === '\r') {
        i++;
        if (i < len && text[i] === '\n') i++;
        return { row, next: i };
      } else if (i < len && text[i] === '\n') {
        i++;
        return { row, next: i };
      }
    } else {
      // Unquoted field
      let field = '';
      while (i < len && text[i] !== delimiter && text[i] !== '\r' && text[i] !== '\n') {
        field += text[i];
        i++;
      }
      row.push(field);
      if (i < len && text[i] === delimiter) {
        i++;
      } else {
        if (i < len && text[i] === '\r') i++;
        if (i < len && text[i] === '\n') i++;
        return { row, next: i };
      }
    }
  }

  return { row, next: i };
}

// --- Column Width Calculation ---

function measureText(text: string, fontSize: number, bold: boolean): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    w += getFallbackWidth(text.charCodeAt(i)) * fontSize / 1000 * (bold ? 1.05 : 1);
  }
  return w;
}

function computeColumnWidths(rows: string[][], numCols: number, totalWidth: number): number[] {
  // Measure natural width of each column (max across all visible rows)
  const naturalWidths = new Array(numCols).fill(0);
  for (let col = 0; col < numCols; col++) {
    for (let row = 0; row < rows.length; row++) {
      const cell = rows[row][col] ?? '';
      const fontSize = row === 0 ? HEADER_FONT_SIZE : FONT_SIZE;
      const bold = row === 0;
      const w = measureText(cell, fontSize, bold) + CELL_PAD_X * 2;
      if (w > naturalWidths[col]) naturalWidths[col] = w;
    }
    naturalWidths[col] = Math.max(naturalWidths[col], MIN_COL_WIDTH);
  }

  // Scale proportionally to fit totalWidth
  const sum = naturalWidths.reduce((a, b) => a + b, 0);
  if (sum <= totalWidth) {
    // Distribute extra space proportionally
    const ratio = totalWidth / sum;
    return naturalWidths.map(w => w * ratio);
  }
  // Shrink proportionally, respecting minimum
  const ratio = totalWidth / sum;
  return naturalWidths.map(w => Math.max(MIN_COL_WIDTH, w * ratio));
}

// --- Text Truncation ---

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

// --- Rendering ---

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

function renderGrid(
  buffer: Uint8Array, w: number, h: number, scale: number,
  colWidths: number[], totalRows: number,
  headerRowHeight: number, dataRowHeight: number,
): void {
  const tableWidth = colWidths.reduce((a, b) => a + b, 0);
  const tableHeight = headerRowHeight + (totalRows - 1) * dataRowHeight;

  // Horizontal lines
  let y = MARGIN;
  for (let row = 0; row <= totalRows; row++) {
    const path: Path = {
      subpaths: [{
        segments: [
          { type: 'move', x: MARGIN * scale, y: y * scale },
          { type: 'line', x: (MARGIN + tableWidth) * scale, y: y * scale },
        ],
        closed: false,
      }],
    };
    strokePath(buffer, w, h, path, identity(), GRID_COLOR, GRID_WIDTH * scale);
    y += row === 0 ? headerRowHeight : dataRowHeight;
  }

  // Vertical lines
  let x = MARGIN;
  for (let col = 0; col <= colWidths.length; col++) {
    const path: Path = {
      subpaths: [{
        segments: [
          { type: 'move', x: x * scale, y: MARGIN * scale },
          { type: 'line', x: x * scale, y: (MARGIN + tableHeight) * scale },
        ],
        closed: false,
      }],
    };
    strokePath(buffer, w, h, path, identity(), GRID_COLOR, GRID_WIDTH * scale);
    if (col < colWidths.length) x += colWidths[col];
  }
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
