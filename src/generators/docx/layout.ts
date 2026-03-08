import { getFallbackWidth } from '../pdf/font.ts';
import { resolveParaProps, resolveRunProps } from './model.ts';
import type {
  DocxDocument, DocxBlock, DocxParagraph, DocxTable, DocxRun,
  DocxParagraphProps, DocxRunProps, DocxFloatingImage,
  LayoutResult, LayoutLine, LayoutItem, LayoutTextItem, LayoutImageItem,
  LayoutFloatingImage, LayoutBackground, LayoutBorderLine,
} from './types.ts';

interface Span { left: number; right: number }

class RegionManager {
  private exclusions: { x: number; y: number; width: number; height: number; wrapMode: string }[] = [];

  addFloat(x: number, y: number, w: number, h: number, wrapMode: string): void {
    this.exclusions.push({ x, y, width: w, height: h, wrapMode });
  }

  getAvailableSpans(y: number, lineHeight: number, left: number, right: number): Span[] {
    let spans: Span[] = [{ left, right }];

    for (const ex of this.exclusions) {
      if (y + lineHeight <= ex.y || y >= ex.y + ex.height) continue;

      if (ex.wrapMode === 'topAndBottom') return [];
      if (ex.wrapMode === 'none') continue;

      // wrapSquare / wrapTight — split spans around exclusion
      const newSpans: Span[] = [];
      for (const span of spans) {
        if (ex.x + ex.width <= span.left || ex.x >= span.right) {
          newSpans.push(span);
        } else {
          if (ex.x > span.left + 1) newSpans.push({ left: span.left, right: ex.x });
          if (ex.x + ex.width < span.right - 1) newSpans.push({ left: ex.x + ex.width, right: span.right });
        }
      }
      spans = newSpans;
    }

    return spans.filter(s => s.right - s.left > 1);
  }
}

interface Word {
  chars: number[];
  width: number;
  props: DocxRunProps;
  image?: { rId: string; widthPt: number; heightPt: number };
}

function measureChar(cp: number, fontSize: number, bold: boolean): number {
  return getFallbackWidth(cp) * fontSize / 1000 * (bold ? 1.05 : 1);
}

function splitRunsIntoWords(runs: DocxRun[], effectiveRunProps: (r: DocxRun) => DocxRunProps): Word[] {
  const words: Word[] = [];
  let currentWord: Word | null = null;

  for (const run of runs) {
    const rProps = effectiveRunProps(run);

    if (run.type === 'image' && run.image) {
      if (currentWord) { words.push(currentWord); currentWord = null; }
      words.push({
        chars: [],
        width: run.image.widthPt,
        props: rProps,
        image: run.image,
      });
      continue;
    }

    if (run.type === 'break') {
      if (currentWord) { words.push(currentWord); currentWord = null; }
      words.push({ chars: [run.text === '\f' ? 0x0C : 0x0A], width: 0, props: rProps });
      continue;
    }

    if (run.type === 'tab') {
      if (currentWord) { words.push(currentWord); currentWord = null; }
      // Tab as ~4 spaces worth
      const tabWidth = measureChar(32, rProps.fontSize, rProps.bold) * 4;
      words.push({ chars: [0x09], width: tabWidth, props: rProps });
      continue;
    }

    const text = run.text;
    for (let i = 0; i < text.length; i++) {
      const cp = text.charCodeAt(i);
      if (cp === 32) {
        if (currentWord) { words.push(currentWord); currentWord = null; }
        const spaceWidth = measureChar(32, rProps.fontSize, rProps.bold);
        words.push({ chars: [32], width: spaceWidth, props: rProps });
      } else {
        if (!currentWord) currentWord = { chars: [], width: 0, props: rProps };
        currentWord.chars.push(cp);
        currentWord.width += measureChar(cp, rProps.fontSize, rProps.bold);
      }
    }
  }
  if (currentWord) words.push(currentWord);
  return words;
}

