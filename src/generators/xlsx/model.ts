import { parseXml, findChild, findChildren, attr } from '../docx/xml.ts';
import type { XmlNode } from '../docx/types.ts';
import type {
  XlsxWorkbook, XlsxSheet, XlsxColumn, XlsxRow, XlsxCell,
  XlsxMergeCell, XlsxStyles, XlsxFont, XlsxFill, XlsxBorder,
  XlsxBorderEdge, XlsxCellXf, XlsxAlignment, XlsxTheme,
  XlsxDrawing, XlsxChartRef,
} from './types.ts';

// SpreadsheetML theme indices differ from DrawingML: dk/lt pairs are swapped
const SCHEME_MAP: Record<number, string> = {
  0: 'lt1', 1: 'dk1', 2: 'lt2', 3: 'dk2',
  4: 'accent1', 5: 'accent2', 6: 'accent3', 7: 'accent4',
  8: 'accent5', 9: 'accent6',
};

const INDEXED_COLORS: string[] = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];

function loadXml(files: Map<string, Uint8Array>, path: string): XmlNode | null {
  const data = files.get(path);
  if (!data) return null;
  return parseXml(new TextDecoder().decode(data));
}

function numAttr(node: XmlNode, name: string): number | null {
  const v = attr(node, name);
  if (v === null) return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function intAttr(node: XmlNode, name: string): number | null {
  const v = attr(node, name);
  if (v === null) return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

function parseRels(files: Map<string, Uint8Array>, relsPath: string): Map<string, string> {
  const rels = new Map<string, string>();
  const data = files.get(relsPath);
  if (!data) return rels;
  const xml = parseXml(new TextDecoder().decode(data));
  for (const child of xml.children) {
    if (child.tag === 'Relationship') {
      const id = attr(child, 'Id');
      const target = attr(child, 'Target');
      if (id && target) rels.set(id, target);
    }
  }
  return rels;
}

function relsPath(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/');
  if (lastSlash < 0) return '_rels/' + filePath + '.rels';
  return filePath.slice(0, lastSlash + 1) + '_rels/' + filePath.slice(lastSlash + 1) + '.rels';
}

function normalizePath(basePath: string, relative: string): string {
  if (relative.startsWith('/')) return relative.slice(1);
  const parts = basePath.split('/');
  parts.pop();
  for (const seg of relative.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function emuToPt(emu: number): number { return emu / 12700; }

// --- Theme ---

function parseTheme(files: Map<string, Uint8Array>, themePath: string): XlsxTheme {
  const colors = new Map<string, string>();
  const data = files.get(themePath);
  if (!data) return { colors };
  const xml = parseXml(new TextDecoder().decode(data));
  const themeElements = findChild(xml, 'a', 'themeElements');
  if (!themeElements) return { colors };
  const clrScheme = findChild(themeElements, 'a', 'clrScheme');
  if (!clrScheme) return { colors };

  for (const child of clrScheme.children) {
    if (child.prefix !== 'a') continue;
    const name = child.tag;
    const srgb = findChild(child, 'a', 'srgbClr');
    if (srgb) {
      const val = attr(srgb, 'val');
      if (val) colors.set(name, val);
      continue;
    }
    const sys = findChild(child, 'a', 'sysClr');
    if (sys) {
      const val = attr(sys, 'lastClr') ?? attr(sys, 'val');
      if (val) colors.set(name, val);
    }
  }
  return { colors };
}

export function resolveThemeColor(themeIdx: number, tint: number | null, theme: XlsxTheme): string | null {
  const name = SCHEME_MAP[themeIdx];
  if (!name) return null;
  const hex = theme.colors.get(name) ?? null;
  if (!hex || tint === null || tint === 0) return hex;
  return applyTint(hex, tint);
}

function applyTint(hex: string, tint: number): string {
  let r = parseInt(hex.slice(0, 2), 16);
  let g = parseInt(hex.slice(2, 4), 16);
  let b = parseInt(hex.slice(4, 6), 16);
  if (tint > 0) {
    r = Math.round(r + (255 - r) * tint);
    g = Math.round(g + (255 - g) * tint);
    b = Math.round(b + (255 - b) * tint);
  } else {
    r = Math.round(r * (1 + tint));
    g = Math.round(g * (1 + tint));
    b = Math.round(b * (1 + tint));
  }
  return toHex(r) + toHex(g) + toHex(b);
}

function toHex(n: number): string {
  const h = Math.max(0, Math.min(255, n)).toString(16);
  return h.length < 2 ? '0' + h : h;
}

function resolveColorNode(node: XmlNode | null, theme: XlsxTheme): string | null {
  if (!node) return null;
  const rgb = attr(node, 'rgb');
  if (rgb) return rgb.length >= 8 ? rgb.slice(2) : rgb;
  const themeStr = attr(node, 'theme');
  if (themeStr !== null) {
    const themeIdx = parseInt(themeStr, 10);
    const tintStr = attr(node, 'tint');
    const tint = tintStr !== null ? parseFloat(tintStr) : null;
    return resolveThemeColor(themeIdx, tint, theme);
  }
  const indexed = attr(node, 'indexed');
  if (indexed !== null) {
    const idx = parseInt(indexed, 10);
    if (idx >= 0 && idx < INDEXED_COLORS.length) return INDEXED_COLORS[idx];
  }
  return null;
}

// --- Shared Strings ---

function parseSharedStrings(files: Map<string, Uint8Array>): string[] {
  const xml = loadXml(files, 'xl/sharedStrings.xml');
  if (!xml) return [];
  const strings: string[] = [];
  for (const si of findChildren(xml, '', 'si')) {
    const t = findChild(si, '', 't');
    if (t) {
      strings.push(t.text);
      continue;
    }
    // Rich text: concatenate all <r><t>...</t></r>
    let text = '';
    for (const r of findChildren(si, '', 'r')) {
      const rt = findChild(r, '', 't');
      if (rt) text += rt.text;
    }
    strings.push(text);
  }
  return strings;
}

// --- Styles ---

function parseStyles(files: Map<string, Uint8Array>, theme: XlsxTheme): XlsxStyles {
  const xml = loadXml(files, 'xl/styles.xml');
  const fonts: XlsxFont[] = [];
  const fills: XlsxFill[] = [];
  const borders: XlsxBorder[] = [];
  const cellXfs: XlsxCellXf[] = [];
  const numFmts = new Map<number, string>();

  if (!xml) return { fonts, fills, borders, cellXfs, numFmts };

  // Number formats
  const numFmtsNode = findChild(xml, '', 'numFmts');
  if (numFmtsNode) {
    for (const nf of findChildren(numFmtsNode, '', 'numFmt')) {
      const id = intAttr(nf, 'numFmtId');
      const code = attr(nf, 'formatCode');
      if (id !== null && code) numFmts.set(id, code);
    }
  }

  // Fonts
  const fontsNode = findChild(xml, '', 'fonts');
  if (fontsNode) {
    for (const f of findChildren(fontsNode, '', 'font')) {
      const sz = findChild(f, '', 'sz');
      const b = findChild(f, '', 'b');
      const i = findChild(f, '', 'i');
      const color = findChild(f, '', 'color');
      fonts.push({
        size: sz ? (numAttr(sz, 'val') ?? 11) : 11,
        bold: b !== null,
        italic: i !== null,
        color: resolveColorNode(color, theme),
      });
    }
  }

  // Fills
  const fillsNode = findChild(xml, '', 'fills');
  if (fillsNode) {
    for (const f of findChildren(fillsNode, '', 'fill')) {
      const patternFill = findChild(f, '', 'patternFill');
      if (patternFill) {
        const patternType = attr(patternFill, 'patternType') ?? 'none';
        const fgColorNode = findChild(patternFill, '', 'fgColor');
        fills.push({
          fgColor: resolveColorNode(fgColorNode, theme),
          patternType,
        });
      } else {
        fills.push({ fgColor: null, patternType: 'none' });
      }
    }
  }

  // Borders
  const bordersNode = findChild(xml, '', 'borders');
  if (bordersNode) {
    for (const b of findChildren(bordersNode, '', 'border')) {
      borders.push({
        left: parseBorderEdge(findChild(b, '', 'left'), theme),
        right: parseBorderEdge(findChild(b, '', 'right'), theme),
        top: parseBorderEdge(findChild(b, '', 'top'), theme),
        bottom: parseBorderEdge(findChild(b, '', 'bottom'), theme),
      });
    }
  }

  // Cell XFs
  const cellXfsNode = findChild(xml, '', 'cellXfs');
  if (cellXfsNode) {
    for (const xf of findChildren(cellXfsNode, '', 'xf')) {
      const alignNode = findChild(xf, '', 'alignment');
      const alignment: XlsxAlignment = {
        horizontal: alignNode ? (attr(alignNode, 'horizontal') ?? 'general') : 'general',
        vertical: alignNode ? (attr(alignNode, 'vertical') ?? 'bottom') : 'bottom',
        wrapText: alignNode ? (attr(alignNode, 'wrapText') === '1') : false,
      };
      cellXfs.push({
        fontId: intAttr(xf, 'fontId') ?? 0,
        fillId: intAttr(xf, 'fillId') ?? 0,
        borderId: intAttr(xf, 'borderId') ?? 0,
        numFmtId: intAttr(xf, 'numFmtId') ?? 0,
        alignment,
      });
    }
  }

  return { fonts, fills, borders, cellXfs, numFmts };
}

function parseBorderEdge(node: XmlNode | null, theme: XlsxTheme): XlsxBorderEdge | null {
  if (!node) return null;
  const style = attr(node, 'style');
  if (!style || style === 'none') return null;
  const colorNode = findChild(node, '', 'color');
  return { style, color: resolveColorNode(colorNode, theme) };
}

// --- Cell reference parsing ---

function colFromRef(ref: string): number {
  let col = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) {
      col = col * 26 + (c - 64);
    } else break;
  }
  return col - 1; // 0-based
}

function rowFromRef(ref: string): number {
  let num = '';
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 48 && c <= 57) num += ref[i];
  }
  return parseInt(num, 10) - 1; // 0-based
}

