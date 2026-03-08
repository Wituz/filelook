import { parseXml, findChild, findChildren, attr } from './xml.ts';
import type {
  XmlNode, DocxDocument, DocxBlock, DocxParagraph, DocxTable, DocxTableRow,
  DocxTableCell, DocxRun, DocxStyle, DocxParagraphProps, DocxRunProps,
  DocxBorder, DocxBorderSet, DocxFloatingImage, DocxInlineImage,
} from './types.ts';
import { DEFAULT_PARA_PROPS, DEFAULT_RUN_PROPS } from './types.ts';

// Unit conversions
function twipsToPt(twips: number): number { return twips / 20; }
function emuToPt(emu: number): number { return emu / 12700; }
function halfPtToPt(hp: number): number { return hp / 2; }
function eighthPtToPt(ep: number): number { return ep / 8; }

function numAttr(node: XmlNode, name: string): number | null {
  const v = attr(node, name);
  if (v === null) return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

// Parse relationships from word/_rels/document.xml.rels
function parseRelationships(files: Map<string, Uint8Array>): Map<string, string> {
  const rels = new Map<string, string>();
  const data = files.get('word/_rels/document.xml.rels');
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

// Parse styles from word/styles.xml
function parseStyles(files: Map<string, Uint8Array>): { styles: Map<string, DocxStyle>; defaults: DocxParagraphProps; defaultRunProps: DocxRunProps } {
  const styles = new Map<string, DocxStyle>();
  let defaults = { ...DEFAULT_PARA_PROPS };
  let defaultRunProps = { ...DEFAULT_RUN_PROPS };

  const data = files.get('word/styles.xml');
  if (!data) return { styles, defaults, defaultRunProps };

  const xml = parseXml(new TextDecoder().decode(data));

  // Document defaults
  const docDefaults = findChild(xml, 'w', 'docDefaults');
  if (docDefaults) {
    const rPrDefault = findChild(docDefaults, 'w', 'rPrDefault');
    if (rPrDefault) {
      const rPr = findChild(rPrDefault, 'w', 'rPr');
      if (rPr) defaultRunProps = { ...defaultRunProps, ...parseRunProps(rPr) };
    }
    const pPrDefault = findChild(docDefaults, 'w', 'pPrDefault');
    if (pPrDefault) {
      const pPr = findChild(pPrDefault, 'w', 'pPr');
      if (pPr) defaults = { ...defaults, ...parseParagraphProps(pPr) };
    }
  }

  // Named styles
  for (const styleNode of findChildren(xml, 'w', 'style')) {
    const id = attr(styleNode, 'w:styleId');
    if (!id) continue;

    const basedOnNode = findChild(styleNode, 'w', 'basedOn');
    const basedOn = basedOnNode ? attr(basedOnNode, 'w:val') : null;

    const pPr = findChild(styleNode, 'w', 'pPr');
    const rPr = findChild(styleNode, 'w', 'rPr');

    styles.set(id, {
      id,
      basedOn,
      paragraphProps: pPr ? { ...DEFAULT_PARA_PROPS, ...parseParagraphProps(pPr) } : { ...DEFAULT_PARA_PROPS },
      runProps: rPr ? { ...DEFAULT_RUN_PROPS, ...parseRunProps(rPr) } : { ...DEFAULT_RUN_PROPS },
    });
  }

  return { styles, defaults, defaultRunProps };
}

function parseParagraphProps(pPr: XmlNode): Partial<DocxParagraphProps> {
  const props: Partial<DocxParagraphProps> = {};

  const jc = findChild(pPr, 'w', 'jc');
  if (jc) {
    const val = attr(jc, 'w:val');
    if (val === 'center') props.alignment = 'center';
    else if (val === 'right' || val === 'end') props.alignment = 'right';
    else if (val === 'both' || val === 'distribute') props.alignment = 'justify';
    else props.alignment = 'left';
  }

  const spacing = findChild(pPr, 'w', 'spacing');
  if (spacing) {
    const before = numAttr(spacing, 'w:before');
    if (before !== null) props.spaceBefore = twipsToPt(before);
    const after = numAttr(spacing, 'w:after');
    if (after !== null) props.spaceAfter = twipsToPt(after);
    const line = numAttr(spacing, 'w:line');
    const lineRule = attr(spacing, 'w:lineRule');
    if (line !== null) {
      if (lineRule === 'exact' || lineRule === 'atLeast') {
        props.lineSpacing = twipsToPt(line) / 12; // approximate as ratio
      } else {
        // Default: line/240 gives ratio
        props.lineSpacing = line / 240;
      }
    }
  }

  const ind = findChild(pPr, 'w', 'ind');
  if (ind) {
    const left = numAttr(ind, 'w:left') ?? numAttr(ind, 'w:start');
    if (left !== null) props.indentLeft = twipsToPt(left);
    const right = numAttr(ind, 'w:right') ?? numAttr(ind, 'w:end');
    if (right !== null) props.indentRight = twipsToPt(right);
    const fl = numAttr(ind, 'w:firstLine');
    if (fl !== null) props.indentFirstLine = twipsToPt(fl);
    const hanging = numAttr(ind, 'w:hanging');
    if (hanging !== null) props.indentFirstLine = -twipsToPt(hanging);
  }

  // Bullets/numbering
  const numPr = findChild(pPr, 'w', 'numPr');
  if (numPr) {
    const ilvl = findChild(numPr, 'w', 'ilvl');
    const level = ilvl ? (numAttr(ilvl, 'w:val') ?? 0) : 0;
    // We don't parse numbering.xml — just use bullets
    props.bullet = level === 0 ? '\u2022' : '\u2013';
  }

  // Paragraph border
  const pBdr = findChild(pPr, 'w', 'pBdr');
  if (pBdr) {
    const bottom = findChild(pBdr, 'w', 'bottom');
    if (bottom) {
      props.borderBottom = parseBorderNode(bottom);
    }
  }

  // Shading
  const shd = findChild(pPr, 'w', 'shd');
  if (shd) {
    const fill = attr(shd, 'w:fill');
    if (fill && fill !== 'auto') props.shading = fill;
  }

  // Style reference
  const pStyle = findChild(pPr, 'w', 'pStyle');
  if (pStyle) {
    props.styleId = attr(pStyle, 'w:val');
  }

  // Page break before
  const pageBreakBefore = findChild(pPr, 'w', 'pageBreakBefore');
  if (pageBreakBefore) {
    const val = attr(pageBreakBefore, 'w:val');
    props.pageBreakBefore = val !== '0' && val !== 'false';
  }

  return props;
}

function parseRunProps(rPr: XmlNode): Partial<DocxRunProps> {
  const props: Partial<DocxRunProps> = {};

  const sz = findChild(rPr, 'w', 'sz');
  if (sz) {
    const val = numAttr(sz, 'w:val');
    if (val !== null) props.fontSize = halfPtToPt(val);
  }

  const b = findChild(rPr, 'w', 'b');
  if (b) {
    const val = attr(b, 'w:val');
    props.bold = val !== '0' && val !== 'false';
  }

  const i = findChild(rPr, 'w', 'i');
  if (i) {
    const val = attr(i, 'w:val');
    props.italic = val !== '0' && val !== 'false';
  }

  const u = findChild(rPr, 'w', 'u');
  if (u) {
    const val = attr(u, 'w:val');
    props.underline = val !== 'none' && val !== null;
  }

  const color = findChild(rPr, 'w', 'color');
  if (color) {
    const val = attr(color, 'w:val');
    if (val && val !== 'auto') props.color = val;
  }

  const rStyle = findChild(rPr, 'w', 'rStyle');
  if (rStyle) {
    props.styleId = attr(rStyle, 'w:val');
  }

  return props;
}

function parseBorderNode(node: XmlNode): DocxBorder | null {
  const val = attr(node, 'w:val');
  if (!val || val === 'none' || val === 'nil') return null;
  const sz = numAttr(node, 'w:sz');
  const color = attr(node, 'w:color') ?? '000000';
  return { width: sz !== null ? eighthPtToPt(sz) : 0.5, color: color === 'auto' ? '000000' : color };
}

function parseBorderSet(node: XmlNode): DocxBorderSet {
  const bs: DocxBorderSet = { top: null, bottom: null, left: null, right: null, insideH: null, insideV: null };
  const top = findChild(node, 'w', 'top');
  if (top) bs.top = parseBorderNode(top);
  const bottom = findChild(node, 'w', 'bottom');
  if (bottom) bs.bottom = parseBorderNode(bottom);
  const left = findChild(node, 'w', 'left') ?? findChild(node, 'w', 'start');
  if (left) bs.left = parseBorderNode(left);
  const right = findChild(node, 'w', 'right') ?? findChild(node, 'w', 'end');
  if (right) bs.right = parseBorderNode(right);
  const insideH = findChild(node, 'w', 'insideH');
  if (insideH) bs.insideH = parseBorderNode(insideH);
  const insideV = findChild(node, 'w', 'insideV');
  if (insideV) bs.insideV = parseBorderNode(insideV);
  return bs;
}

// Parse body blocks
function parseBody(body: XmlNode, rels: Map<string, string>, floats: DocxFloatingImage[]): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  for (const child of body.children) {
    if (child.prefix === 'w' && child.tag === 'p') {
      blocks.push(parseParagraph(child, rels, floats));
    } else if (child.prefix === 'w' && child.tag === 'tbl') {
      blocks.push(parseTable(child, rels, floats));
    }
  }
  return blocks;
}

function parseParagraph(pNode: XmlNode, rels: Map<string, string>, floats: DocxFloatingImage[]): DocxParagraph {
  const pPr = findChild(pNode, 'w', 'pPr');
  const props: DocxParagraphProps = pPr
    ? { ...DEFAULT_PARA_PROPS, ...parseParagraphProps(pPr) }
    : { ...DEFAULT_PARA_PROPS };

  const runs: DocxRun[] = [];

  for (const child of pNode.children) {
    if (child.prefix === 'w' && child.tag === 'r') {
      const rPr = findChild(child, 'w', 'rPr');
      const runProps: DocxRunProps = rPr
        ? { ...DEFAULT_RUN_PROPS, ...parseRunProps(rPr) }
        : { ...DEFAULT_RUN_PROPS };

      for (const rChild of child.children) {
        if (rChild.prefix === 'w' && rChild.tag === 't') {
          runs.push({ type: 'text', text: rChild.text, props: runProps });
        } else if (rChild.prefix === 'w' && rChild.tag === 'br') {
          const brType = attr(rChild, 'w:type');
          if (brType === 'page') {
            runs.push({ type: 'break', text: '\f', props: runProps });
          } else {
            runs.push({ type: 'break', text: '\n', props: runProps });
          }
        } else if (rChild.prefix === 'w' && rChild.tag === 'tab') {
          runs.push({ type: 'tab', text: '\t', props: runProps });
        } else if (rChild.prefix === 'w' && rChild.tag === 'drawing') {
          parseDrawing(rChild, runProps, runs, rels, floats);
        }
      }
    } else if (child.prefix === 'w' && child.tag === 'hyperlink') {
      // Treat hyperlink children as normal runs
      for (const hChild of child.children) {
        if (hChild.prefix === 'w' && hChild.tag === 'r') {
          const rPr = findChild(hChild, 'w', 'rPr');
          const runProps: DocxRunProps = rPr
            ? { ...DEFAULT_RUN_PROPS, ...parseRunProps(rPr) }
            : { ...DEFAULT_RUN_PROPS };
          for (const rChild of hChild.children) {
            if (rChild.prefix === 'w' && rChild.tag === 't') {
              runs.push({ type: 'text', text: rChild.text, props: runProps });
            }
          }
        }
      }
    }
  }

  return { type: 'paragraph', props, runs };
}

function parseDrawing(drawing: XmlNode, runProps: DocxRunProps, runs: DocxRun[], rels: Map<string, string>, floats: DocxFloatingImage[]): void {
  // Look for wp:inline or wp:anchor
  const inline = findDeep(drawing, 'wp', 'inline');
  const anchor = findDeep(drawing, 'wp', 'anchor');

  if (inline) {
    const extent = findChild(inline, 'wp', 'extent');
    if (!extent) return;
    const cx = numAttr(extent, 'cx') ?? 0;
    const cy = numAttr(extent, 'cy') ?? 0;
    const rId = findBlipRId(inline);
    if (!rId) return;

    runs.push({
      type: 'image',
      text: '',
      props: runProps,
      image: { rId, widthPt: emuToPt(cx), heightPt: emuToPt(cy) },
    });
  }

  if (anchor) {
    const extent = findChild(anchor, 'wp', 'extent');
    if (!extent) return;
    const cx = numAttr(extent, 'cx') ?? 0;
    const cy = numAttr(extent, 'cy') ?? 0;
    const rId = findBlipRId(anchor);
    if (!rId) return;

    // Position
    const posH = findChild(anchor, 'wp', 'positionH');
    const posV = findChild(anchor, 'wp', 'positionV');
    const posOffsetH = posH ? findChild(posH, 'wp', 'posOffset') : null;
    const posOffsetV = posV ? findChild(posV, 'wp', 'posOffset') : null;
    const x = posOffsetH ? emuToPt(parseInt(posOffsetH.text, 10) || 0) : 0;
    const y = posOffsetV ? emuToPt(parseInt(posOffsetV.text, 10) || 0) : 0;

    // Wrap mode
    let wrapMode: DocxFloatingImage['wrapMode'] = 'square';
    if (findChild(anchor, 'wp', 'wrapSquare')) wrapMode = 'square';
    else if (findChild(anchor, 'wp', 'wrapTight')) wrapMode = 'tight';
    else if (findChild(anchor, 'wp', 'wrapTopAndBottom')) wrapMode = 'topAndBottom';
    else if (findChild(anchor, 'wp', 'wrapNone')) wrapMode = 'none';

    floats.push({ rId, widthPt: emuToPt(cx), heightPt: emuToPt(cy), x, y, wrapMode });
  }
}

function findBlipRId(node: XmlNode): string | null {
  // Recursively find a:blip and get r:embed
  for (const child of node.children) {
    if (child.prefix === 'a' && child.tag === 'blip') {
      return attr(child, 'r:embed') ?? attr(child, 'r:link') ?? null;
    }
    const found = findBlipRId(child);
    if (found) return found;
  }
  return null;
}

function findDeep(node: XmlNode, prefix: string, tag: string): XmlNode | null {
  for (const child of node.children) {
    if (child.prefix === prefix && child.tag === tag) return child;
    const found = findDeep(child, prefix, tag);
    if (found) return found;
  }
  return null;
}

function parseTable(tblNode: XmlNode, rels: Map<string, string>, floats: DocxFloatingImage[]): DocxTable {
  // Column widths from w:tblGrid
  const columnWidths: number[] = [];
  const tblGrid = findChild(tblNode, 'w', 'tblGrid');
  if (tblGrid) {
    for (const col of findChildren(tblGrid, 'w', 'gridCol')) {
      const w = numAttr(col, 'w:w');
      columnWidths.push(w !== null ? twipsToPt(w) : 72);
    }
  }

  // Table borders
  const tblPr = findChild(tblNode, 'w', 'tblPr');
  let borders: DocxBorderSet = { top: null, bottom: null, left: null, right: null, insideH: null, insideV: null };
  if (tblPr) {
    const tblBorders = findChild(tblPr, 'w', 'tblBorders');
    if (tblBorders) borders = parseBorderSet(tblBorders);
  }

  // Rows
  const rows: DocxTableRow[] = [];
  for (const trNode of findChildren(tblNode, 'w', 'tr')) {
    const trPr = findChild(trNode, 'w', 'trPr');
    let height = 0;
    if (trPr) {
      const trHeight = findChild(trPr, 'w', 'trHeight');
      if (trHeight) {
        const val = numAttr(trHeight, 'w:val');
        if (val !== null) height = twipsToPt(val);
      }
    }

    const cells: DocxTableCell[] = [];
    for (const tcNode of findChildren(trNode, 'w', 'tc')) {
      const tcPr = findChild(tcNode, 'w', 'tcPr');
      let columnSpan = 1;
      let shading: string | null = null;

      if (tcPr) {
        const gridSpan = findChild(tcPr, 'w', 'gridSpan');
        if (gridSpan) {
          const val = numAttr(gridSpan, 'w:val');
          if (val !== null) columnSpan = val;
        }
        const shd = findChild(tcPr, 'w', 'shd');
        if (shd) {
          const fill = attr(shd, 'w:fill');
          if (fill && fill !== 'auto') shading = fill;
        }
      }

      const blocks = parseBody(tcNode, rels, floats);
      cells.push({ blocks, columnSpan, shading });
    }

    rows.push({ cells, height });
  }

  return { type: 'table', rows, columnWidths, borders };
}

// Extract embedded images
function extractImages(files: Map<string, Uint8Array>, rels: Map<string, string>): Map<string, Uint8Array> {
  const images = new Map<string, Uint8Array>();
  for (const [rId, target] of rels) {
    if (!target.startsWith('media/') && !target.includes('/media/')) continue;
    const path = target.startsWith('/') ? target.slice(1) : `word/${target}`;
    const data = files.get(path);
    if (data) images.set(rId, data);
  }
  return images;
}

export function parseDocxModel(files: Map<string, Uint8Array>): { doc: DocxDocument; floats: DocxFloatingImage[] } {
  const docXml = files.get('word/document.xml');
  if (!docXml) throw new Error('Invalid DOCX: missing document.xml');

  const root = parseXml(new TextDecoder().decode(docXml));
  const bodyNode = findChild(root, 'w', 'body');
  if (!bodyNode) throw new Error('Invalid DOCX: missing body element');

  const rels = parseRelationships(files);
  const { styles, defaults, defaultRunProps } = parseStyles(files);
  const images = extractImages(files, rels);

  // Page layout from sectPr
  let pageWidth = 612; // US Letter default
  let pageHeight = 792;
  let marginTop = 72;
  let marginBottom = 72;
  let marginLeft = 72;
  let marginRight = 72;

  const sectPr = findChild(bodyNode, 'w', 'sectPr');
  if (sectPr) {
    const pgSz = findChild(sectPr, 'w', 'pgSz');
    if (pgSz) {
      const w = numAttr(pgSz, 'w:w');
      const h = numAttr(pgSz, 'w:h');
      if (w !== null) pageWidth = twipsToPt(w);
      if (h !== null) pageHeight = twipsToPt(h);
    }
    const pgMar = findChild(sectPr, 'w', 'pgMar');
    if (pgMar) {
      const t = numAttr(pgMar, 'w:top');
      const b = numAttr(pgMar, 'w:bottom');
      const l = numAttr(pgMar, 'w:left');
      const r = numAttr(pgMar, 'w:right');
      if (t !== null) marginTop = twipsToPt(t);
      if (b !== null) marginBottom = twipsToPt(b);
      if (l !== null) marginLeft = twipsToPt(l);
      if (r !== null) marginRight = twipsToPt(r);
    }
  }

  const floats: DocxFloatingImage[] = [];
  const body = parseBody(bodyNode, rels, floats);

  return {
    doc: {
      body, styles, defaults, defaultRunProps, relationships: rels, images,
      pageWidth, pageHeight, marginTop, marginBottom, marginLeft, marginRight,
    },
    floats,
  };
}

// Resolve effective paragraph properties through style chain
export function resolveParaProps(props: DocxParagraphProps, styles: Map<string, DocxStyle>, defaults: DocxParagraphProps): DocxParagraphProps {
  const chain = buildStyleChain(props.styleId, styles, 10);
  let result = { ...defaults };
  for (const style of chain) {
    result = mergeParaProps(result, style.paragraphProps);
  }
  result = mergeParaProps(result, props);
  return result;
}

export function resolveRunProps(props: DocxRunProps, paraStyleId: string | null, styles: Map<string, DocxStyle>, defaults: DocxRunProps): DocxRunProps {
  // Start from defaults, layer paragraph style run props, then run style, then direct
  let result = { ...defaults };

  // Paragraph style's run props
  const paraChain = buildStyleChain(paraStyleId, styles, 10);
  for (const style of paraChain) {
    result = mergeRunProps(result, style.runProps);
  }

  // Run's own style chain
  const runChain = buildStyleChain(props.styleId, styles, 10);
  for (const style of runChain) {
    result = mergeRunProps(result, style.runProps);
  }

  // Direct formatting
  result = mergeRunProps(result, props);
  return result;
}

function buildStyleChain(styleId: string | null, styles: Map<string, DocxStyle>, maxDepth: number): DocxStyle[] {
  const chain: DocxStyle[] = [];
  let current = styleId;
  let depth = 0;
  while (current && depth < maxDepth) {
    const style = styles.get(current);
    if (!style) break;
    chain.unshift(style); // parent first
    current = style.basedOn;
    depth++;
  }
  return chain;
}

function mergeParaProps(base: DocxParagraphProps, over: Partial<DocxParagraphProps>): DocxParagraphProps {
  return {
    alignment: over.alignment ?? base.alignment,
    spaceBefore: over.spaceBefore ?? base.spaceBefore,
    spaceAfter: over.spaceAfter ?? base.spaceAfter,
    lineSpacing: over.lineSpacing ?? base.lineSpacing,
    indentLeft: over.indentLeft ?? base.indentLeft,
    indentRight: over.indentRight ?? base.indentRight,
    indentFirstLine: over.indentFirstLine ?? base.indentFirstLine,
    bullet: over.bullet ?? base.bullet,
    borderBottom: over.borderBottom !== undefined ? over.borderBottom : base.borderBottom,
    shading: over.shading !== undefined ? over.shading : base.shading,
    styleId: over.styleId ?? base.styleId,
    pageBreakBefore: over.pageBreakBefore ?? base.pageBreakBefore,
  };
}

function mergeRunProps(base: DocxRunProps, over: Partial<DocxRunProps>): DocxRunProps {
  return {
    fontSize: over.fontSize ?? base.fontSize,
    bold: over.bold ?? base.bold,
    italic: over.italic ?? base.italic,
    underline: over.underline ?? base.underline,
    color: over.color !== undefined ? over.color : base.color,
    styleId: over.styleId ?? base.styleId,
  };
}