export function layoutDocument(doc: DocxDocument, floatingImages: DocxFloatingImage[]): LayoutResult {
  const lines: LayoutLine[] = [];
  const floats: LayoutFloatingImage[] = [];
  const backgrounds: LayoutBackground[] = [];
  const borders: LayoutBorderLine[] = [];
  const tableBorders: LayoutBorderLine[] = [];

  const regions = new RegionManager();
  const contentLeft = doc.marginLeft;
  const contentRight = doc.pageWidth - doc.marginRight;
  let y = doc.marginTop;

  // Register floating images
  for (const fi of floatingImages) {
    regions.addFloat(fi.x, fi.y, fi.widthPt, fi.heightPt, fi.wrapMode);
    floats.push({ x: fi.x, y: fi.y, width: fi.widthPt, height: fi.heightPt, rId: fi.rId });
  }

  for (const block of doc.body) {
    if (y >= doc.pageHeight - doc.marginBottom) break;

    if (block.type === 'paragraph') {
      y = layoutParagraph(block, doc, y, contentLeft, contentRight, regions, lines, backgrounds, borders);
    } else if (block.type === 'table') {
      y = layoutTable(block, doc, y, contentLeft, contentRight, lines, backgrounds, tableBorders);
    }
  }

  return { lines, floatingImages: floats, backgrounds, borders, tableBorders };
}