function parseCellRef(ref: string): { col: number; row: number } {
  return { col: colFromRef(ref), row: rowFromRef(ref) };
}

// --- Sheet parsing ---

function parseSheet(xml: XmlNode): XlsxSheet {
  const worksheet = xml;
  const columns: XlsxColumn[] = [];
  const rows: XlsxRow[] = [];
  const mergeCells: XlsxMergeCell[] = [];
  let defaultRowHeight = 15;
  let defaultColWidth = 8.43;
  let showGridLines = true;

  // Sheet format defaults
  const sheetFormatPr = findChild(worksheet, '', 'sheetFormatPr');
  if (sheetFormatPr) {
    const rh = numAttr(sheetFormatPr, 'defaultRowHeight');
    if (rh !== null) defaultRowHeight = rh;
    const cw = numAttr(sheetFormatPr, 'defaultColWidth');
    if (cw !== null) defaultColWidth = cw;
  }

  // Sheet views — grid lines
  const sheetViews = findChild(worksheet, '', 'sheetViews');
  if (sheetViews) {
    const sv = findChild(sheetViews, '', 'sheetView');
    if (sv) {
      const gl = attr(sv, 'showGridLines');
      if (gl === '0') showGridLines = false;
    }
  }

  // Columns
  const cols = findChild(worksheet, '', 'cols');
  if (cols) {
    for (const col of findChildren(cols, '', 'col')) {
      const min = intAttr(col, 'min');
      const max = intAttr(col, 'max');
      const width = numAttr(col, 'width');
      const hidden = attr(col, 'hidden') === '1';
      if (min !== null && max !== null) {
        columns.push({
          min: min - 1, // 0-based
          max: max - 1,
          widthChars: width ?? defaultColWidth,
          hidden,
        });
      }
    }
  }

  // Rows + cells
  const sheetData = findChild(worksheet, '', 'sheetData');
  if (sheetData) {
    for (const rowNode of findChildren(sheetData, '', 'row')) {
      const rIdx = intAttr(rowNode, 'r');
      if (rIdx === null) continue;
      const ht = numAttr(rowNode, 'ht');
      const hidden = attr(rowNode, 'hidden') === '1';
      const cells: XlsxCell[] = [];

      for (const cellNode of findChildren(rowNode, '', 'c')) {
        const ref = attr(cellNode, 'r');
        if (!ref) continue;
        const { col, row } = parseCellRef(ref);
        const t = attr(cellNode, 't') ?? '';
        const s = intAttr(cellNode, 's') ?? 0;
        const vNode = findChild(cellNode, '', 'v');
        let value = vNode ? vNode.text : '';

        // Inline string
        if (t === 'inlineStr') {
          const is = findChild(cellNode, '', 'is');
          if (is) {
            const tNode = findChild(is, '', 't');
            if (tNode) value = tNode.text;
          }
        }

        cells.push({ ref, col, row, value, styleIndex: s, type: t });
      }

      rows.push({
        index: rIdx - 1,
        height: ht ?? defaultRowHeight,
        cells,
        hidden,
      });
    }
  }

  // Merge cells
  const mergeCellsNode = findChild(worksheet, '', 'mergeCells');
  if (mergeCellsNode) {
    for (const mc of findChildren(mergeCellsNode, '', 'mergeCell')) {
      const ref = attr(mc, 'ref');
      if (!ref) continue;
      const parts = ref.split(':');
      if (parts.length !== 2) continue;
      const start = parseCellRef(parts[0]);
      const end = parseCellRef(parts[1]);
      mergeCells.push({
        startCol: start.col,
        startRow: start.row,
        endCol: end.col,
        endRow: end.row,
      });
    }
  }

  return {
    name: '',
    columns,
    rows,
    mergeCells,
    defaultRowHeight,
    defaultColWidth,
    drawings: [],
    showGridLines,
  };
}