function layoutParagraph(
  para: DocxParagraph, doc: DocxDocument, startY: number,
  left: number, right: number,
  regions: RegionManager,
  lines: LayoutLine[], backgrounds: LayoutBackground[], borderLines: LayoutBorderLine[],
): number {
  const props = resolveParaProps(para.props, doc.styles, doc.defaults);

  // Page break before
  if (props.pageBreakBefore) return doc.pageHeight; // stop layout

  const effectiveRunProps = (r: DocxRun) => resolveRunProps(r.props, props.styleId, doc.styles, doc.defaultRunProps);

  let y = startY + props.spaceBefore;
  const words = splitRunsIntoWords(para.runs, effectiveRunProps);

  // Handle bullet prefix
  if (props.bullet) {
    const bulletProps = para.runs.length > 0 ? effectiveRunProps(para.runs[0]) : doc.defaultRunProps;
    const bulletCp = props.bullet.charCodeAt(0);
    const bulletWidth = measureChar(bulletCp, bulletProps.fontSize, bulletProps.bold);
    words.unshift(
      { chars: [bulletCp], width: bulletWidth, props: bulletProps },
      { chars: [32], width: measureChar(32, bulletProps.fontSize, bulletProps.bold), props: bulletProps },
    );
  }

  // Paragraph shading
  const paraStartY = y;

  if (words.length === 0) {
    // Empty paragraph — advance by one line
    const fontSize = doc.defaultRunProps.fontSize;
    y += fontSize * props.lineSpacing;
    y += props.spaceAfter;
    return y;
  }

  let wordIdx = 0;
  let firstLine = true;

  while (wordIdx < words.length) {
    if (y >= doc.pageHeight - doc.marginBottom) break;

    // Check for page break
    if (words[wordIdx].chars.length === 1 && words[wordIdx].chars[0] === 0x0C) {
      return doc.pageHeight; // stop layout at page 1
    }

    // Check for line break
    if (words[wordIdx].chars.length === 1 && words[wordIdx].chars[0] === 0x0A) {
      const fontSize = words[wordIdx].props.fontSize;
      y += fontSize * props.lineSpacing;
      wordIdx++;
      firstLine = false;
      continue;
    }

    const indent = props.indentLeft + (firstLine ? props.indentFirstLine : 0);
    const lineLeft = left + indent;
    const lineRight = right - props.indentRight;

    // Get available spans considering floats
    const maxFontSize = getMaxFontSize(words, wordIdx);
    const lineHeight = maxFontSize * props.lineSpacing;
    let spans = regions.getAvailableSpans(y, lineHeight, lineLeft, lineRight);

    // If no spans (e.g. topAndBottom float), advance Y
    let attempts = 0;
    while (spans.length === 0 && attempts < 100) {
      y += lineHeight;
      spans = regions.getAvailableSpans(y, lineHeight, lineLeft, lineRight);
      attempts++;
    }
    if (spans.length === 0) break;

    const span = spans[0]; // use first available span
    const availWidth = span.right - span.left;

    // Greedy line breaking
    const lineItems: LayoutItem[] = [];
    let lineWidth = 0;
    let maxHeight = 0;
    const lineStartIdx = wordIdx;

    while (wordIdx < words.length) {
      const word = words[wordIdx];

      // Stop on breaks
      if (word.chars.length === 1 && (word.chars[0] === 0x0A || word.chars[0] === 0x0C)) break;

      // Skip spaces at start of line
      if (lineItems.length === 0 && word.chars.length === 1 && word.chars[0] === 32) {
        wordIdx++;
        continue;
      }

      const wordWidth = word.width;
      if (lineItems.length > 0 && lineWidth + wordWidth > availWidth) break;

      if (word.image) {
        lineItems.push({
          type: 'image', x: lineWidth,
          width: word.image.widthPt, height: word.image.heightPt,
          rId: word.image.rId,
        });
        maxHeight = Math.max(maxHeight, word.image.heightPt);
      } else {
        const rProps = word.props;
        for (const cp of word.chars) {
          const charWidth = cp === 0x09 ? word.width : measureChar(cp, rProps.fontSize, rProps.bold);
          lineItems.push({
            type: 'text', x: lineWidth, char: cp,
            fontSize: rProps.fontSize, bold: rProps.bold,
            color: rProps.color, underline: rProps.underline,
          });
          lineWidth += charWidth;
        }
        maxHeight = Math.max(maxHeight, rProps.fontSize);
        wordIdx++;
        continue;
      }

      lineWidth += wordWidth;
      wordIdx++;
    }

    // If we didn't fit any word and there are still words, force one word on the line
    if (lineItems.length === 0 && wordIdx < words.length && wordIdx === lineStartIdx) {
      const word = words[wordIdx];
      const rProps = word.props;
      for (const cp of word.chars) {
        const charWidth = measureChar(cp, rProps.fontSize, rProps.bold);
        lineItems.push({
          type: 'text', x: lineWidth, char: cp,
          fontSize: rProps.fontSize, bold: rProps.bold,
          color: rProps.color, underline: rProps.underline,
        });
        lineWidth += charWidth;
      }
      maxHeight = Math.max(maxHeight, rProps.fontSize);
      wordIdx++;
    }

    if (lineItems.length > 0) {
      let lineX = span.left;
      if (props.alignment === 'center') lineX += (availWidth - lineWidth) / 2;
      else if (props.alignment === 'right') lineX += availWidth - lineWidth;

      lines.push({
        x: lineX,
        y,
        items: lineItems,
        width: lineWidth,
        alignment: props.alignment,
      });

      y += Math.max(maxHeight, maxFontSize) * props.lineSpacing;
    }

    firstLine = false;
  }

  // Paragraph shading background
  if (props.shading) {
    backgrounds.push({
      x: left, y: paraStartY,
      width: right - left, height: y - paraStartY,
      color: props.shading,
    });
  }

  // Paragraph bottom border
  if (props.borderBottom) {
    borderLines.push({
      x0: left, y0: y, x1: right, y1: y,
      width: props.borderBottom.width,
      color: props.borderBottom.color,
    });
  }

  y += props.spaceAfter;
  return y;
}

function layoutTable(
  table: DocxTable, doc: DocxDocument, startY: number,
  left: number, right: number,
  lines: LayoutLine[], backgrounds: LayoutBackground[], tableBorders: LayoutBorderLine[],
): number {
  const colWidths = table.columnWidths.length > 0
    ? table.columnWidths
    : defaultColumnWidths(table, right - left);

  let y = startY;

  for (let rowIdx = 0; rowIdx < table.rows.length; rowIdx++) {
    const row = table.rows[rowIdx];
    if (y >= doc.pageHeight - doc.marginBottom) break;

    let cellX = left;
    let maxCellHeight = row.height || 0;
    const cellLayouts: { x: number; width: number; lines: LayoutLine[] }[] = [];

    let colIdx = 0;
    for (const cell of row.cells) {
      const cellWidth = sumWidths(colWidths, colIdx, cell.columnSpan);
      const cellLines: LayoutLine[] = [];
      const cellRegions = new RegionManager();
      let cellY = y + 2; // small padding
      const cellLeft = cellX + 2;
      const cellRight = cellX + cellWidth - 2;

      for (const block of cell.blocks) {
        if (block.type === 'paragraph') {
          cellY = layoutParagraph(
            block, doc, cellY, cellLeft, cellRight,
            cellRegions, cellLines, backgrounds, tableBorders,
          );
        }
      }

      const cellHeight = cellY - y + 2;
      maxCellHeight = Math.max(maxCellHeight, cellHeight);

      // Cell shading
      if (cell.shading) {
        backgrounds.push({
          x: cellX, y, width: cellWidth, height: 0, // height set after row
          color: cell.shading,
        });
      }

      cellLayouts.push({ x: cellX, width: cellWidth, lines: cellLines });
      cellX += cellWidth;
      colIdx += cell.columnSpan;
    }

    // Fix cell shading heights
    for (const bg of backgrounds) {
      if (bg.height === 0 && bg.y === y) bg.height = maxCellHeight;
    }

    // Add cell lines
    for (const cl of cellLayouts) {
      lines.push(...cl.lines);
    }

    // Draw table borders
    const rowBottom = y + maxCellHeight;
    drawTableBorders(table, rowIdx, y, rowBottom, left, colWidths, row.cells, tableBorders);

    y = rowBottom;
  }

  return y;
}

function drawTableBorders(
  table: DocxTable, rowIdx: number, top: number, bottom: number,
  left: number, colWidths: number[], cells: { columnSpan: number }[],
  borders: LayoutBorderLine[],
): void {
  const bs = table.borders;
  const defaultBorder = { width: 0.5, color: '000000' };

  // Top border for first row
  if (rowIdx === 0 && (bs.top || bs.insideH)) {
    const b = bs.top ?? defaultBorder;
    const totalWidth = colWidths.reduce((a, w) => a + w, 0);
    borders.push({ x0: left, y0: top, x1: left + totalWidth, y1: top, width: b.width, color: b.color });
  }

  // Bottom border (insideH for interior rows, bottom for last row)
  const isLastRow = rowIdx === table.rows.length - 1;
  const hBorder = isLastRow ? (bs.bottom ?? bs.insideH) : (bs.insideH ?? null);
  if (hBorder) {
    const totalWidth = colWidths.reduce((a, w) => a + w, 0);
    borders.push({ x0: left, y0: bottom, x1: left + totalWidth, y1: bottom, width: hBorder.width, color: hBorder.color });
  }

  // Vertical borders
  let x = left;
  let colIdx = 0;
  for (let ci = 0; ci <= cells.length; ci++) {
    const isFirst = ci === 0;
    const isLast = ci === cells.length;
    const vBorder = isFirst || isLast ? (bs.left ?? bs.insideV) : (bs.insideV ?? null);

    if (vBorder) {
      borders.push({ x0: x, y0: top, x1: x, y1: bottom, width: vBorder.width, color: vBorder.color });
    }

    if (ci < cells.length) {
      const span = cells[ci].columnSpan;
      x += sumWidths(colWidths, colIdx, span);
      colIdx += span;
    }
  }
}

function defaultColumnWidths(table: DocxTable, totalWidth: number): number[] {
  let maxCols = 0;
  for (const row of table.rows) {
    let cols = 0;
    for (const cell of row.cells) cols += cell.columnSpan;
    maxCols = Math.max(maxCols, cols);
  }
  if (maxCols === 0) return [];
  const w = totalWidth / maxCols;
  return Array.from({ length: maxCols }, () => w);
}

function sumWidths(widths: number[], start: number, count: number): number {
  let sum = 0;
  for (let i = start; i < start + count && i < widths.length; i++) sum += widths[i];
  return sum;
}

function getMaxFontSize(words: Word[], startIdx: number): number {
  let max = 11;
  for (let i = startIdx; i < words.length; i++) {
    const w = words[i];
    if (w.chars.length === 1 && (w.chars[0] === 0x0A || w.chars[0] === 0x0C)) break;
    if (w.props.fontSize > max) max = w.props.fontSize;
    if (w.image && w.image.heightPt > max) max = w.image.heightPt;
  }
  return max;
}