// --- Drawing parsing ---

function parseDrawings(
  files: Map<string, Uint8Array>, drawingPath: string,
): { drawings: XlsxDrawing[]; chartRefs: { rId: string; drawing: XlsxDrawing }[] } {
  const xml = loadXml(files, drawingPath);
  if (!xml) return { drawings: [], chartRefs: [] };

  const drawings: XlsxDrawing[] = [];
  const chartRefs: { rId: string; drawing: XlsxDrawing }[] = [];
  const drawingRels = parseRels(files, relsPath(drawingPath));

  for (const anchor of findChildren(xml, 'xdr', 'twoCellAnchor')) {
    const from = findChild(anchor, 'xdr', 'from');
    const to = findChild(anchor, 'xdr', 'to');
    if (!from || !to) continue;

    const fromCol = intAttr(findChild(from, 'xdr', 'col')!, 'dummy') ?? parseInt(findChild(from, 'xdr', 'col')?.text ?? '0', 10);
    const fromRow = intAttr(findChild(from, 'xdr', 'row')!, 'dummy') ?? parseInt(findChild(from, 'xdr', 'row')?.text ?? '0', 10);
    const fromColOff = parseInt(findChild(from, 'xdr', 'colOff')?.text ?? '0', 10);
    const fromRowOff = parseInt(findChild(from, 'xdr', 'rowOff')?.text ?? '0', 10);
    const toCol = intAttr(findChild(to, 'xdr', 'col')!, 'dummy') ?? parseInt(findChild(to, 'xdr', 'col')?.text ?? '0', 10);
    const toRow = intAttr(findChild(to, 'xdr', 'row')!, 'dummy') ?? parseInt(findChild(to, 'xdr', 'row')?.text ?? '0', 10);
    const toColOff = parseInt(findChild(to, 'xdr', 'colOff')?.text ?? '0', 10);
    const toRowOff = parseInt(findChild(to, 'xdr', 'rowOff')?.text ?? '0', 10);

    // Check for chart
    const graphicFrame = findChild(anchor, 'xdr', 'graphicFrame');
    if (graphicFrame) {
      const graphic = findChild(graphicFrame, 'a', 'graphic');
      if (graphic) {
        const graphicData = findChild(graphic, 'a', 'graphicData');
        if (graphicData) {
          const chart = findChild(graphicData, 'c', 'chart');
          if (chart) {
            const rId = attr(chart, 'r:id');
            if (rId) {
              const drawing: XlsxDrawing = {
                type: 'chart', fromCol, fromRow, fromColOff, fromRowOff,
                toCol, toRow, toColOff, toRowOff, rId,
              };
              drawings.push(drawing);
              chartRefs.push({ rId, drawing });
              continue;
            }
          }
        }
      }
    }

    // Check for picture
    const pic = findChild(anchor, 'xdr', 'pic');
    if (pic) {
      const blipFill = findChild(pic, 'xdr', 'blipFill');
      if (blipFill) {
        const blip = findChild(blipFill, 'a', 'blip');
        if (blip) {
          const rId = attr(blip, 'r:embed');
          if (rId) {
            drawings.push({
              type: 'image', fromCol, fromRow, fromColOff, fromRowOff,
              toCol, toRow, toColOff, toRowOff, rId,
            });
          }
        }
      }
    }
  }

  // Resolve chart rIds to actual file paths
  const resolvedCharts: { rId: string; drawing: XlsxDrawing }[] = [];
  for (const cr of chartRefs) {
    const target = drawingRels.get(cr.rId);
    if (target) {
      const chartPath = normalizePath(drawingPath, target);
      resolvedCharts.push({ rId: chartPath, drawing: cr.drawing });
    }
  }

  return { drawings, chartRefs: resolvedCharts };
}

// --- Main parser ---

export function parseXlsxModel(files: Map<string, Uint8Array>): XlsxWorkbook {
  // 1. Workbook
  const wbXml = loadXml(files, 'xl/workbook.xml');
  if (!wbXml) throw new Error('Invalid XLSX: missing workbook.xml');

  const wbRels = parseRels(files, 'xl/_rels/workbook.xml.rels');

  // 2. Theme
  let theme: XlsxTheme = { colors: new Map() };
  for (const [, target] of wbRels) {
    if (target.includes('theme')) {
      const themePath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
      theme = parseTheme(files, themePath);
      break;
    }
  }

  // 3. Shared strings
  const sharedStrings = parseSharedStrings(files);

  // 4. Styles
  const styles = parseStyles(files, theme);

  // 5. Parse sheets
  const sheets: XlsxSheet[] = [];
  const sheetNodes = findChild(wbXml, '', 'sheets');
  if (sheetNodes) {
    for (const sn of findChildren(sheetNodes, '', 'sheet')) {
      const name = attr(sn, 'name') ?? '';
      const rId = attr(sn, 'r:id');
      if (!rId) continue;
      const target = wbRels.get(rId);
      if (!target) continue;
      const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
      const sheetXml = loadXml(files, sheetPath);
      if (!sheetXml) continue;

      const sheet = parseSheet(sheetXml);
      sheet.name = name;

      // Parse drawings for this sheet
      const sheetRels = parseRels(files, relsPath(sheetPath));
      for (const [, relTarget] of sheetRels) {
        if (relTarget.includes('drawing')) {
          const drawingPath = normalizePath(sheetPath, relTarget);
          const { drawings, chartRefs } = parseDrawings(files, drawingPath);
          sheet.drawings = drawings;

          // Load images from drawing rels
          const drawRels = parseRels(files, relsPath(drawingPath));
          const images = new Map<string, Uint8Array>();
          for (const d of drawings) {
            if (d.type === 'image') {
              const imgTarget = drawRels.get(d.rId);
              if (imgTarget) {
                const imgPath = normalizePath(drawingPath, imgTarget);
                const imgData = files.get(imgPath);
                if (imgData) images.set(d.rId, imgData);
              }
            }
          }

          // Only parse first sheet, so store charts + images here
          const chartsList: XlsxChartRef[] = chartRefs.map((cr, idx) => ({
            drawingIndex: idx,
            chartPath: cr.rId,
            drawing: cr.drawing,
          }));

          sheets.push(sheet);
          return { sheets, sharedStrings, styles, theme, images, charts: chartsList };
        }
      }

      sheets.push(sheet);
      break; // Only first sheet
    }
  }

  return { sheets, sharedStrings, styles, theme, images: new Map(), charts: [] };
}
